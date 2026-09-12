import { db } from "./firebase-app.js";
import { waitForUser, getUserProfile } from "./common.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const PURCHASE_STATUS_ORDERED = "ordered";
const PURCHASE_STATUS_RECEIVED = "received";

const PURCHASE_CATEGORIES = [
  "Mobiliario",
  "Cómputo",
  "Máquinas",
  "Consumibles, accesorios, equipo auxiliar, otros",
];

const PURCHASE_CATEGORY_ORDER = Object.fromEntries(
  PURCHASE_CATEGORIES.map((category, index) => [category, index + 1])
);

const itemsById = new Map();
let decorationQueued = false;
let purchaseStatusFilter = "all";
let effectiveFilteredItems = [];

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

function normalizeForCompare(value) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeTipo(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Otro";
  const comparable = normalizeForCompare(raw);
  if (comparable === "maquina") return "Máquina";
  return raw;
}

function currentInventory(item) {
  return num(item.stockAlmacen) + num(item.stockPrestadoTemporal);
}

function quantityToBuy(item) {
  return Math.max(num(item.inventarioDeseado) - currentInventory(item), 0);
}

function purchaseVisualState(item) {
  const missing = quantityToBuy(item);

  if (missing <= 0) {
    return {
      key: "complete",
      borderClass: "border-success",
      badgeClass: "text-bg-success",
      label: "Inventario completo",
      missing: 0,
    };
  }

  if (item.purchaseStatus === PURCHASE_STATUS_ORDERED) {
    return {
      key: "ordered",
      borderClass: "border-warning",
      badgeClass: "text-bg-warning",
      label: "En compras",
      missing,
    };
  }

  return {
    key: "missing",
    borderClass: "border-danger",
    badgeClass: "text-bg-danger",
    label: "Faltante",
    missing,
  };
}

function purchaseCategory(tipo) {
  const normalized = normalizeTipo(tipo);
  if (normalized === "Mobiliario") return "Mobiliario";
  if (normalized === "Cómputo") return "Cómputo";
  if (normalized === "Máquina" || normalized === "Herramienta") return "Máquinas";
  return "Consumibles, accesorios, equipo auxiliar, otros";
}

function pluralPieces(value) {
  return `${value} pieza${Number(value) === 1 ? "" : "s"}`;
}

