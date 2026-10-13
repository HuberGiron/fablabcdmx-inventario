/*
 * FabLab CDMX — controles consistentes para las tres operaciones masivas.
 * UI únicamente: preserva los formularios, validaciones y transacciones
 * originales (compras-request-wide-requisition, compras-undo-requisition,
 * compras-recepcion-masiva).
 */

const SETTINGS = Object.freeze({
  purchase: {
    modalId: "purchaseRequestWideRequisitionModal",
    bodyId: "requestWideRequisitionBody",
    tbodyId: "requestMassUnifiedRows",
    rowSelector: ".request-wide-line",
    checkboxSelector: ".request-wide-line-check",
    selectId: "requestWideSelectAll",
    clearId: "requestWideClearAll",
    searchId: "requestMassRequisitionSearch",
    counterId: "requestMassRequisitionVisible",
  },
  undo: {
    modalId: "purchaseUndoRequisitionModal",
    tbodyId: "requestUndoRows",
    rowSelector: "#requestUndoRows tr:has(.request-undo-check)",
    checkboxSelector: ".request-undo-check",
    selectId: "requestUndoSelectAll",
    clearId: "requestUndoClear",
    searchId: "requestUndoSearch",
    counterId: "requestUndoVisible",
  },
  receipt: {
    modalId: "purchaseMassReceiptModal",
    tbodyId: "massReceiptRows",
    rowSelector: ".mass-receipt-row",
    checkboxSelector: ".mass-receipt-check",
    selectId: "massReceiptSelectAll",
    clearId: "massReceiptClear",
    searchId: "massReceiptSearch",
    counterId: "massReceiptVisible",
  },
});

function normalized(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("es-MX");
}

function modalOf(type) {
  return document.getElementById(SETTINGS[type].modalId);
}

function eligibleRows(type) {
  const modal = modalOf(type);
  return modal ? [...modal.querySelectorAll(SETTINGS[type].rowSelector)] : [];
}

function searchText(row) {
  return normalized(row.dataset.masivosSearch || row.textContent || "");
}

function updateVisibleStatus(type) {
  const cfg = SETTINGS[type];
  const modal = modalOf(type);
  if (!modal) return;
  const rows = eligibleRows(type);
  const shown = rows.filter(row => !row.classList.contains("d-none"));
  const selected = rows.filter(row => row.querySelector(cfg.checkboxSelector)?.checked).length;
  const label = modal.querySelector(`#${cfg.counterId}`);
  if (label) {
    label.textContent = `${shown.length} de ${rows.length} SKU visibles · ${selected} seleccionados`;
  }
  const selectButton = modal.querySelector(`#${cfg.selectId}`);
  if (selectButton) selectButton.disabled = !shown.some(row => {
    const check = row.querySelector(cfg.checkboxSelector);
    return check && !check.disabled;
  });
}

function filterRows(type) {
  const cfg = SETTINGS[type];
  const modal = modalOf(type);
  if (!modal) return;
  const term = normalized(modal.querySelector(`#${cfg.searchId}`)?.value || "");
  const tokens = term.split(" ").filter(Boolean);
  for (const row of eligibleRows(type)) {
    const haystack = searchText(row);
    row.classList.toggle("d-none", !tokens.every(token => haystack.includes(token)));
  }
  updateVisibleStatus(type);
}

function dispatchOneChange(check) {
  // Los módulos originales actualizan cantidades, importes y el estado
  // de Guardar al procesar el cambio de su checkbox.
  check?.dispatchEvent(new Event("change", { bubbles: true }));
}

function changeSelection(type, checked) {
  const cfg = SETTINGS[type];
  let changed = null;
  for (const row of eligibleRows(type)) {
    if (checked && row.classList.contains("d-none")) continue;
    const check = row.querySelector(cfg.checkboxSelector);
    if (!check || check.disabled) continue;
    if (check.checked !== checked) {
      check.checked = checked;
      changed = check;
    }
  }
  // Una sola notificación evita cientos de recalculaciones en solicitudes grandes.
  if (changed) dispatchOneChange(changed);
  updateVisibleStatus(type);
}

function createSearchInput(type) {
  const cfg = SETTINGS[type];
  const input = document.createElement("input");
  input.type = "search";
  input.className = "form-control form-control-sm mass-shared-search";
  input.id = cfg.searchId;
  input.placeholder = "Buscar por producto, SKU o zona / área";
  input.setAttribute("aria-label", "Buscar productos por nombre, SKU o área");
  input.autocomplete = "off";
  return input;
}

