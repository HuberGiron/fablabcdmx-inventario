// Ajustes de presentación del módulo de Presupuestos.
// 1) El resumen superior respeta la Zona seleccionada.
// 2) Zonas, subzonas y áreas siguen el orden/código público de la estructura objetivo.
// 3) El Excel de Presupuestos conserva ese mismo orden visual.

const BUDGET_PANEL_ID = "purchaseBudgetsPanel";
const BUDGET_BODY_ID = "purchaseBudgetsPanelBody";

let budgetPanelObserver = null;
let attachingObserver = null;
let patchScheduled = false;
let patching = false;

function displayMeta(rawCode, rawName) {
  const code = String(rawCode ?? "").trim();
  const name = String(rawName ?? "").trim();
  const match = name.match(/^(\d+(?:\.\d+)*)(?:\.)?\s+(.+)$/);
  if (match) {
    return {
      code: match[1],
      name: match[2].trim(),
      aliased: match[1] !== code,
    };
  }
  return { code, name, aliased: false };
}

function compareCodes(left, right) {
  const a = String(left || "").split(".").map(part => Number(part));
  const b = String(right || "").split(".").map(part => Number(part));
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const av = Number.isFinite(a[i]) ? a[i] : -1;
    const bv = Number.isFinite(b[i]) ? b[i] : -1;
    if (av !== bv) return av - bv;
  }
  return String(left || "").localeCompare(String(right || ""), "es", {
    numeric: true,
    sensitivity: "base",
  });
}

function splitOptionLabel(text) {
  const value = String(text || "").trim();
  const dot = value.indexOf("·");
  if (dot < 0) return { rawCode: "", name: value };
  return {
    rawCode: value.slice(0, dot).trim(),
    name: value.slice(dot + 1).trim(),
  };
}

function metaForOption(option, kind, subzoneMap = new Map()) {
  if (!option || option.value === "all") return null;

  if (option.dataset.displayCode) {
    return {
      code: option.dataset.displayCode,
      name: option.dataset.displayName || "",
      aliased: option.dataset.displayCode !== String(option.value),
    };
  }

  const rawCode = String(option.value || "").trim();
  const parsedLabel = splitOptionLabel(option.textContent);
  let meta = displayMeta(rawCode, parsedLabel.name);

  if (kind === "area" && !meta.aliased && rawCode) {
    const candidates = [...subzoneMap.entries()]
      .filter(([technical]) => rawCode === technical || rawCode.startsWith(`${technical}.`))
      .sort((a, b) => b[0].length - a[0].length);

    const match = candidates[0];
    if (match) {
      const [technicalSubzone, subzoneMeta] = match;
      if (subzoneMeta?.code && subzoneMeta.code !== technicalSubzone) {
        meta = {
          ...meta,
          code: `${subzoneMeta.code}${rawCode.slice(technicalSubzone.length)}`,
          aliased: true,
        };
      }
    }
  }

  option.dataset.displayCode = meta.code;
  option.dataset.displayName = meta.name;
  return meta;
}

function normalizeSelect(selector, kind, subzoneMap = new Map()) {
  const select = document.querySelector(selector);
  if (!select) return new Map();

  const allOption = [...select.options].find(option => option.value === "all") || null;
  const entries = [...select.options]
    .filter(option => option.value !== "all")
    .map(option => ({ option, meta: metaForOption(option, kind, subzoneMap) }))
    .filter(entry => entry.meta);

  entries.sort((a, b) =>
    compareCodes(a.meta.code, b.meta.code) ||
    String(a.meta.name || "").localeCompare(String(b.meta.name || ""), "es", { sensitivity: "base" })
  );

  if (allOption) select.appendChild(allOption);
  for (const { option, meta } of entries) {
    option.textContent = `${meta.code} · ${meta.name}`;
    select.appendChild(option);
  }

  const map = new Map();
  for (const { option, meta } of entries) map.set(String(option.value), meta);
  return map;
}

function parseMoney(text) {
  const cleaned = String(text || "")
    .replace(/[^0-9.,-]/g, "")
    .replace(/,/g, "");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : 0;
}

function money(value) {
  return `${new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0)} MXN`;
}