function formatCurrency(value, currency = "MXN") {
  const n = Number(value || 0);
  const code = String(currency || "MXN").toUpperCase();
  try {
    return new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${code} ${n.toFixed(2)}`;
  }
}

function formatCurrencyWithCode(value, currency = "MXN") {
  const code = String(currency || "MXN").toUpperCase();
  return `${formatCurrency(value, code)} ${code}`;
}

function emptyMoneyTotals() {
  return {};
}

function addMoneyTotal(totals, currency, amount) {
  const code = String(currency || "MXN").toUpperCase();
  totals[code] = Number(totals[code] || 0) + Number(amount || 0);
}

function formatMoneyTotals(totals) {
  const entries = Object.entries(totals || {})
    .filter(([, value]) => Number(value || 0) !== 0)
    .sort(([a], [b]) => String(a).localeCompare(String(b), "es"));

  return entries.length
    ? entries.map(([currency, total]) => esc(formatCurrencyWithCode(total, currency))).join(" · ")
    : esc(formatCurrencyWithCode(0, "MXN"));
}

function ensureReportGroup(map, key, factory) {
  if (!map.has(key)) map.set(key, factory());
  return map.get(key);
}

function buildPurchaseCategorySummary(rows) {
  const categories = new Map();

  rows.forEach(item => {
    const qty = quantityToBuy(item);
    if (qty <= 0) return;

    const category = purchaseCategory(item.tipo);
    const currency = item.moneda || "MXN";
    const subtotal = qty * num(item.precioUnitario);
    const group = ensureReportGroup(categories, category, () => ({
      category,
      sort: PURCHASE_CATEGORY_ORDER[category] || 99,
      totals: emptyMoneyTotals(),
      qty: 0,
      items: 0,
    }));

    addMoneyTotal(group.totals, currency, subtotal);
    group.qty += qty;
    group.items += 1;
  });

  return PURCHASE_CATEGORIES.map(category =>
    categories.get(category) || {
      category,
      sort: PURCHASE_CATEGORY_ORDER[category] || 99,
      totals: emptyMoneyTotals(),
      qty: 0,
      items: 0,
    }
  );
}

function buildPurchaseBreakdown(rows) {
  const zoneMap = new Map();

  rows.forEach(item => {
    const qty = quantityToBuy(item);
    if (qty <= 0) return;

    const currency = item.moneda || "MXN";
    const subtotal = qty * num(item.precioUnitario);
    const zoneId = String(item.zoneId || "s/z");
    const subzoneId = String(item.subzoneId || "s/s");
    const category = purchaseCategory(item.tipo);

    const zone = ensureReportGroup(zoneMap, zoneId, () => ({
      zoneId,
      zoneName: item.zoneName || "Sin zona",
      totals: emptyMoneyTotals(),
      qty: 0,
      items: 0,
      subzones: new Map(),
    }));

    const subzone = ensureReportGroup(zone.subzones, subzoneId, () => ({
      subzoneId,
      subzoneName: item.subzoneName || "Sin subzona",
      totals: emptyMoneyTotals(),
      qty: 0,
      items: 0,
      categories: new Map(),
    }));

    const cat = ensureReportGroup(subzone.categories, category, () => ({
      category,
      sort: PURCHASE_CATEGORY_ORDER[category] || 99,
      totals: emptyMoneyTotals(),
      qty: 0,
      items: 0,
    }));

    [zone, subzone, cat].forEach(group => {
      addMoneyTotal(group.totals, currency, subtotal);
      group.qty += qty;
      group.items += 1;
    });
  });

  return [...zoneMap.values()]
    .sort((a, b) => String(a.zoneId).localeCompare(String(b.zoneId), "es", { numeric: true }))
    .map(zone => ({
      ...zone,
      subzones: [...zone.subzones.values()]
        .sort((a, b) => String(a.subzoneId).localeCompare(String(b.subzoneId), "es", { numeric: true }))
        .map(subzone => ({
          ...subzone,
          categories: [...subzone.categories.values()]
            .sort((a, b) => a.sort - b.sort || String(a.category).localeCompare(String(b.category), "es")),
        })),
    }));
}

function renderPurchaseCategorySummary(rows) {
  const summary = buildPurchaseCategorySummary(rows);
  return `
    <div class="purchase-category-summary" aria-label="Totales por categoría">
      ${summary.map(cat => `
        <div class="purchase-category-summary-card">
          <div class="purchase-category-summary-label">${esc(cat.category)}</div>
          <div class="purchase-category-summary-total">${formatMoneyTotals(cat.totals)}</div>
          <div class="purchase-category-summary-meta">${cat.items} item${cat.items === 1 ? "" : "s"} · ${cat.qty} pieza${cat.qty === 1 ? "" : "s"}</div>
        </div>`).join("")}
    </div>`;
}

function renderEffectivePurchaseBreakdown(rows) {
  const target = document.querySelector("#purchaseBreakdownReport");
  if (!target) return;

  const breakdown = buildPurchaseBreakdown(rows);
  if (!breakdown.length) {
    target.innerHTML = '<p class="purchase-report-empty">No hay elementos con cantidad sugerida a comprar dentro del filtro actual.</p>';
    return;
  }

  target.innerHTML = `
    ${renderPurchaseCategorySummary(rows)}
    <div class="purchase-report-grid">
      ${breakdown.map(zone => `
        <section class="purchase-zone-report">
          <div class="purchase-zone-header">
            <h3 class="purchase-zone-title">Zona ${esc(zone.zoneId)} · ${esc(zone.zoneName)}</h3>
            <div class="purchase-zone-total">${formatMoneyTotals(zone.totals)}</div>
          </div>
          <div class="purchase-subzone-list">
            ${zone.subzones.map(subzone => `
              <div class="purchase-subzone-report">
                <div class="purchase-subzone-header">
                  <div class="purchase-subzone-title">Subzona ${esc(subzone.subzoneId)} · ${esc(subzone.subzoneName)}</div>
                  <div class="purchase-subzone-total">${formatMoneyTotals(subzone.totals)}</div>
                </div>
                <div class="purchase-category-table">
                  ${subzone.categories.map(cat => `
                    <div class="purchase-category-row">
                      <div>
                        <div class="purchase-category-name">${esc(cat.category)}</div>
                        <div class="purchase-category-meta">${cat.items} item${cat.items === 1 ? "" : "s"} · ${cat.qty} pieza${cat.qty === 1 ? "" : "s"} sugerida${cat.qty === 1 ? "" : "s"}</div>
                      </div>
                      <div class="purchase-category-total">${formatMoneyTotals(cat.totals)}</div>
                    </div>`).join("")}
                </div>
              </div>`).join("")}
          </div>
        </section>`).join("")}
    </div>`;
}

function updateEffectivePurchaseSummary(rows) {
  const totalsEl = document.querySelector("#purchaseSummaryTotals");
  const metaEl = document.querySelector("#purchaseSummaryMeta");
  if (!totalsEl || !metaEl) return;

  const groups = {};
  rows.forEach(item => {
    const qty = quantityToBuy(item);
    const currency = String(item.moneda || "MXN").toUpperCase();
    if (!groups[currency]) groups[currency] = { total: 0, quantity: 0 };
    groups[currency].total += qty * num(item.precioUnitario);
    groups[currency].quantity += qty;
  });

  const entries = Object.entries(groups).sort(([a], [b]) => a.localeCompare(b, "es"));
  totalsEl.innerHTML = entries.length
    ? entries.map(([currency, data]) => esc(formatCurrencyWithCode(data.total, currency))).join(" · ")
    : esc(formatCurrencyWithCode(0, "MXN"));

  const totalQty = entries.reduce((sum, [, data]) => sum + data.quantity, 0);
  metaEl.textContent = `${rows.length} elemento${rows.length === 1 ? "" : "s"} seleccionado${rows.length === 1 ? "" : "s"} por el filtro · ${totalQty} pieza${totalQty === 1 ? "" : "s"} sugerida${totalQty === 1 ? "" : "s"} a comprar`;

  renderEffectivePurchaseBreakdown(rows);
}

function statusControlsHtml(item, state) {
  const current = currentInventory(item);
  const desired = num(item.inventarioDeseado);

  if (state.key === "complete") {
    return `
      <div class="d-flex flex-wrap gap-2 align-items-center">
        <span class="badge ${state.badgeClass}">${state.label}</span>
        <span class="small text-muted">Inventario actual: <strong>${current}</strong> / deseado: <strong>${desired}</strong></span>
      </div>`;
  }

  if (state.key === "ordered") {
    const requested = num(item.purchaseRequestedQty) || state.missing;
    return `
      <div class="d-flex flex-wrap gap-2 align-items-center">
        <span class="badge ${state.badgeClass}">${state.label}</span>
        <span class="small text-muted">Faltan ${pluralPieces(state.missing)} · Solicitud enviada: ${pluralPieces(requested)}</span>
        <button type="button" class="btn btn-sm btn-warning purchase-received-btn" data-id="${esc(item.id)}">Ya llegó</button>
      </div>`;
  }

  return `
    <div class="d-flex flex-wrap gap-2 align-items-center">
      <span class="badge ${state.badgeClass}">${state.label}</span>
      <span class="small text-muted">Faltan ${pluralPieces(state.missing)} para completar el inventario deseado</span>
      <button type="button" class="btn btn-sm btn-danger purchase-send-btn" data-id="${esc(item.id)}">Mandar a comprar</button>
    </div>`;
}

function decorateCard(card) {
  const itemId = card?.dataset?.itemId;
  const item = itemsById.get(itemId);
  if (!item) return;

  const state = purchaseVisualState(item);
  const signature = [
    state.key,
    state.missing,
    currentInventory(item),
    num(item.inventarioDeseado),
    item.purchaseStatus || "",
    num(item.purchaseRequestedQty),
  ].join("|");

  if (card.dataset.purchaseStatusSignature === signature) return;
  card.dataset.purchaseStatusSignature = signature;

  card.classList.remove("border-success", "border-warning", "border-danger", "border-2");
  card.classList.add("border-2", state.borderClass);

  const body = card.querySelector(".card-body");
  if (!body) return;

  let controls = body.querySelector(".purchase-status-controls");
  if (!controls) {
    controls = document.createElement("div");
    controls.className = "purchase-status-controls mt-3 pt-3 border-top";
    const adminActions = body.querySelector(".admin-card-actions");
    if (adminActions) body.insertBefore(controls, adminActions);
    else body.appendChild(controls);
  }

  controls.innerHTML = statusControlsHtml(item, state);
}

function decorateVisibleCards() {
  document.querySelectorAll("#itemsList .item-card[data-item-id]").forEach(decorateCard);
}

function queueDecorations() {
  if (decorationQueued) return;
  decorationQueued = true;
  queueMicrotask(() => {
    decorationQueued = false;
    decorateVisibleCards();
    applyPurchaseStatusFilter();
  });
}

function addStatusFilter() {
  const existing = document.querySelector("#filterPurchaseStatus");
  if (existing) {
    purchaseStatusFilter = existing.value || "all";
    existing.addEventListener("change", () => {
      purchaseStatusFilter = existing.value || "all";
      applyPurchaseStatusFilter();
    });
    return;
  }

  const filterCardBody = document.querySelector(".filter-card .card-body");
  if (!filterCardBody) return;

  const toolbar = filterCardBody.querySelector(".filter-toolbar");
  if (!toolbar) return;

  const row = document.createElement("div");
  row.id = "purchaseStatusFilterRow";
  row.className = "row g-3 align-items-end mt-1";
  row.innerHTML = `
    <div class="col-lg-4 col-md-6 ms-lg-auto">
      <label class="form-label small mb-1" for="filterPurchaseStatus">Estado de compra</label>
      <select id="filterPurchaseStatus" class="form-select filter-input">
        <option value="all" selected>Todos los estados</option>
        <option value="missing">Falta comprar</option>
        <option value="ordered">En compras</option>
        <option value="complete">Inventario completo</option>
      </select>
    </div>`;

  toolbar.parentNode.insertBefore(row, toolbar);

  const select = row.querySelector("#filterPurchaseStatus");
  select.addEventListener("change", () => {
    purchaseStatusFilter = select.value || "all";
    applyPurchaseStatusFilter();
  });

  document.querySelector("#clearFilters")?.addEventListener("click", () => {
    queueMicrotask(() => {
      purchaseStatusFilter = "all";
      select.value = "all";
      applyPurchaseStatusFilter();
    });
  });
}

function matchesPurchaseStatusFilter(item) {
  if (purchaseStatusFilter === "all") return true;
  return purchaseVisualState(item).key === purchaseStatusFilter;
}

function collectEffectiveItems() {
  const cards = [...document.querySelectorAll("#itemsList .item-card[data-item-id]")];
  return cards
    .map(card => itemsById.get(card.dataset.itemId))
    .filter(item => Boolean(item) && matchesPurchaseStatusFilter(item));
}

function applyPurchaseStatusFilter() {
  const cards = [...document.querySelectorAll("#itemsList .item-card[data-item-id]")];
  let visible = 0;
  const effective = [];

  cards.forEach(card => {
    const item = itemsById.get(card.dataset.itemId);
    const show = Boolean(item) && matchesPurchaseStatusFilter(item);
    card.classList.toggle("d-none", !show);
    if (show) {
      visible += 1;
      effective.push(item);
    }
  });

  effectiveFilteredItems = effective;

  const resultCount = document.querySelector("#resultCount");
  if (resultCount) {
    resultCount.textContent = `${visible} resultado${visible === 1 ? "" : "s"}`;
  }

  updateEffectivePurchaseSummary(effectiveFilteredItems);
}

function addLegend() {
  if (document.querySelector("#purchaseStatusLegend")) return;
  const itemsList = document.querySelector("#itemsList");
  if (!itemsList?.parentNode) return;

  const legend = document.createElement("div");
  legend.id = "purchaseStatusLegend";
  legend.className = "d-flex flex-wrap gap-2 align-items-center mb-3 small";
  legend.innerHTML = `
    <span class="fw-semibold me-1">Estado:</span>
    <span class="badge text-bg-danger">Falta comprar</span>
    <span class="badge text-bg-warning">En compras</span>
    <span class="badge text-bg-success">Inventario completo</span>`;
  itemsList.parentNode.insertBefore(legend, itemsList);
}

async function fetchLiveItem(itemId) {
  const snapshot = await getDoc(doc(db, "items", itemId));
  if (!snapshot.exists()) throw new Error("El item ya no existe en Firestore.");
  return { id: snapshot.id, ...snapshot.data() };
}

function setButtonBusy(button, busy, busyLabel) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText || button.textContent;
  }
}

async function sendToPurchases(itemId, button) {
  setButtonBusy(button, true, "Guardando...");

  try {
    const item = await fetchLiveItem(itemId);
    const missing = quantityToBuy(item);

    if (missing <= 0) {
      itemsById.set(itemId, item);
      decorateCard(document.querySelector(`.item-card[data-item-id="${CSS.escape(itemId)}"]`));
      applyPurchaseStatusFilter();
      alert("Este item ya tiene completo su inventario deseado.");
      return;
    }

    const ok = confirm(
      `¿Marcar como enviado a Compras?\n\n${item.nombre || item.sku || "Item"}\nCantidad faltante: ${pluralPieces(missing)}`
    );
    if (!ok) return;

    await updateDoc(doc(db, "items", itemId), {
      purchaseStatus: PURCHASE_STATUS_ORDERED,
      purchaseRequestedQty: missing,
      purchaseRequestedAt: serverTimestamp(),
      purchaseReceivedAt: null,
      purchaseReceivedQty: null,
      updatedAt: serverTimestamp(),
    });

    itemsById.set(itemId, {
      ...item,
      purchaseStatus: PURCHASE_STATUS_ORDERED,
      purchaseRequestedQty: missing,
    });

    const card = document.querySelector(`.item-card[data-item-id="${CSS.escape(itemId)}"]`);
    if (card) {
      delete card.dataset.purchaseStatusSignature;
      decorateCard(card);
    }
    applyPurchaseStatusFilter();
  } catch (error) {
    console.error(error);
    alert(`No se pudo mandar el item a Compras: ${error.message}`);
  } finally {
    setButtonBusy(button, false);
  }
}

async function markAsReceived(itemId, button) {
  setButtonBusy(button, true, "Actualizando...");

  try {
    const item = await fetchLiveItem(itemId);

    if (item.purchaseStatus !== PURCHASE_STATUS_ORDERED) {
      itemsById.set(itemId, item);
      const card = document.querySelector(`.item-card[data-item-id="${CSS.escape(itemId)}"]`);
      if (card) {
        delete card.dataset.purchaseStatusSignature;
        decorateCard(card);
      }
      applyPurchaseStatusFilter();
      alert("Este item ya no está marcado como 'En compras'. Se actualizó la tarjeta con el estado actual.");
      return;
    }

    const missing = quantityToBuy(item);
    if (missing <= 0) {
      await updateDoc(doc(db, "items", itemId), {
        purchaseStatus: PURCHASE_STATUS_RECEIVED,
        purchaseReceivedQty: 0,
        purchaseReceivedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      window.location.reload();
      return;
    }

    const ok = confirm(
      `¿Confirmar que ya llegó la compra?\n\n${item.nombre || item.sku || "Item"}\nSe agregarán ${pluralPieces(missing)} al stock de almacén para completar el inventario deseado.`
    );
    if (!ok) return;

    const newWarehouseStock = num(item.stockAlmacen) + missing;

    await updateDoc(doc(db, "items", itemId), {
      stockAlmacen: newWarehouseStock,
      purchaseStatus: PURCHASE_STATUS_RECEIVED,
      purchaseReceivedQty: missing,
      purchaseReceivedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    window.location.reload();
  } catch (error) {
    console.error(error);
    alert(`No se pudo registrar la recepción de la compra: ${error.message}`);
  } finally {
    setButtonBusy(button, false);
  }
}

function bindPurchaseActions() {
  const itemsList = document.querySelector("#itemsList");
  if (!itemsList) return;

  itemsList.addEventListener("click", event => {
    const sendButton = event.target.closest(".purchase-send-btn");
    if (sendButton) {
      sendToPurchases(sendButton.dataset.id, sendButton);
      return;
    }

    const receivedButton = event.target.closest(".purchase-received-btn");
    if (receivedButton) {
      markAsReceived(receivedButton.dataset.id, receivedButton);
    }
  });
}

function observePurchaseCards() {
  const itemsList = document.querySelector("#itemsList");
  if (!itemsList) return;

  const observer = new MutationObserver(() => queueDecorations());
  observer.observe(itemsList, { childList: true, subtree: true });
}

function cleanXlsxText(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[\uD800-\uDFFF]/g, "")
    .trim();
}

function cleanXlsxNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function xlsxMoneyFormat(currency = "MXN") {
  const code = String(currency || "MXN").trim().toUpperCase();
  if (code === "USD") return '"US$"#,##0.00';
  if (code === "EUR") return '"€"#,##0.00';
  if (code === "MXN") return '"$"#,##0.00';
  return '#,##0.00';
}

function setXlsxNumericCell(ws, cellRef, numberFormat = "") {
  const cell = ws?.[cellRef];
  if (!cell) return;
  cell.t = "n";
  if (numberFormat) cell.z = numberFormat;
}

function applyXlsxMoneyFormat(ws, rowCount, moneyColumns, currencyColumn, startRow = 2) {
  for (let r = startRow; r < startRow + rowCount; r++) {
    const currency = ws?.[`${currencyColumn}${r}`]?.v || "MXN";
    const format = xlsxMoneyFormat(currency);
    for (const col of moneyColumns) {
      setXlsxNumericCell(ws, `${col}${r}`, format);
    }
  }
}

function itemAreaCode(item) {
  return item.locationCode || item.areaCode || item.subzoneId || "";
}

function buildInventoryReportRows(rows) {
  return rows.map(item => ({
    zona: item.zoneName || "",
    subzona: item.subzoneName || "",
    area_codigo: itemAreaCode(item),
    area: item.locationName || "",
    sku: item.sku || "",
    nombre: item.nombre || "",
    tipo: normalizeTipo(item.tipo),
    inventario_actual: currentInventory(item),
    inventario_deseado: num(item.inventarioDeseado),
    cantidad_a_comprar: quantityToBuy(item),
    precio_unitario: num(item.precioUnitario),
    moneda: item.moneda || "MXN",
    subtotal: quantityToBuy(item) * num(item.precioUnitario),
    descripcion: item.descripcion || "",
    liga_compra: item.purchaseUrl || "",
  }));
}

function flattenMoneyTotals(totals) {
  const entries = Object.entries(totals || {})
    .sort(([a], [b]) => String(a).localeCompare(String(b), "es"));
  return entries.length ? entries : [["MXN", 0]];
}

function exportPurchaseReportXlsx(rows) {
  if (!window.XLSX) {
    alert("No se pudo cargar la librería XLSX. Revisa tu conexión a internet o la consola del navegador.");
    return;
  }

  const purchasableRows = rows.filter(item => quantityToBuy(item) > 0);
  if (!purchasableRows.length) {
    alert("No hay elementos con cantidad sugerida a comprar dentro del filtro actual.");
    return;
  }

  const categorySummary = buildPurchaseCategorySummary(purchasableRows);
  const categoryAoa = [
    ["Categoría", "Items", "Piezas sugeridas", "Moneda", "Total"],
    ...categorySummary.flatMap(cat => flattenMoneyTotals(cat.totals).map(([currency, total]) => [
      cleanXlsxText(cat.category),
      cleanXlsxNumber(cat.items),
      cleanXlsxNumber(cat.qty),
      cleanXlsxText(currency),
      cleanXlsxNumber(total),
    ])),
  ];

  const breakdown = buildPurchaseBreakdown(purchasableRows);
  const breakdownAoa = [
    ["Zona", "Nombre zona", "Subzona", "Nombre subzona", "Categoría", "Items", "Piezas sugeridas", "Moneda", "Total"],
    ...breakdown.flatMap(zone => zone.subzones.flatMap(subzone => subzone.categories.flatMap(cat =>
      flattenMoneyTotals(cat.totals).map(([currency, total]) => [
        cleanXlsxText(zone.zoneId),
        cleanXlsxText(zone.zoneName),
        cleanXlsxText(subzone.subzoneId),
        cleanXlsxText(subzone.subzoneName),
        cleanXlsxText(cat.category),
        cleanXlsxNumber(cat.items),
        cleanXlsxNumber(cat.qty),
        cleanXlsxText(currency),
        cleanXlsxNumber(total),
      ])
    ))),
  ];

  const detailRows = buildInventoryReportRows(purchasableRows);
  const detailAoa = [
    ["Zona", "Subzona", "Código de área", "Área", "SKU", "Tipo", "Nombre", "Inventario actual", "Inventario deseado", "Cantidad a comprar", "Precio unitario", "Moneda", "Subtotal", "Liga de compra"],
    ...detailRows.map(row => [
      cleanXlsxText(row.zona),
      cleanXlsxText(row.subzona),
      cleanXlsxText(row.area_codigo),
      cleanXlsxText(row.area),
      cleanXlsxText(row.sku),
      cleanXlsxText(row.tipo),
      cleanXlsxText(row.nombre),
      cleanXlsxNumber(row.inventario_actual),
      cleanXlsxNumber(row.inventario_deseado),
      cleanXlsxNumber(row.cantidad_a_comprar),
      cleanXlsxNumber(row.precio_unitario),
      cleanXlsxText(row.moneda),
      cleanXlsxNumber(row.subtotal),
      cleanXlsxText(row.liga_compra),
    ]),
  ];

  const wb = XLSX.utils.book_new();
  const wsCategories = XLSX.utils.aoa_to_sheet(categoryAoa);
  wsCategories["!cols"] = [{ wch: 18 }, { wch: 10 }, { wch: 18 }, { wch: 10 }, { wch: 16 }];
  applyXlsxMoneyFormat(wsCategories, categoryAoa.length - 1, ["E"], "D");

  const wsBreakdown = XLSX.utils.aoa_to_sheet(breakdownAoa);
  wsBreakdown["!cols"] = [{ wch: 10 }, { wch: 28 }, { wch: 12 }, { wch: 30 }, { wch: 18 }, { wch: 10 }, { wch: 18 }, { wch: 10 }, { wch: 16 }];
  applyXlsxMoneyFormat(wsBreakdown, breakdownAoa.length - 1, ["I"], "H");

  const wsDetail = XLSX.utils.aoa_to_sheet(detailAoa);
  wsDetail["!cols"] = [{ wch: 20 }, { wch: 24 }, { wch: 16 }, { wch: 28 }, { wch: 12 }, { wch: 16 }, { wch: 36 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 16 }, { wch: 40 }];
  applyXlsxMoneyFormat(wsDetail, detailAoa.length - 1, ["K", "M"], "L");

  XLSX.utils.book_append_sheet(wb, wsCategories, "Totales categoria");
  XLSX.utils.book_append_sheet(wb, wsBreakdown, "Zona subzona categoria");
  XLSX.utils.book_append_sheet(wb, wsDetail, "Detalle items");

  const date = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `reporte_compras_fablab_${date}.xlsx`, { bookType: "xlsx", compression: true });
}

function exportVisibleXlsx(rows) {
  const reportRows = buildInventoryReportRows(rows);

  if (!reportRows.length) {
    alert("No hay elementos para exportar con el filtro seleccionado.");
    return;
  }

  if (!window.XLSX) {
    alert("No se pudo cargar la librería XLSX. Revisa tu conexión a internet o la consola del navegador.");
    return;
  }

  const headers = [
    "Zona",
    "Subzona",
    "Código de área",
    "Área",
    "SKU",
    "Tipo",
    "Nombre",
    "Descripción",
    "Inventario actual",
    "Inventario deseado",
    "Cantidad a comprar",
    "Precio unitario",
    "Moneda",
    "Subtotal",
    "Liga de compra",
  ];

  const aoa = [
    headers,
    ...reportRows.map(row => [
      cleanXlsxText(row.zona),
      cleanXlsxText(row.subzona),
      cleanXlsxText(row.area_codigo),
      cleanXlsxText(row.area),
      cleanXlsxText(row.sku),
      cleanXlsxText(row.tipo),
      cleanXlsxText(row.nombre),
      cleanXlsxText(row.descripcion),
      cleanXlsxNumber(row.inventario_actual),
      cleanXlsxNumber(row.inventario_deseado),
      cleanXlsxNumber(row.cantidad_a_comprar),
      cleanXlsxNumber(row.precio_unitario),
      cleanXlsxText(row.moneda),
      cleanXlsxNumber(row.subtotal),
      cleanXlsxText(row.liga_compra),
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 16 }, { wch: 24 }, { wch: 16 }, { wch: 30 }, { wch: 12 },
    { wch: 16 }, { wch: 36 }, { wch: 36 }, { wch: 8 }, { wch: 8 },
    { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 12 }, { wch: 40 },
  ];

  const numericColumns = ["I", "J", "K"];
  for (let r = 2; r <= reportRows.length + 1; r++) {
    for (const col of numericColumns) {
      setXlsxNumericCell(ws, `${col}${r}`);
    }
  }
  applyXlsxMoneyFormat(ws, reportRows.length, ["L", "N"], "M");

  ws["!autofilter"] = { ref: `A1:O${reportRows.length + 1}` };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Inventario filtrado");
  const date = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `inventario_filtrado_fablab_${date}.xlsx`, { bookType: "xlsx", compression: true });
}

function bindFilteredExports() {
  const exportXlsxButton = document.querySelector("#exportXlsx");
  const exportReportButton = document.querySelector("#exportPurchaseReport");

  exportXlsxButton?.addEventListener("click", event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const rows = collectEffectiveItems();
    effectiveFilteredItems = rows;
    exportVisibleXlsx(rows);
  }, true);

  exportReportButton?.addEventListener("click", event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const rows = collectEffectiveItems();
    effectiveFilteredItems = rows;
    exportPurchaseReportXlsx(rows);
  }, true);
}

async function loadAdminItems() {
  const snapshot = await getDocs(
    query(collection(db, "items"), where("activo", "==", true))
  );

  snapshot.docs.forEach(itemDoc => {
    itemsById.set(itemDoc.id, { id: itemDoc.id, ...itemDoc.data() });
  });
}

async function initPurchaseStatusFlow() {
  const user = await waitForUser();
  if (!user) return;

  const profile = await getUserProfile(user.uid);
  if (profile?.role !== "admin") return;

  await loadAdminItems();
  addStatusFilter();
  addLegend();
  bindPurchaseActions();
  bindFilteredExports();
  observePurchaseCards();
  decorateVisibleCards();
  applyPurchaseStatusFilter();
}

initPurchaseStatusFlow().catch(error => {
  console.error("No se pudo inicializar el flujo de estados de compra:", error);
});