function createVisibleIndicator(type) {
  const indicator = document.createElement("span");
  indicator.id = SETTINGS[type].counterId;
  indicator.className = "small text-muted mass-shared-counter";
  indicator.setAttribute("role", "status");
  indicator.setAttribute("aria-live", "polite");
  return indicator;
}

function decorateSimpleModal(type) {
  const cfg = SETTINGS[type];
  const modal = modalOf(type);
  if (!modal) return;
  const select = modal.querySelector(`#${cfg.selectId}`);
  const clear = modal.querySelector(`#${cfg.clearId}`);
  const toolbar = select?.parentElement;
  if (!toolbar || !clear) return;
  toolbar.classList.add("mass-shared-toolbar");
  select.textContent = "Seleccionar visibles";
  select.title = "Seleccionar todos los SKU que coincidan con la búsqueda";
  clear.textContent = "Deseleccionar todo";
  clear.title = "Quitar la selección, incluidos los SKU que estén ocultos por la búsqueda";
  if (!modal.querySelector(`#${cfg.searchId}`)) {
    toolbar.insertBefore(createSearchInput(type), select);
  }
  if (!modal.querySelector(`#${cfg.counterId}`)) {
    toolbar.appendChild(createVisibleIndicator(type));
  }
  const table = modal.querySelector(`#${cfg.tbodyId}`)?.closest(".table-responsive");
  table?.classList.add("mass-shared-table-scroll");
  filterRows(type);
}

function replaceRequisitionLayout() {
  const type = "purchase";
  const cfg = SETTINGS[type];
  const modal = modalOf(type);
  const body = modal?.querySelector(`#${cfg.bodyId}`);
  if (!body) return;
  // Las filas del formulario original se mueven; no se recrean, para que la
  // requisición masiva siga usando exactamente su selección, costo y guardado.
  const products = [...body.querySelectorAll(".request-wide-product")];
  if (!products.length) return; // Ya se convirtió, se está cargando o no hay SKU.

  const summary = body.querySelector("#requestWideSummary");
  const rows = [];
  products.forEach(product => {
    const name = String(product.querySelector(".request-wide-product-title")?.textContent || "Producto").trim();
    product.querySelectorAll(".request-wide-line").forEach(row => {
      const cells = row.querySelectorAll(":scope > td");
      if (cells.length < 6) return;
      const sku = cells[1].textContent.trim();
      const title = document.createElement("strong");
      title.textContent = name;
      const subtitle = document.createElement("div");
      subtitle.className = "small text-muted";
      subtitle.textContent = sku;
      cells[1].replaceChildren(title, subtitle);
      row.dataset.masivosSearch = `${name} ${sku} ${cells[2].textContent} ${row.dataset.name || ""}`;
      // Anteriormente todos los SKU aparecían marcados por defecto; al igual
      // que en las otras dos operaciones masivas, el usuario decide cuáles.
      const check = row.querySelector(cfg.checkboxSelector);
      if (check) check.checked = false;
      rows.push(row);
    });
  });

  const explanation = document.createElement("p");
  explanation.className = "small text-muted mb-3";
  explanation.textContent = "Selecciona los SKU que pasarán a requisición. Cada SKU se registra completo; puedes ajustar el costo unitario oficial antes de confirmar.";
  const toolbar = document.createElement("div");
  toolbar.className = "d-flex flex-wrap align-items-center gap-2 mb-3 mass-shared-toolbar";
  toolbar.appendChild(createSearchInput(type));
  const selectButton = document.createElement("button");
  selectButton.type = "button";
  selectButton.className = "btn btn-outline-dark btn-sm";
  selectButton.id = cfg.selectId;
  selectButton.textContent = "Seleccionar visibles";
  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "btn btn-outline-secondary btn-sm";
  clearButton.id = cfg.clearId;
  clearButton.textContent = "Deseleccionar todo";
  toolbar.append(selectButton, clearButton, createVisibleIndicator(type));

  const tableWrap = document.createElement("div");
  tableWrap.id = "requestWideProducts";
  tableWrap.className = "table-responsive mass-shared-table-scroll";
  const table = document.createElement("table");
  table.className = "table table-sm table-hover align-middle mass-shared-table";
  const thead = document.createElement("thead");
  thead.innerHTML = `<tr>
    <th scope="col">Seleccionar</th>
    <th scope="col">Producto / SKU</th>
    <th scope="col">Zona / subzona / área</th>
    <th scope="col" class="text-end">Solicitado</th>
    <th scope="col" class="text-end">A requisición</th>
    <th scope="col">Costo unitario oficial</th>
  </tr>`;
  const tbody = document.createElement("tbody");
  tbody.id = cfg.tbodyId;
  rows.forEach(row => tbody.appendChild(row));
  table.append(thead, tbody);
  tableWrap.appendChild(table);

  const section = document.createDocumentFragment();
  if (summary) section.appendChild(summary); // mantiene el resumen original
  section.append(explanation, toolbar, tableWrap);
  body.replaceChildren(section);
  if (rows[0]) dispatchOneChange(rows[0].querySelector(cfg.checkboxSelector));
  filterRows(type);
}

