import { db } from "./firebase-app.js";
import {
  collection,
  getDocs,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/*
 * ============================================================================
 * RESUMEN DEL FALTANTE FILTRADO
 * ============================================================================
 *
 * Con render progresivo NO se calculan totales leyendo las tarjetas del DOM.
 * La fuente es el conjunto lógico completo expuesto por compras-performance.js.
 *
 * Así 36 tarjetas renderizadas pueden representar, por ejemplo, 616 resultados
 * reales sin alterar totales, zonas, subzonas ni presupuesto estimado.
 * ============================================================================
 */

const PURCHASE_CATEGORIES = [
  "Mobiliario",
  "Cómputo",
  "Máquinas",
  "Consumibles, accesorios, equipo auxiliar, otros",
];

const itemsById = new Map();

let fallbackLoaded = false;
let fallbackPromise = null;
let scheduleTimer = null;
let summaryObserver = null;
let reportObserver = null;
let writing = false;

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function currentInventory(item) {
  return num(item?.stockAlmacen) + num(item?.stockPrestadoTemporal);
}

function physicalShortageQty(item) {
  return Math.max(
    num(item?.inventarioDeseado) - currentInventory(item),
    0
  );
}

function formatCurrency(value, currency = "MXN") {
  const code = String(currency || "MXN").toUpperCase();

  try {
    return new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num(value));
  } catch {
    return `${num(value).toFixed(2)} ${code}`;
  }
}

function formatCurrencyWithCode(value, currency = "MXN") {
  const code = String(currency || "MXN").toUpperCase();
  return `${formatCurrency(value, code)} ${code}`;
}