function allocationRows(zoneMap) {
  const table = document.querySelector(".purchase-budget-zone-table");
  if (!table) return [];

  const rows = [...table.querySelectorAll("tbody tr")];
  const parsed = rows.map(row => {
    const cells = row.querySelectorAll("td");
    const input = row.querySelector(".purchase-budget-zone-input");
    let rawZoneId = String(input?.dataset?.zoneId || row.dataset.rawZoneId || "").trim();
    let rawName = "";

    if (!rawZoneId && cells[0]) {
      const parts = splitOptionLabel(cells[0].textContent);
      rawZoneId = parts.rawCode;
      rawName = parts.name;
    } else if (cells[0]) {
      const parts = splitOptionLabel(cells[0].textContent);
      rawName = parts.name;
    }

    row.dataset.rawZoneId = rawZoneId;
    const meta = zoneMap.get(rawZoneId) || displayMeta(rawZoneId, rawName);
    row.dataset.displayCode = meta.code;
    row.dataset.displayName = meta.name;

    if (cells[0]) {
      cells[0].innerHTML = "";
      const strong = document.createElement("strong");
      strong.textContent = meta.code;
      cells[0].appendChild(strong);
      cells[0].append(` · ${meta.name}`);
    }

    const allocated = input ? Number(input.value || 0) : parseMoney(cells[1]?.textContent);
    const committed = parseMoney(cells[2]?.textContent);
    const spent = parseMoney(cells[3]?.textContent);

    return {
      row,
      rawZoneId,
      code: meta.code,
      name: meta.name,
      allocated: Number.isFinite(allocated) ? allocated : 0,
      committed,
      spent,
    };
  });

  parsed.sort((a, b) => compareCodes(a.code, b.code) || String(a.name).localeCompare(String(b.name), "es"));
  const tbody = table.querySelector("tbody");
  if (tbody) parsed.forEach(entry => tbody.appendChild(entry.row));
  return parsed;
}

function patchReportRows(zoneMap, subzoneMap, areaMap) {
  const table = document.querySelector(".purchase-budget-report-table");
  if (!table) return [];

  const rows = [...table.querySelectorAll("tbody tr")].map(row => {
    const cells = row.querySelectorAll("td");
    if (cells.length < 7) return null;

    const zoneParts = splitOptionLabel(cells[0].textContent);
    const subzoneParts = splitOptionLabel(cells[1].textContent);

    let rawZoneId = row.dataset.rawZoneId || zoneParts.rawCode;
    let rawSubzoneId = row.dataset.rawSubzoneId || subzoneParts.rawCode;
    let rawAreaId = row.dataset.rawAreaId || "";
    let rawAreaName = row.dataset.rawAreaName || "";

    if (!rawAreaId) {
      const areaText = String(cells[2].textContent || "").trim();
      const areaDot = splitOptionLabel(areaText);
      if (areaDot.rawCode) {
        rawAreaId = areaDot.rawCode;
        rawAreaName = areaDot.name;
      } else {
        const firstSpace = areaText.indexOf(" ");
        rawAreaId = firstSpace >= 0 ? areaText.slice(0, firstSpace).trim() : areaText;
        rawAreaName = firstSpace >= 0 ? areaText.slice(firstSpace + 1).trim() : "";
      }
    }

    row.dataset.rawZoneId = rawZoneId;
    row.dataset.rawSubzoneId = rawSubzoneId;
    row.dataset.rawAreaId = rawAreaId;
    row.dataset.rawAreaName = rawAreaName;

    const zoneMeta = zoneMap.get(rawZoneId) || displayMeta(rawZoneId, zoneParts.name);
    const subzoneMeta = subzoneMap.get(rawSubzoneId) || displayMeta(rawSubzoneId, subzoneParts.name);
    const areaMeta = areaMap.get(rawAreaId) || displayMeta(rawAreaId, rawAreaName);

    cells[0].textContent = `${zoneMeta.code} · ${zoneMeta.name}`;
    cells[1].textContent = `${subzoneMeta.code} · ${subzoneMeta.name}`;
    cells[2].textContent = `${areaMeta.code} · ${areaMeta.name}`;

    return {
      row,
      zoneCode: zoneMeta.code,
      subzoneCode: subzoneMeta.code,
      areaCode: areaMeta.code,
      zoneName: zoneMeta.name,
      subzoneName: subzoneMeta.name,
      areaName: areaMeta.name,
    };
  }).filter(Boolean);

  rows.sort((a, b) =>
    compareCodes(a.zoneCode, b.zoneCode) ||
    compareCodes(a.subzoneCode, b.subzoneCode) ||
    compareCodes(a.areaCode, b.areaCode) ||
    String(a.areaName).localeCompare(String(b.areaName), "es", { sensitivity: "base" })
  );

  const tbody = table.querySelector("tbody");
  if (tbody) rows.forEach(entry => tbody.appendChild(entry.row));
  return rows;
}

