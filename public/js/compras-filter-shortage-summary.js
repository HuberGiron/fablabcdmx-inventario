import { db } from "./firebase-app.js";
import {
  collection,
  getDocs,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const MODULE_ID = "purchaseFilteredShortageSummaryModule";
const NOTE_MARK = "purchase-shortage-summary-note";

const itemsById = new Map();

let itemsLoadedAt = 0;
let loadPromise = null;
let scheduleTimer = null;
let itemsObserver = null;
let observedItemsList = null;
let recomputeBusy = false;
let rerunRequested = false;

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

/*
 * CLAVE DEL AJUSTE:
 *
 * No usamos "cantidad todavía disponible para solicitar".
 * Usamos el faltante físico real contra el inventario deseado.
 *
 * Mientras una pieza siga sin llegar físicamente al inventario,
 * continúa formando parte del faltante aunque:
 * - ya esté en compras;
 * - ya tenga requisición;
 * - esté dentro de una solicitud.
 */
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

const PURCHASE_CATEGORIES = [
  "Mobiliario",
  "Cómputo",
  "Máquinas",
  "Consumibles, accesorios, equipo auxiliar, otros",
];

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

async function loadItems({ force = false } = {}) {
  const now = Date.now();

  if (!force && itemsById.size && now - itemsLoadedAt < 10000) {
    return;
  }

  if (loadPromise) {
    await loadPromise;
    return;
  }

  loadPromise = (async () => {
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

    itemsLoadedAt = Date.now();
  })();

  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

function visibleCards() {
  return [
    ...document.querySelectorAll(
      "#itemsList .item-card[data-item-id]"
    ),
  ].filter(card => !card.classList.contains("d-none"));
}

function visibleRows() {
  return visibleCards()
    .map(card => itemsById.get(String(card.dataset.itemId || "")))
    .filter(Boolean);
}

function createCategoryGroups() {
  const map = new Map();

  PURCHASE_CATEGORIES.forEach((category, index) => {
    map.set(category, {
      category,
      sort: index,
      totals: {},
      qty: 0,
      items: 0,
    });
  });

  return map;
}

function buildCategorySummary(rows) {
  const groups = createCategoryGroups();

  for (const item of rows) {
    const category = purchaseCategory(item.tipo);
    const group = groups.get(category);

    const qty = physicalShortageQty(item);
    const currency = item.moneda || "MXN";
    const subtotal = qty * num(item.precioUnitario);

    group.items += 1;
    group.qty += qty;
    addMoneyTotal(group.totals, currency, subtotal);
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
        { numeric: true }
      )
    )
    .map(zone => ({
      ...zone,
      subzones: [...zone.subzones.values()]
        .sort((a, b) =>
          String(a.subzoneId).localeCompare(
            String(b.subzoneId),
            "es",
            { numeric: true }
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

function updateExplanation() {
  const label = document.querySelector(".purchase-summary-label");

  if (label) {
    label.textContent =
      "Presupuesto estimado del faltante filtrado";
  }

  const note = document.querySelector(".purchase-summary-note");

  if (note && note.dataset.shortageSummaryPatched !== "1") {
    note.dataset.shortageSummaryPatched = "1";
    note.classList.add(NOTE_MARK);

    note.innerHTML = `
      Moneda de trabajo: <strong>MXN</strong>.
      El total se calcula con
      <strong>faltante físico de inventario × precio unitario</strong>:
      <strong>máx(deseado − actual, 0)</strong>.
      Los filtros de estado determinan qué artículos se suman;
      lo que ya está en compras o requisición continúa contando
      hasta que sea recibido físicamente en inventario.
      Si hay más de una moneda, se muestra un total separado por moneda,
      sin conversión cambiaria.`;
  }
}

function renderBreakdown(rows) {
  const report = document.querySelector("#purchaseBreakdownReport");
  if (!report) return;

  if (!rows.length) {
    report.innerHTML =
      '<p class="purchase-report-empty">No hay elementos dentro del filtro actual.</p>';
    return;
  }

  const categories = buildCategorySummary(rows);
  const breakdown = buildBreakdown(rows);

  report.innerHTML = `
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

async function recompute({ forceLoad = false } = {}) {
  if (recomputeBusy) {
    rerunRequested = true;
    return;
  }

  recomputeBusy = true;
  rerunRequested = false;

  try {
    await loadItems({ force: forceLoad });

    const rows = visibleRows();
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

    const totalsEl =
      document.querySelector("#purchaseSummaryTotals");

    const metaEl =
      document.querySelector("#purchaseSummaryMeta");

    if (totalsEl) {
      totalsEl.textContent =
        formatMoneyTotals(totals);
    }

    if (metaEl) {
      metaEl.textContent =
        `${rows.length} elemento${rows.length === 1 ? "" : "s"} en el filtro`
        + ` · ${shortageItems} con faltante`
        + ` · ${totalQty} pieza${totalQty === 1 ? "" : "s"} faltante${totalQty === 1 ? "" : "s"} en inventario`;
    }

    updateExplanation();
    renderBreakdown(rows);
  } catch (error) {
    console.error(
      "No se pudo recalcular el faltante filtrado:",
      error
    );
  } finally {
    recomputeBusy = false;

    if (rerunRequested) {
      rerunRequested = false;
      scheduleRecompute(20);
    }
  }
}

function scheduleRecompute(delay = 80, options = {}) {
  clearTimeout(scheduleTimer);

  scheduleTimer = window.setTimeout(
    () => recompute(options),
    delay
  );
}

function observeItemsList() {
  const itemsList = document.querySelector("#itemsList");

  if (!itemsList || itemsList === observedItemsList) {
    return Boolean(itemsList);
  }

  if (itemsObserver) {
    itemsObserver.disconnect();
  }

  observedItemsList = itemsList;

  itemsObserver = new MutationObserver(mutations => {
    const relevant = mutations.some(mutation => {
      if (mutation.type === "childList") {
        return (
          mutation.addedNodes.length > 0
          || mutation.removedNodes.length > 0
        );
      }

      if (
        mutation.type === "attributes"
        && mutation.attributeName === "class"
      ) {
        return mutation.target.classList?.contains("item-card");
      }

      return false;
    });

    if (relevant) {
      scheduleRecompute(100);
    }
  });

  itemsObserver.observe(
    itemsList,
    {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    }
  );

  scheduleRecompute(100);
  return true;
}

function bindEvents() {
  document.addEventListener(
    "change",
    event => {
      if (
        event.target.matches(
          "#filterPurchaseStatusGroup input, "
          + "#filterPurchasePriorityGroup input, "
          + "#filterZone, #filterSubzone, #filterLocation, "
          + "#filterWeek, #sortMode, .tipo-check"
        )
      ) {
        scheduleRecompute(180);
      }
    }
  );

  document.addEventListener(
    "input",
    event => {
      if (
        event.target.matches("#search")
      ) {
        scheduleRecompute(220);
      }
    }
  );

  document.addEventListener(
    "click",
    event => {
      if (
        event.target.closest("#clearFilters")
      ) {
        scheduleRecompute(250);
      }

      // Al terminar operaciones que pueden haber cambiado el stock,
      // refrescamos también la fuente de Firestore.
      if (
        event.target.closest(
          ".request-line-receive, "
          + ".group-batch-receive, "
          + "#purchaseGroupBatchSave, "
          + "#purchaseWideReceiptSave, "
          + ".purchase-received-btn"
        )
      ) {
        scheduleRecompute(
          900,
          { forceLoad: true }
        );
      }
    }
  );
}

function start() {
  if (document.documentElement.dataset[MODULE_ID] === "1") {
    return;
  }

  document.documentElement.dataset[MODULE_ID] = "1";

  bindEvents();

  if (!observeItemsList()) {
    const timer = window.setInterval(() => {
      if (observeItemsList()) {
        clearInterval(timer);
      }
    }, 250);

    window.setTimeout(
      () => clearInterval(timer),
      15000
    );
  }
}

start();