function purchaseCategory(tipo) {
  const raw = String(tipo || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (raw === "mobiliario") return "Mobiliario";
  if (raw === "computo") return "Cómputo";
  if (raw === "maquina" || raw === "herramienta") return "Máquinas";

  return "Consumibles, accesorios, equipo auxiliar, otros";
}

function addMoneyTotal(totals, currency, amount) {
  const code = String(currency || "MXN").toUpperCase();
  totals[code] = num(totals[code]) + num(amount);
}

function formatMoneyTotals(totals) {
  const entries = Object.entries(totals || {})
    .sort(([a], [b]) =>
      String(a).localeCompare(String(b), "es")
    );

  if (!entries.length) {
    return formatCurrencyWithCode(0, "MXN");
  }

  return entries
    .map(([currency, total]) =>
      formatCurrencyWithCode(total, currency)
    )
    .join(" · ");
}

async function loadFallbackItems() {
  if (fallbackLoaded) return;

  if (fallbackPromise) {
    await fallbackPromise;
    return;
  }

  fallbackPromise = (async () => {
    const snapshot = await getDocs(
      query(
        collection(db, "items"),
        where("activo", "==", true)
      )
    );

    itemsById.clear();

    snapshot.docs.forEach(itemDoc => {
      itemsById.set(
        itemDoc.id,
        {
          id: itemDoc.id,
          ...itemDoc.data(),
        }
      );
    });

    fallbackLoaded = true;
  })();

  try {
    await fallbackPromise;
  } finally {
    fallbackPromise = null;
  }
}

async function logicalRows() {
  const perf = window.__purchasePerformance;

  if (perf?.getLogicalItems) {
    const rows = perf
      .getLogicalItems()
      .filter(Boolean);

    if (
      rows.length
      || perf.getLogicalCount?.() === 0
    ) {
      return rows;
    }
  }

  // Fallback seguro si el navegador no pudo activar la optimización.
  await loadFallbackItems();

  const visibleIds = [
    ...document.querySelectorAll(
      "#itemsList .item-card[data-item-id]"
    ),
  ]
    .filter(card => !card.classList.contains("d-none"))
    .map(card => String(card.dataset.itemId || ""));

  return visibleIds
    .map(id => itemsById.get(id))
    .filter(Boolean);
}

function createCategoryGroups() {
  const map = new Map();

  PURCHASE_CATEGORIES.forEach(
    (category, index) => {
      map.set(
        category,
        {
          category,
          sort: index,
          totals: {},
          qty: 0,
          items: 0,
        }
      );
    }
  );

  return map;
}

function buildCategorySummary(rows) {
  const groups = createCategoryGroups();

  for (const item of rows) {
    const category = purchaseCategory(item.tipo);
    const group = groups.get(category);

    const qty = physicalShortageQty(item);
    const currency = item.moneda || "MXN";

    group.items += 1;
    group.qty += qty;

    addMoneyTotal(
      group.totals,
      currency,
      qty * num(item.precioUnitario)
    );
  }

  return [...groups.values()]
    .sort((a, b) => a.sort - b.sort);
}

function ensureMap(map, key, factory) {
  if (!map.has(key)) {
    map.set(key, factory());
  }

  return map.get(key);
}

function buildBreakdown(rows) {
  const zoneMap = new Map();

  for (const item of rows) {
    const zoneId = String(item.zoneId || "s/z");
    const subzoneId = String(item.subzoneId || "s/s");
    const category = purchaseCategory(item.tipo);

    const qty = physicalShortageQty(item);
    const currency = item.moneda || "MXN";
    const subtotal = qty * num(item.precioUnitario);

    const zone = ensureMap(
      zoneMap,
      zoneId,
      () => ({
        zoneId,
        zoneName: item.zoneName || "Sin zona",
        totals: {},
        qty: 0,
        items: 0,
        subzones: new Map(),
      })
    );

    const subzone = ensureMap(
      zone.subzones,
      subzoneId,
      () => ({
        subzoneId,
        subzoneName: item.subzoneName || "Sin subzona",
        totals: {},
        qty: 0,
        items: 0,
        categories: new Map(),
      })
    );

    const cat = ensureMap(
      subzone.categories,
      category,
      () => ({
        category,
        totals: {},
        qty: 0,
        items: 0,
      })
    );

    for (const group of [zone, subzone, cat]) {
      group.items += 1;
      group.qty += qty;

      addMoneyTotal(
        group.totals,
        currency,
        subtotal
      );
    }
  }

  return [...zoneMap.values()]
    .sort((a, b) =>
      String(a.zoneId).localeCompare(
        String(b.zoneId),
        "es",
        {
          numeric: true,
        }
      )
    )
    .map(zone => ({
      ...zone,
      subzones: [...zone.subzones.values()]
        .sort((a, b) =>
          String(a.subzoneId).localeCompare(
            String(b.subzoneId),
            "es",
            {
              numeric: true,
            }
          )
        )
        .map(subzone => ({
          ...subzone,
          categories: [...subzone.categories.values()]
            .sort((a, b) =>
              PURCHASE_CATEGORIES.indexOf(a.category)
              - PURCHASE_CATEGORIES.indexOf(b.category)
            ),
        })),
    }));
}

function summaryValues(rows) {
  const totals = {};
  let totalQty = 0;
  let shortageItems = 0;

  for (const item of rows) {
    const qty = physicalShortageQty(item);

    if (qty > 0) {
      shortageItems += 1;
    }

    totalQty += qty;

    addMoneyTotal(
      totals,
      item.moneda || "MXN",
      qty * num(item.precioUnitario)
    );
  }

  return {
    totals,
    totalQty,
    shortageItems,
  };
}

function reportHtml(rows) {
  if (!rows.length) {
    return '<p class="purchase-report-empty">No hay elementos dentro del filtro actual.</p>';
  }

  const categories = buildCategorySummary(rows);
  const breakdown = buildBreakdown(rows);

  return `
    <div class="purchase-category-summary"
         aria-label="Totales por categoría">

      ${categories.map(cat => `
        <div class="purchase-category-summary-card">
          <div class="purchase-category-summary-label">
            ${esc(cat.category)}
          </div>

          <div class="purchase-category-summary-total">
            ${esc(formatMoneyTotals(cat.totals))}
          </div>

          <div class="purchase-category-summary-meta">
            ${cat.items} item${cat.items === 1 ? "" : "s"}
            ·
            ${cat.qty} pieza${cat.qty === 1 ? "" : "s"}
            faltante${cat.qty === 1 ? "" : "s"} en inventario
          </div>
        </div>`).join("")}
    </div>

    <div class="purchase-report-grid">
      ${breakdown.map(zone => `
        <section class="purchase-zone-report">

          <div class="purchase-zone-header">
            <h3 class="purchase-zone-title">
              Zona ${esc(zone.zoneId)}
              ·
              ${esc(zone.zoneName)}
            </h3>

            <div class="purchase-zone-total">
              ${esc(formatMoneyTotals(zone.totals))}
            </div>
          </div>

          <div class="purchase-subzone-list">
            ${zone.subzones.map(subzone => `
              <div class="purchase-subzone-report">

                <div class="purchase-subzone-header">
                  <div class="purchase-subzone-title">
                    Subzona ${esc(subzone.subzoneId)}
                    ·
                    ${esc(subzone.subzoneName)}
                  </div>

                  <div class="purchase-subzone-total">
                    ${esc(formatMoneyTotals(subzone.totals))}
                  </div>
                </div>

                <div class="purchase-category-table">
                  ${subzone.categories.map(cat => `
                    <div class="purchase-category-row">
                      <div>
                        <div class="purchase-category-name">
                          ${esc(cat.category)}
                        </div>

                        <div class="purchase-category-meta">
                          ${cat.items} item${cat.items === 1 ? "" : "s"}
                          ·
                          ${cat.qty} pieza${cat.qty === 1 ? "" : "s"}
                          faltante${cat.qty === 1 ? "" : "s"}
                        </div>
                      </div>

                      <div class="purchase-category-total">
                        ${esc(formatMoneyTotals(cat.totals))}
                      </div>
                    </div>`).join("")}
                </div>

              </div>`).join("")}
          </div>

        </section>`).join("")}
    </div>`;
}

function updateExplanation() {
  const label =
    document.querySelector(
      ".purchase-summary-label"
    );

  if (
    label
    && label.textContent !==
      "Presupuesto estimado del faltante filtrado"
  ) {
    label.textContent =
      "Presupuesto estimado del faltante filtrado";
  }

  const note =
    document.querySelector(
      ".purchase-summary-note"
    );

  if (!note) return;

  const html = `
    Moneda de trabajo: <strong>MXN</strong>.
    El total se calcula con
    <strong>faltante físico de inventario × precio unitario</strong>:
    <strong>máx(deseado − actual, 0)</strong>.
    Los filtros de estado determinan qué artículos se suman;
    lo que ya está en compras o requisición continúa contando
    hasta que sea recibido físicamente en inventario.
    Si hay más de una moneda, se muestra un total separado por moneda,
    sin conversión cambiaria.`;

  if (note.innerHTML !== html) {
    note.innerHTML = html;
  }
}

async function recompute() {
  if (writing) return;

  const rows = await logicalRows();

  const {
    totals,
    totalQty,
    shortageItems,
  } = summaryValues(rows);

  const totalsText =
    formatMoneyTotals(totals);

  const metaText =
    `${rows.length} elemento${rows.length === 1 ? "" : "s"} en el filtro`
    + ` · ${shortageItems} con faltante`
    + ` · ${totalQty} pieza${totalQty === 1 ? "" : "s"}`
    + ` faltante${totalQty === 1 ? "" : "s"} en inventario`;

  const reportText = reportHtml(rows);

  const totalsEl =
    document.querySelector(
      "#purchaseSummaryTotals"
    );

  const metaEl =
    document.querySelector(
      "#purchaseSummaryMeta"
    );

  const reportEl =
    document.querySelector(
      "#purchaseBreakdownReport"
    );

  writing = true;

  try {
    if (
      totalsEl
      && totalsEl.textContent !== totalsText
    ) {
      totalsEl.textContent = totalsText;
    }

    if (
      metaEl
      && metaEl.textContent !== metaText
    ) {
      metaEl.textContent = metaText;
    }

    if (
      reportEl
      && reportEl.innerHTML !== reportText
    ) {
      reportEl.innerHTML = reportText;
    }

    updateExplanation();
  } finally {
    writing = false;
  }
}

function scheduleRecompute(delay = 55) {
  clearTimeout(scheduleTimer);

  scheduleTimer = window.setTimeout(
    () => {
      void recompute();
    },
    delay
  );
}

function observeCompetingWriters() {
  const totalsEl =
    document.querySelector(
      "#purchaseSummaryTotals"
    );

  const reportEl =
    document.querySelector(
      "#purchaseBreakdownReport"
    );

  if (
    totalsEl
    && !summaryObserver
  ) {
    summaryObserver = new MutationObserver(
      () => {
        if (!writing) {
          scheduleRecompute(25);
        }
      }
    );

    summaryObserver.observe(
      totalsEl,
      {
        childList: true,
        characterData: true,
        subtree: true,
      }
    );
  }

  if (
    reportEl
    && !reportObserver
  ) {
    reportObserver = new MutationObserver(
      () => {
        if (!writing) {
          scheduleRecompute(25);
        }
      }
    );

    reportObserver.observe(
      reportEl,
      {
        childList: true,
        subtree: false,
      }
    );
  }
}

function start() {
  document.addEventListener(
    "purchase:logical-filter-changed",
    () => {
      scheduleRecompute(35);
    }
  );

  document.addEventListener(
    "purchase:item-cache-ready",
    () => {
      scheduleRecompute(35);
    }
  );

  document.addEventListener(
    "purchase:render-batch",
    () => {
      // Renderizar más tarjetas NO cambia el total lógico.
      // Sólo verificamos que otro módulo no lo haya sobrescrito.
      scheduleRecompute(80);
    }
  );

  document.addEventListener(
    "change",
    event => {
      if (
        event.target.matches?.(
          "#filterPurchaseStatusGroup input, "
          + "#filterPurchasePriorityGroup input, "
          + "#filterZone, #filterSubzone, #filterLocation, "
          + "#filterWeek, #sortMode, .tipo-check"
        )
      ) {
        scheduleRecompute(110);
      }
    }
  );

  document.addEventListener(
    "input",
    event => {
      if (event.target?.id === "search") {
        scheduleRecompute(280);
      }
    }
  );

  const timer = window.setInterval(
    () => {
      observeCompetingWriters();

      if (
        window.__purchasePerformance
        && document.querySelector(
          "#purchaseSummaryTotals"
        )
      ) {
        scheduleRecompute(20);
        clearInterval(timer);
      }
    },
    250
  );

  window.setTimeout(
    () => clearInterval(timer),
    15000
  );
}

start();