function updateBudgetSummary(zoneMap, allocations) {
  const cards = [...document.querySelectorAll(".purchase-budget-summary-card")];
  if (cards.length < 4 || !allocations.length) return;

  const selectedZone = document.querySelector("#budgetFilterZone")?.value || "all";
  const activeRows = selectedZone === "all"
    ? allocations
    : allocations.filter(row => row.rawZoneId === selectedZone);

  const allocated = activeRows.reduce((sum, row) => sum + row.allocated, 0);
  const committed = activeRows.reduce((sum, row) => sum + row.committed, 0);
  const spent = activeRows.reduce((sum, row) => sum + row.spent, 0);
  const available = allocated - committed - spent;

  const values = [allocated, committed, spent, available];
  const baseLabels = ["Asignado", "Comprometido", "Gasto real", "Disponible"];
  const zoneMeta = selectedZone === "all" ? null : zoneMap.get(selectedZone);

  cards.slice(0, 4).forEach((card, index) => {
    const label = card.querySelector(".purchase-budget-summary-label");
    const value = card.querySelector(".purchase-budget-summary-value");
    if (label) label.textContent = zoneMeta ? `${baseLabels[index]} · Zona ${zoneMeta.code}` : baseLabels[index];
    if (value) {
      value.textContent = money(values[index]);
      value.classList.toggle("purchase-budget-negative", index === 3 && values[index] < 0);
    }
  });
}

function patchBudgetUi() {
  if (patching) return;
  const panelBody = document.querySelector(`#${BUDGET_BODY_ID}`);
  if (!panelBody) return;

  patching = true;
  try {
    const zoneMap = normalizeSelect("#budgetFilterZone", "zone");
    const subzoneMap = normalizeSelect("#budgetFilterSubzone", "subzone");
    const areaMap = normalizeSelect("#budgetFilterArea", "area", subzoneMap);

    const allocations = allocationRows(zoneMap);
    patchReportRows(zoneMap, subzoneMap, areaMap);
    updateBudgetSummary(zoneMap, allocations);
  } finally {
    // MutationObserver recibe también los cambios de texto/orden hechos arriba.
    // Mantenemos la bandera durante ese ciclo para no realimentarnos.
    setTimeout(() => { patching = false; }, 0);
  }
}

function schedulePatch(delay = 0) {
  if (patchScheduled) return;
  patchScheduled = true;
  setTimeout(() => {
    patchScheduled = false;
    requestAnimationFrame(patchBudgetUi);
  }, delay);
}

function attachBudgetPanel() {
  const panel = document.querySelector(`#${BUDGET_PANEL_ID}`);
  const body = document.querySelector(`#${BUDGET_BODY_ID}`);
  if (!panel || !body) return false;

  if (!panel.dataset.budgetStructureFixBound) {
    panel.dataset.budgetStructureFixBound = "1";
    panel.addEventListener("show.bs.offcanvas", () => {
      schedulePatch(50);
      setTimeout(patchBudgetUi, 350);
    });
    panel.addEventListener("shown.bs.offcanvas", () => schedulePatch(0));
  }

  if (!budgetPanelObserver) {
    budgetPanelObserver = new MutationObserver(() => {
      if (!patching) schedulePatch(0);
    });
    budgetPanelObserver.observe(body, { childList: true, subtree: true });
  }

  schedulePatch(0);
  return true;
}

function waitForBudgetPanel() {
  if (attachBudgetPanel()) return;
  if (attachingObserver) return;

  attachingObserver = new MutationObserver(() => {
    if (attachBudgetPanel()) {
      attachingObserver.disconnect();
      attachingObserver = null;
    }
  });
  attachingObserver.observe(document.body, { childList: true, subtree: true });
}

function cellTextParts(text) {
  const value = String(text || "").trim();
  const dot = value.indexOf("·");
  if (dot < 0) return [value, ""];
  return [value.slice(0, dot).trim(), value.slice(dot + 1).trim()];
}