const observerByContainer = new WeakMap();
function observeRows(type) {
  const cfg = SETTINGS[type];
  const tbody = modalOf(type)?.querySelector(`#${cfg.tbodyId}`);
  if (!tbody || observerByContainer.has(tbody)) return;
  const observer = new MutationObserver(mutations => {
    if (mutations.some(item => item.type === "childList")) filterRows(type);
  });
  observer.observe(tbody, { childList: true });
  observerByContainer.set(tbody, observer);
}

function prepare(type) {
  const modal = modalOf(type);
  if (!modal) return;
  if (type === "purchase") replaceRequisitionLayout();
  else decorateSimpleModal(type);
  observeRows(type);
  filterRows(type);
}

function watchRequisitionRerender() {
  const body = modalOf("purchase")?.querySelector("#requestWideRequisitionBody");
  if (!body || body.dataset.masivosObserver === "1") return;
  body.dataset.masivosObserver = "1";
  const observer = new MutationObserver(() => {
    // Tras un error parcial el módulo original vuelve a generar la tabla.
    if (body.querySelector(".request-wide-product")) prepare("purchase");
  });
  observer.observe(body, { childList: true });
}

function insertStyles() {
  if (document.querySelector("#massSharedUiStyles")) return;
  const style = document.createElement("style");
  style.id = "massSharedUiStyles";
  style.textContent = `
    .mass-shared-toolbar { align-items: center; }
    .mass-shared-search { flex: 1 1 265px; min-width: 180px; max-width: 500px; }
    .mass-shared-counter { flex: 1 1 100%; font-variant-numeric: tabular-nums; }
    .mass-shared-table-scroll { max-height: min(57vh, 610px); overflow: auto; border: 1px solid #dee2e6; border-radius: .5rem; }
    .mass-shared-table-scroll .table { margin-bottom: 0; }
    .mass-shared-table-scroll thead th { position: sticky; top: 0; z-index: 1; background: var(--bs-tertiary-bg, #f6f7f8); white-space: nowrap; }
    .mass-shared-table-scroll tbody tr:hover { background: var(--bs-tertiary-bg, #f7f7f7); }
    #purchaseRequestWideRequisitionModal .request-wide-line td:nth-child(2) { min-width: 185px; }
    #purchaseRequestWideRequisitionModal .request-wide-line td:nth-child(3) { min-width: 175px; }
    #purchaseRequestWideRequisitionModal .request-wide-line td:nth-child(6) { min-width: 150px; }
    @media (max-width: 767px) { .mass-shared-search { max-width: none; flex-basis: 100%; } }
  `;
  document.head.appendChild(style);
}

insertStyles();

// El listener en fase de captura sustituye SÓLO el comportamiento de los dos
// botones. Evita que los manejadores anteriores seleccionen filas ocultas.
document.addEventListener("click", event => {
  for (const [type, cfg] of Object.entries(SETTINGS)) {
    const select = event.target.closest?.(`#${cfg.selectId}`);
    const clear = event.target.closest?.(`#${cfg.clearId}`);
    if (!select && !clear) continue;
    if (!modalOf(type)?.contains(event.target)) return;
    if ((select || clear).disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    changeSelection(type, Boolean(select));
    return;
  }
}, true);

document.addEventListener("input", event => {
  for (const [type, cfg] of Object.entries(SETTINGS)) {
    if (event.target.id === cfg.searchId) {
      filterRows(type);
      return;
    }
  }
});

document.addEventListener("change", event => {
  for (const [type, cfg] of Object.entries(SETTINGS)) {
    if (event.target.matches?.(cfg.checkboxSelector)) {
      // El original actualiza el pie de selección; nosotros sólo el contador.
      updateVisibleStatus(type);
      return;
    }
  }
});

document.addEventListener("shown.bs.modal", event => {
  const type = Object.keys(SETTINGS).find(key => SETTINGS[key].modalId === event.target?.id);
  if (!type) return;
  prepare(type);
  if (type === "purchase") watchRequisitionRerender();
});

// El modal original se crea una sola vez durante la carga del módulo. Para
// operar también con formularios ya abiertos tras una recarga de módulos:
for (const type of Object.keys(SETTINGS)) {
  if (modalOf(type)?.classList.contains("show")) prepare(type);
}
watchRequisitionRerender();