function exportBudgetXlsxFromUi(event) {
  const button = event.target.closest("#exportBudgetReportXlsx");
  if (!button) return;
  if (!window.XLSX) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  patchBudgetUi();

  const year = Number(document.querySelector("#purchaseBudgetYear")?.value) || new Date().getFullYear();
  const selectedZone = document.querySelector("#budgetFilterZone")?.value || "all";
  const allocationTable = document.querySelector(".purchase-budget-zone-table");
  const detailTable = document.querySelector(".purchase-budget-report-table");

  const summaryRows = allocationTable
    ? [...allocationTable.querySelectorAll("tbody tr")]
        .filter(row => selectedZone === "all" || row.dataset.rawZoneId === selectedZone)
        .map(row => {
          const cells = row.querySelectorAll("td");
          const [zoneCode, zoneName] = cellTextParts(cells[0]?.textContent);
          const input = row.querySelector(".purchase-budget-zone-input");
          const allocated = input ? Number(input.value || 0) : parseMoney(cells[1]?.textContent);
          const committed = parseMoney(cells[2]?.textContent);
          const spent = parseMoney(cells[3]?.textContent);
          return [year, zoneCode, zoneName, allocated, committed, spent, allocated - committed - spent];
        })
    : [];

  const detailRows = detailTable
    ? [...detailTable.querySelectorAll("tbody tr")].map(row => {
        const cells = row.querySelectorAll("td");
        const [zoneCode, zoneName] = cellTextParts(cells[0]?.textContent);
        const [subzoneCode, subzoneName] = cellTextParts(cells[1]?.textContent);
        const [areaCode, areaName] = cellTextParts(cells[2]?.textContent);
        return [
          year,
          zoneCode,
          zoneName,
          subzoneCode,
          subzoneName,
          areaCode,
          areaName,
          parseMoney(cells[3]?.textContent),
          parseMoney(cells[4]?.textContent),
          parseMoney(cells[5]?.textContent),
          parseMoney(cells[6]?.textContent),
        ];
      })
    : [];

  const filters = [
    ["Filtro", "Valor"],
    ["Ejercicio", year],
    ["Zona", document.querySelector("#budgetFilterZone")?.selectedOptions?.[0]?.textContent || "Todas las zonas"],
    ["Subzona", document.querySelector("#budgetFilterSubzone")?.selectedOptions?.[0]?.textContent || "Todas las subzonas"],
    ["Área", document.querySelector("#budgetFilterArea")?.selectedOptions?.[0]?.textContent || "Todas las áreas"],
  ];

  const wsSummary = XLSX.utils.aoa_to_sheet([
    ["Ejercicio", "Zona", "Nombre zona", "Presupuesto asignado", "Comprometido", "Gasto real", "Disponible"],
    ...summaryRows,
  ]);
  const wsDetail = XLSX.utils.aoa_to_sheet([
    ["Ejercicio", "Zona", "Nombre zona", "Subzona", "Nombre subzona", "Área", "Nombre área", "Comprometido", "Gasto real", "Cancelado/liberado", "Carga actual"],
    ...detailRows,
  ]);
  const wsFilters = XLSX.utils.aoa_to_sheet(filters);

  wsSummary["!cols"] = [{wch:10},{wch:10},{wch:30},{wch:20},{wch:18},{wch:18},{wch:18}];
  wsDetail["!cols"] = [{wch:10},{wch:10},{wch:28},{wch:12},{wch:32},{wch:14},{wch:32},{wch:18},{wch:18},{wch:20},{wch:18}];
  wsFilters["!cols"] = [{wch:16},{wch:42}];

  for (let row = 2; row <= summaryRows.length + 1; row += 1) {
    ["D", "E", "F", "G"].forEach(col => {
      if (wsSummary[`${col}${row}`]) wsSummary[`${col}${row}`].z = '"$"#,##0.00';
    });
  }
  for (let row = 2; row <= detailRows.length + 1; row += 1) {
    ["H", "I", "J", "K"].forEach(col => {
      if (wsDetail[`${col}${row}`]) wsDetail[`${col}${row}`].z = '"$"#,##0.00';
    });
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsSummary, "Resumen zonas");
  XLSX.utils.book_append_sheet(wb, wsDetail, "Zona subzona area");
  XLSX.utils.book_append_sheet(wb, wsFilters, "Filtros");
  XLSX.writeFile(wb, `reporte_presupuesto_compras_${year}.xlsx`, { bookType: "xlsx", compression: true });
}

document.addEventListener("change", event => {
  if (event.target.matches("#budgetFilterZone, #budgetFilterSubzone, #budgetFilterArea")) {
    // compras-status.js actualiza primero su reporte; luego ajustamos resumen y orden.
    schedulePatch(0);
  }
});

document.addEventListener("click", event => {
  if (event.target.closest("#refreshPurchaseBudgets, .budget-save-zone, [data-bs-target='#purchaseBudgetAllocationPane'], [data-bs-target='#purchaseBudgetSpendingPane']")) {
    schedulePatch(150);
    setTimeout(patchBudgetUi, 650);
  }
}, false);

document.addEventListener("click", exportBudgetXlsxFromUi, true);

waitForBudgetPanel();
