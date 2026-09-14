import { db } from "./firebase-app.js";
import { waitForUser, getUserProfile, fileViewUrl } from "./common.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const PURCHASE_STATUS_ORDERED = "ordered";
const PURCHASE_STATUS_RECEIVED = "received";
const REQUEST_STATUS_DRAFT = "draft";
const REQUEST_STATUS_SENT = "sent";
const REQUEST_STATUS_PARTIAL = "partial";
const REQUEST_STATUS_COMPLETED = "completed";
const REQUEST_STATUS_CANCELLED = "cancelled";
const ALLOWED_ROLES = new Set(["admin", "supervisor"]);

const itemsById = new Map();
const purchaseRequestsById = new Map();
const draftLinesByItemId = new Map();
const bulkSelectedItemIds = new Set();
const purchaseBudgetsByZone = new Map();
const budgetZonesById = new Map();
let budgetFinancialLines = [];

let currentAccessRole = "";
let currentUser = null;
let currentProfile = null;
let currentDraftRequest = null;
let enhancementQueued = false;
let enhancementRerunRequested = false;
let observer = null;
let purchaseUiBusy = false;
let bulkAddBusy = false;
let draftRequestSortMode = "zone";
let budgetReportYear = new Date().getFullYear();
let budgetFilterZone = "all";
let budgetFilterSubzone = "all";
let budgetFilterArea = "all";
let budgetUiBusy = false;

// Evita que una vista no autorizada alcance a mostrar el contenido de Compras
// mientras Firebase resuelve la sesión y el perfil.
document.documentElement.classList.add("purchase-access-pending");

function injectStyles() {
  if (document.querySelector("#purchaseWorkflowStyles")) return;
  const style = document.createElement("style");
  style.id = "purchaseWorkflowStyles";
  style.textContent = `
    html.purchase-access-pending body { visibility: hidden; }

    .purchase-status-controls {
      margin-top: 1rem;
      padding: .9rem 1rem;
      border: 1px solid transparent;
      border-left-width: 6px;
      border-radius: .7rem;
    }
    .purchase-state-missing {
      background: #f8d7da;
      border-color: #dc3545;
    }
    .purchase-state-ordered {
      background: #fff3cd;
      border-color: #f0ad00;
    }
    .purchase-state-complete {
      background: #d1e7dd;
      border-color: #198754;
    }
    .purchase-status-controls .purchase-status-text {
      color: #343a40;
    }

    .purchase-priority-box {
      min-width: 150px;
      padding: .55rem .7rem;
      border: 1px solid #dee2e6;
      border-radius: .65rem;
      background: #fff;
      text-align: right;
    }
    .purchase-priority-box .form-select {
      min-width: 125px;
    }
    .purchase-priority-label {
      display: block;
      margin-bottom: .25rem;
      color: #6c757d;
      font-size: .75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .02em;
    }
    .priority-badge {
      font-size: .78rem;
      padding: .45rem .65rem;
    }

    #purchaseStatusFilterRow .form-select {
      min-height: 42px;
    }

    .purchase-bulk-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: .75rem 1rem;
      margin-bottom: 1rem;
      padding: .75rem 1rem;
      border: 1px solid #d9dde3;
      border-radius: .75rem;
      background: #fff;
    }
    .purchase-bulk-toolbar .form-check { margin: 0; }
    .purchase-bulk-toolbar .bulk-selection-meta { color: #6c757d; font-size: .9rem; }
    .purchase-bulk-selector {
      display: flex;
      align-items: center;
      gap: .45rem;
      margin-bottom: .6rem;
      padding-bottom: .55rem;
      border-bottom: 1px solid rgba(0,0,0,.09);
    }
    .purchase-bulk-selector .form-check-input {
      margin-top: 0;
      width: 1.1rem;
      height: 1.1rem;
      cursor: pointer;
    }
    .purchase-bulk-selector label { cursor: pointer; font-size: .86rem; font-weight: 600; }
    .purchase-bulk-selector.is-disabled { display: none; }
    .item-card.bulk-selected { box-shadow: 0 0 0 3px rgba(33,37,41,.16); }

    .purchase-request-launcher {
      display: flex;
      justify-content: flex-start;
      align-items: center;
      margin-top: 1.75rem;
      margin-bottom: 0;
    }
    .purchase-request-launcher .btn {
      display: inline-flex;
      align-items: center;
      gap: .55rem;
      border-radius: 999px;
      padding-left: 1rem;
      padding-right: 1rem;
    }
    .purchase-request-launcher .badge {
      font-size: .72rem;
    }
    .purchase-requests-offcanvas {
      height: min(90vh, 920px) !important;
      border-bottom-left-radius: 1rem;
      border-bottom-right-radius: 1rem;
    }
    .purchase-requests-offcanvas .offcanvas-header {
      border-bottom: 1px solid #dee2e6;
      padding: 1rem 1.4rem;
    }
    .purchase-requests-offcanvas .offcanvas-body {
      overflow-y: auto;
      padding: 1.25rem 1.4rem 1.5rem;
    }
    .purchase-requests-offcanvas .request-history-table thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: #fff;
      box-shadow: inset 0 -1px 0 #dee2e6;
    }
    .purchase-requests-offcanvas .purchase-request-manager {
      border: 0;
      border-radius: 0;
      background: transparent;
    }
    .request-draft-sort {
      min-width: 220px;
    }
    .request-draft-sort .form-select {
      min-width: 220px;
    }
    @media (max-width: 767.98px) {
      .purchase-requests-offcanvas {
        height: 94vh !important;
      }
      .purchase-request-launcher {
        justify-content: stretch;
      }
      .purchase-request-launcher .btn {
        width: 100%;
        justify-content: center;
      }
    }

    .purchase-request-manager {
      border: 1px solid #d9dde3;
      border-radius: .85rem;
      background: #fff;
    }
    .purchase-request-manager .request-manager-title {
      font-size: 1.15rem;
      font-weight: 700;
      margin: 0;
    }
    .purchase-request-manager .request-manager-subtitle {
      color: #6c757d;
      font-size: .92rem;
    }
    .draft-request-card {
      border: 1px solid #d7dce2;
      border-left: 6px solid #212529;
      border-radius: .75rem;
      background: #fbfbfc;
    }
    .draft-request-empty {
      color: #6c757d;
      padding: .8rem 0;
    }
    .request-history-table td,
    .request-history-table th {
      vertical-align: middle;
    }
    .request-status-badge {
      min-width: 92px;
      text-align: center;
    }
    .purchase-status-controls .purchase-status-note-danger {
      color: #b02a37;
      font-weight: 700;
    }
    .purchase-status-controls .purchase-status-note-muted {
      color: #6c757d;
      font-size: .9rem;
    }
    .request-line-row {
      border: 1px solid #e1e5ea;
      border-radius: .65rem;
      padding: .8rem;
      margin-bottom: .65rem;
      background: #fff;
    }
    .request-line-title {
      font-weight: 700;
      line-height: 1.2;
    }
    .request-line-meta {
      color: #6c757d;
      font-size: .88rem;
    }
    .request-quantity-input {
      max-width: 140px;
    }
    .request-filter-chip {
      display: inline-block;
      margin: 0 .35rem .35rem 0;
      padding: .25rem .55rem;
      border: 1px solid #d9dde3;
      border-radius: 999px;
      background: #fff;
      font-size: .78rem;
    }

    .purchase-request-launcher { gap: .75rem; flex-wrap: wrap; }
    .purchase-budget-summary-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:.75rem; margin-bottom:1rem; }
    .purchase-budget-summary-card { border:1px solid #dee2e6; border-radius:.75rem; padding:.85rem 1rem; background:#fff; }
    .purchase-budget-summary-label { color:#6c757d; font-size:.78rem; font-weight:700; text-transform:uppercase; }
    .purchase-budget-summary-value { font-size:1.25rem; font-weight:700; margin-top:.2rem; }
    .purchase-budget-zone-table td, .purchase-budget-zone-table th, .purchase-budget-report-table td, .purchase-budget-report-table th { vertical-align:middle; }
    .purchase-budget-zone-input { min-width:150px; max-width:190px; }
    .purchase-budget-negative { color:#b02a37 !important; font-weight:700; }
    .purchase-budget-warning { color:#8a6500 !important; font-weight:700; }
    .purchase-budget-offcanvas .offcanvas-body { overflow-y:auto; }
    .purchase-budget-foreign-warning { border:1px solid #f0ad00; background:#fff3cd; border-radius:.65rem; padding:.7rem .85rem; margin-bottom:1rem; color:#664d03; }
    @media (max-width:991.98px) { .purchase-budget-summary-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:575.98px) { .purchase-budget-summary-grid { grid-template-columns:1fr; } }
  `;
  document.head.appendChild(style);
}

function revealPage() {
  document.documentElement.classList.remove("purchase-access-pending");
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function currentInventory(item) {
  return num(item.stockAlmacen) + num(item.stockPrestadoTemporal);
}

function pendingPurchaseQty(item) {
  return Math.max(num(item?.purchasePendingQty), 0);
}

function draftQtyForItem(itemId) {
  return Math.max(num(draftLinesByItemId.get(String(itemId))?.quantityRequested), 0);
}

function requestCapacity(item) {
  const rawMissing = Math.max(num(item.inventarioDeseado) - currentInventory(item), 0);
  return Math.max(rawMissing - pendingPurchaseQty(item), 0);
}

function quantityToBuy(item) {
  return Math.max(requestCapacity(item) - draftQtyForItem(item?.id), 0);
}

function itemPriority(item) {
  const value = Number(item?.purchasePriority);
  return [1, 2, 3].includes(value) ? value : 3;
}

function priorityLabel(priority) {
  const p = Number(priority);
  if (p === 1) return "Prioridad 1 · Alta";
  if (p === 2) return "Prioridad 2 · Media";
  return "Prioridad 3 · Normal";
}

function priorityBadgeClass(priority) {
  const p = Number(priority);
  if (p === 1) return "text-bg-danger";
  if (p === 2) return "text-bg-warning";
  return "text-bg-secondary";
}

function purchaseVisualState(item) {
  const current = currentInventory(item);
  const desired = num(item.inventarioDeseado);
  const pending = pendingPurchaseQty(item);
  const available = quantityToBuy(item);
  const rawMissing = Math.max(desired - current, 0);

  if (pending > 0) {
    return {
      key: "ordered",
      cardBorderClass: "border-warning",
      bandClass: "purchase-state-ordered",
      badgeClass: "text-bg-warning",
      label: "En compras",
      missing: rawMissing,
      pending,
      available,
    };
  }

  if (rawMissing <= 0) {
    return {
      key: "complete",
      cardBorderClass: "border-success",
      bandClass: "purchase-state-complete",
      badgeClass: "text-bg-success",
      label: "Inventario completo",
      missing: 0,
      pending: 0,
      available: 0,
    };
  }

  return {
    key: "missing",
    cardBorderClass: "border-danger",
    bandClass: "purchase-state-missing",
    badgeClass: "text-bg-danger",
    label: "Falta comprar",
    missing: rawMissing,
    pending: 0,
    available,
  };
}

function purchaseStatusLabel(item) {
  return purchaseVisualState(item).label;
}

function pluralPieces(value) {
  return `${value} pieza${Number(value) === 1 ? "" : "s"}`;
}

function statusControlsHtml(item, state) {
  const current = currentInventory(item);
  const desired = num(item.inventarioDeseado);
  const draftQty = draftQtyForItem(item.id);
  const addLabel = draftQty > 0 ? "Editar cantidad" : "Agregar a solicitud";

  if (state.key === "complete") {
    return `
      <div class="d-flex flex-wrap gap-3 align-items-center justify-content-between">
        <div class="d-flex flex-wrap gap-2 align-items-center">
          <span class="badge ${state.badgeClass}">${state.label}</span>
          <span class="purchase-status-text">Inventario actual: <strong>${current}</strong> / deseado: <strong>${desired}</strong></span>
          ${draftQty > 0 ? `<span class="badge text-bg-dark">En borrador: ${pluralPieces(draftQty)}</span>` : ""}
        </div>
        ${draftQty > 0 ? `<button type="button" class="btn btn-dark purchase-add-request-btn" data-id="${item.id}">${addLabel}</button>` : ""}
      </div>`;
  }

  if (state.key === "ordered") {
    return `
      <div class="d-flex flex-wrap gap-3 align-items-center justify-content-between">
        <div class="d-flex flex-column gap-1">
          <div class="d-flex flex-wrap gap-2 align-items-center">
            <span class="badge ${state.badgeClass}">${state.label}</span>
            <span class="purchase-status-text">Pendiente de recibir: <strong>${pluralPieces(state.pending)}</strong></span>
            ${draftQty > 0 ? `<span class="badge text-bg-dark">En borrador: ${pluralPieces(draftQty)}</span>` : ""}
          </div>
          ${state.available > 0 ? `<div class="purchase-status-note-danger">Aún disponible para solicitar: ${pluralPieces(state.available)}</div>` : `<div class="purchase-status-note-muted">Todo lo faltante ya está cubierto por solicitudes activas.</div>`}
        </div>
        <div class="d-flex flex-wrap gap-2 align-items-center">
          <button type="button" class="btn btn-dark purchase-view-requests-btn" data-id="${item.id}">Ver solicitudes</button>
          ${state.available > 0 || draftQty > 0 ? `<button type="button" class="btn btn-danger purchase-add-request-btn" data-id="${item.id}">${addLabel}</button>` : ""}
        </div>
      </div>`;
  }

  return `
    <div class="d-flex flex-wrap gap-3 align-items-center justify-content-between">
      <div class="d-flex flex-column gap-1">
        <div class="d-flex flex-wrap gap-2 align-items-center">
          <span class="badge ${state.badgeClass}">${state.label}</span>
          <span class="purchase-status-text">Disponible para solicitar: <strong>${pluralPieces(state.available)}</strong></span>
          ${draftQty > 0 ? `<span class="badge text-bg-dark">En borrador: ${pluralPieces(draftQty)}</span>` : ""}
        </div>
        <div class="purchase-status-note-muted">Actual: ${current} / Deseado: ${desired}</div>
      </div>
      <button type="button" class="btn btn-danger purchase-add-request-btn" data-id="${item.id}">${addLabel}</button>
    </div>`;
}

function priorityControlHtml(item) {
  const priority = itemPriority(item);

  if (currentAccessRole === "admin") {
    return `
      <div class="purchase-priority-box">
        <label class="purchase-priority-label" for="priority-${item.id}">Prioridad de compra</label>
        <select id="priority-${item.id}" class="form-select form-select-sm purchase-priority-select" data-id="${item.id}" aria-label="Prioridad de compra">
          <option value="1" ${priority === 1 ? "selected" : ""}>1 · Alta</option>
          <option value="2" ${priority === 2 ? "selected" : ""}>2 · Media</option>
          <option value="3" ${priority === 3 ? "selected" : ""}>3 · Normal</option>
        </select>
      </div>`;
  }

  return `
    <div class="purchase-priority-box">
      <span class="purchase-priority-label">Prioridad de compra</span>
      <span class="badge priority-badge ${priorityBadgeClass(priority)}">${priorityLabel(priority)}</span>
    </div>`;
}

function decoratePurchaseCost(card, item) {
  const cost = card.querySelector(".purchase-item-cost");
  if (!cost) return;

  const currency = item.moneda || "MXN";
  const price = num(item.precioUnitario);
  const pending = pendingPurchaseQty(item);
  const available = quantityToBuy(item);
  const draftQty = draftQtyForItem(item.id);
  const subtotal = available * price;

  // Evita reescribir el DOM en cada pasada. Esto es importante porque con
  // miles de tarjetas un innerHTML repetitivo puede disparar nuevamente el
  // MutationObserver y provocar un ciclo de renderizado.
  const signature = [currency, price, pending, available, draftQty, subtotal].join("|");
  if (cost.dataset.purchaseCostSignature === signature) return;
  cost.dataset.purchaseCostSignature = signature;

  cost.innerHTML = `
    <span><strong>Precio unitario:</strong> ${reportEscape(formatCurrencyWithCode(price, currency))}</span>
    <span><strong>Pendiente de recibir:</strong> ${pending}</span>
    ${draftQty > 0 ? `<span><strong>En borrador:</strong> ${draftQty}</span>` : ""}
    <span><strong>Disponible para solicitar:</strong> ${available}</span>
    <span><strong>Subtotal disponible:</strong> ${reportEscape(formatCurrencyWithCode(subtotal, currency))}</span>`;
}

function decoratePriority(card, item) {
  const body = card.querySelector(".card-body");
  if (!body) return;

  const header = body.querySelector(":scope > .d-flex.justify-content-between");
  if (!header) return;

  let box = header.querySelector(".purchase-priority-wrapper");
  if (!box) {
    box = document.createElement("div");
    box.className = "purchase-priority-wrapper ms-auto";
    header.appendChild(box);
  }

  const signature = `${currentAccessRole}|${itemPriority(item)}`;
  if (box.dataset.signature === signature) return;
  box.dataset.signature = signature;
  box.innerHTML = priorityControlHtml(item);
}

function decorateCard(card) {
  const itemId = card?.dataset?.itemId;
  const item = itemsById.get(itemId);
  if (!item) return;

  if (currentAccessRole === "supervisor") {
    card.querySelector(".admin-card-actions")?.remove();
  }

  decoratePriority(card, item);
  decoratePurchaseCost(card, item);

  const state = purchaseVisualState(item);
  const signature = [
    state.key,
    state.missing,
    state.pending || 0,
    state.available || 0,
    currentInventory(item),
    num(item.inventarioDeseado),
    draftQtyForItem(item.id),
  ].join("|");

  card.classList.remove("border-success", "border-warning", "border-danger", "border-2");
  card.classList.add("border-2", state.cardBorderClass);

  const body = card.querySelector(".card-body");
  if (!body) return;

  let controls = body.querySelector(".purchase-status-controls");
  if (!controls) {
    controls = document.createElement("div");
    controls.className = "purchase-status-controls";
    const adminActions = body.querySelector(".admin-card-actions");
    if (adminActions) body.insertBefore(controls, adminActions);
    else body.appendChild(controls);
  }

  controls.classList.remove("purchase-state-missing", "purchase-state-ordered", "purchase-state-complete");
  controls.classList.add(state.bandClass);

  if (controls.dataset.signature !== signature) {
    controls.dataset.signature = signature;
    controls.innerHTML = statusControlsHtml(item, state);
  }

  decorateBulkSelector(card, item, controls);
}

function decorateBulkSelector(card, item, controls) {
  if (!controls) return;

  const itemId = String(item.id);
  const eligible = quantityToBuy(item) > 0;
  if (!eligible) bulkSelectedItemIds.delete(itemId);

  let wrapper = controls.querySelector(".purchase-bulk-selector");
  if (!wrapper) {
    wrapper = document.createElement("div");
    wrapper.className = "purchase-bulk-selector";
    controls.prepend(wrapper);
  }

  wrapper.classList.toggle("is-disabled", !eligible);
  wrapper.innerHTML = `
    <input class="form-check-input purchase-bulk-checkbox" type="checkbox"
      id="bulk-select-${reportEscape(itemId)}" data-id="${reportEscape(itemId)}"
      ${bulkSelectedItemIds.has(itemId) ? "checked" : ""}
      ${eligible ? "" : "disabled"}>
    <label for="bulk-select-${reportEscape(itemId)}">Seleccionar para solicitud</label>`;

  card.classList.toggle("bulk-selected", eligible && bulkSelectedItemIds.has(itemId));
}

function visibleBulkEligibleItems() {
  return nativeCards()
    .filter(card => !card.classList.contains("d-none"))
    .map(card => itemsById.get(card.dataset.itemId))
    .filter(Boolean)
    .filter(item => quantityToBuy(item) > 0);
}

function updateBulkPurchaseToolbar() {
  const toolbar = document.querySelector("#purchaseBulkToolbar");
  if (!toolbar) return;

  for (const itemId of [...bulkSelectedItemIds]) {
    const item = itemsById.get(itemId);
    if (!item || quantityToBuy(item) <= 0) bulkSelectedItemIds.delete(itemId);
  }

  const visibleEligible = visibleBulkEligibleItems();
  const visibleIds = visibleEligible.map(item => String(item.id));
  const selectedVisible = visibleIds.filter(id => bulkSelectedItemIds.has(id)).length;
  const totalSelected = bulkSelectedItemIds.size;

  const selectVisible = toolbar.querySelector("#bulkSelectVisible");
  const selectedText = toolbar.querySelector("#bulkSelectedCount");
  const eligibleText = toolbar.querySelector("#bulkEligibleCount");
  const addButton = toolbar.querySelector("#bulkAddSelected");
  const clearButton = toolbar.querySelector("#bulkClearSelection");

  if (selectVisible) {
    selectVisible.disabled = visibleEligible.length === 0 || bulkAddBusy;
    selectVisible.checked = visibleEligible.length > 0 && selectedVisible === visibleEligible.length;
    selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < visibleEligible.length;
  }
  if (selectedText) selectedText.textContent = `${totalSelected} seleccionado${totalSelected === 1 ? "" : "s"}`;
  if (eligibleText) eligibleText.textContent = `${visibleEligible.length} disponible${visibleEligible.length === 1 ? "" : "s"} en el filtro actual`;
  if (addButton) {
    addButton.disabled = totalSelected === 0 || bulkAddBusy;
    addButton.textContent = bulkAddBusy
      ? "Agregando…"
      : `Agregar seleccionados al borrador${totalSelected ? ` (${totalSelected})` : ""}`;
  }
  if (clearButton) clearButton.disabled = totalSelected === 0 || bulkAddBusy;

  nativeCards().forEach(card => {
    const checkbox = card.querySelector(".purchase-bulk-checkbox");
    const itemId = String(card.dataset.itemId || "");
    if (checkbox) checkbox.checked = bulkSelectedItemIds.has(itemId);
    card.classList.toggle("bulk-selected", bulkSelectedItemIds.has(itemId));
  });
}

function addBulkPurchaseToolbar() {
  if (document.querySelector("#purchaseBulkToolbar")) return;

  const itemsList = document.querySelector("#itemsList");
  if (!itemsList?.parentNode) return;

  const toolbar = document.createElement("div");
  toolbar.id = "purchaseBulkToolbar";
  toolbar.className = "purchase-bulk-toolbar";
  toolbar.innerHTML = `
    <div class="d-flex flex-wrap align-items-center gap-3">
      <div class="form-check">
        <input class="form-check-input" type="checkbox" id="bulkSelectVisible">
        <label class="form-check-label fw-semibold" for="bulkSelectVisible">Seleccionar todos los visibles</label>
      </div>
      <span class="bulk-selection-meta" id="bulkEligibleCount">0 disponibles en el filtro actual</span>
      <span class="badge text-bg-dark" id="bulkSelectedCount">0 seleccionados</span>
    </div>
    <div class="d-flex flex-wrap gap-2">
      <button type="button" class="btn btn-outline-secondary btn-sm" id="bulkClearSelection" disabled>Limpiar selección</button>
      <button type="button" class="btn btn-dark btn-sm" id="bulkAddSelected" disabled>Agregar seleccionados al borrador</button>
    </div>`;

  const legend = document.querySelector("#purchaseStatusLegend");
  itemsList.parentNode.insertBefore(toolbar, legend || itemsList);
  updateBulkPurchaseToolbar();
}

async function addSelectedItemsToDraft() {
  if (bulkAddBusy || !bulkSelectedItemIds.size) return;

  const selectedItems = [...bulkSelectedItemIds]
    .map(id => itemsById.get(id))
    .filter(Boolean)
    .map(item => ({ item, qty: requestCapacity(item) }))
    .filter(entry => entry.qty > 0);

  if (!selectedItems.length) {
    bulkSelectedItemIds.clear();
    updateBulkPurchaseToolbar();
    alert("Los artículos seleccionados ya no tienen cantidad disponible para solicitar.");
    return;
  }

  const totalQty = selectedItems.reduce((sum, entry) => sum + entry.qty, 0);
  const ok = confirm(
    `¿Agregar ${selectedItems.length} artículo${selectedItems.length === 1 ? "" : "s"} al borrador con la cantidad máxima disponible?\n\n` +
    `Se agregarán ${totalQty} pieza${totalQty === 1 ? "" : "s"} en total. Después puedes editar cada cantidad antes de enviar la solicitud.`
  );
  if (!ok) return;

  bulkAddBusy = true;
  updateBulkPurchaseToolbar();

  try {
    const request = await ensureDraftRequest();
    const chunks = [];
    for (let i = 0; i < selectedItems.length; i += 350) chunks.push(selectedItems.slice(i, i + 350));

    for (const chunk of chunks) {
      const batch = writeBatch(db);
      for (const { item, qty } of chunk) {
        const existing = draftLinesByItemId.get(String(item.id));
        const lineRef = doc(db, "purchaseRequests", request.id, "items", String(item.id));
        batch.set(lineRef, {
          ...snapshotLineFromItem(item, qty),
          addedAt: existing?.addedAt || serverTimestamp(),
        }, { merge: true });
      }
      await batch.commit();
    }

    for (const { item, qty } of selectedItems) {
      const existing = draftLinesByItemId.get(String(item.id));
      draftLinesByItemId.set(String(item.id), {
        ...(existing || {}),
        ...snapshotLineFromItem(item, qty),
        itemId: item.id,
        quantityRequested: qty,
        addedAt: existing?.addedAt || new Date(),
      });
    }

    await syncDraftRequestSummary();
    bulkSelectedItemIds.clear();
    renderPurchaseRequestManager();
    queueEnhancements();

    alert(
      `${selectedItems.length} artículo${selectedItems.length === 1 ? "" : "s"} agregado${selectedItems.length === 1 ? "" : "s"} al borrador con su cantidad máxima disponible.\n\n` +
      `Puedes ajustar las cantidades desde “Solicitudes de compra” antes de enviar.`
    );
  } catch (error) {
    console.error(error);
    alert(`No se pudieron agregar los artículos al borrador: ${error.message}`);
  } finally {
    bulkAddBusy = false;
    updateBulkPurchaseToolbar();
  }
}

function bindBulkPurchaseActions() {
  const itemsList = document.querySelector("#itemsList");
  if (itemsList) {
    itemsList.addEventListener("change", event => {
      const checkbox = event.target.closest(".purchase-bulk-checkbox");
      if (!checkbox) return;
      const itemId = String(checkbox.dataset.id || "");
      if (!itemId) return;
      if (checkbox.checked) bulkSelectedItemIds.add(itemId);
      else bulkSelectedItemIds.delete(itemId);
      updateBulkPurchaseToolbar();
    });
  }

  document.addEventListener("change", event => {
    const selectVisible = event.target.closest("#bulkSelectVisible");
    if (!selectVisible) return;
    const visible = visibleBulkEligibleItems();
    visible.forEach(item => {
      const itemId = String(item.id);
      if (selectVisible.checked) bulkSelectedItemIds.add(itemId);
      else bulkSelectedItemIds.delete(itemId);
    });
    updateBulkPurchaseToolbar();
  });

  document.addEventListener("click", async event => {
    if (event.target.closest("#bulkClearSelection")) {
      bulkSelectedItemIds.clear();
      updateBulkPurchaseToolbar();
      return;
    }
    if (event.target.closest("#bulkAddSelected")) {
      await addSelectedItemsToDraft();
    }
  });
}

function addFilters() {
  if (document.querySelector("#filterPurchaseStatus")) return;

  const filterCardBody = document.querySelector(".filter-card .card-body");
  const toolbar = filterCardBody?.querySelector(".filter-toolbar");
  if (!filterCardBody || !toolbar) return;

  const row = document.createElement("div");
  row.id = "purchaseStatusFilterRow";
  row.className = "row g-3 align-items-end mt-1";
  row.innerHTML = `
    <div class="col-lg-4 col-md-6 ms-lg-auto">
      <label class="form-label small mb-1" for="filterPurchaseStatus">Estado de compra</label>
      <select id="filterPurchaseStatus" class="form-select">
        <option value="all" selected>Todos los estados</option>
        <option value="missing">Falta comprar</option>
        <option value="ordered">En compras</option>
        <option value="complete">Inventario completo / ya llegó</option>
      </select>
    </div>
    <div class="col-lg-4 col-md-6">
      <label class="form-label small mb-1" for="filterPurchasePriority">Prioridad</label>
      <select id="filterPurchasePriority" class="form-select">
        <option value="all" selected>Todas las prioridades</option>
        <option value="1">Prioridad 1 · Alta</option>
        <option value="2">Prioridad 2 · Media</option>
        <option value="3">Prioridad 3 · Normal</option>
      </select>
    </div>`;

  toolbar.parentNode.insertBefore(row, toolbar);

  row.querySelectorAll("select").forEach(select => {
    select.addEventListener("input", () => queueEnhancements());
    select.addEventListener("change", () => queueEnhancements());
  });

  document.querySelector("#clearFilters")?.addEventListener("click", () => {
    setTimeout(() => {
      const status = document.querySelector("#filterPurchaseStatus");
      const priority = document.querySelector("#filterPurchasePriority");
      if (status) status.value = "all";
      if (priority) priority.value = "all";
      queueEnhancements();
    }, 0);
  });
}

function addPrioritySortOption() {
  const sort = document.querySelector("#sortMode");
  if (!sort || sort.querySelector('option[value="priority"]')) return;
  const option = document.createElement("option");
  option.value = "priority";
  option.textContent = "Prioridad (1 → 3)";
  sort.appendChild(option);
  sort.addEventListener("input", () => queueMicrotask(() => queueEnhancements()));
  sort.addEventListener("change", () => queueMicrotask(() => queueEnhancements()));
}

function addLegend() {
  if (document.querySelector("#purchaseStatusLegend")) return;
  const itemsList = document.querySelector("#itemsList");
  if (!itemsList?.parentNode) return;

  const legend = document.createElement("div");
  legend.id = "purchaseStatusLegend";
  legend.className = "d-flex flex-wrap gap-2 align-items-center mb-3 small";
  legend.innerHTML = `
    <span class="fw-semibold me-1">Estado de compra:</span>
    <span class="badge text-bg-danger">Falta comprar</span>
    <span class="badge text-bg-warning">En compras</span>
    <span class="badge text-bg-success">Inventario completo / ya llegó</span>
    <span class="text-muted ms-md-2">Prioridad: 1 alta · 2 media · 3 normal</span>`;
  itemsList.parentNode.insertBefore(legend, itemsList);
}


function addPdfReportButton() {
  if (document.querySelector("#exportPurchasePdf")) return;

  const excelButton = document.querySelector("#exportPurchaseReport");
  const container = excelButton?.parentElement;
  if (!excelButton || !container) return;

  const button = document.createElement("button");
  button.type = "button";
  button.id = "exportPurchasePdf";
  button.className = "btn btn-outline-danger";
  button.textContent = "Generar reporte PDF";
  container.insertBefore(button, excelButton);
}

function reportEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function selectedOptionText(selector, fallback = "") {
  const select = document.querySelector(selector);
  if (!select) return fallback;
  return select.selectedOptions?.[0]?.textContent?.trim() || fallback;
}

function selectedTypesText() {
  const checks = [...document.querySelectorAll(".tipo-check")];
  if (!checks.length) return "Todas las categorías";

  const selected = checks.filter(check => check.checked).map(check => String(check.value || "").trim()).filter(Boolean);
  if (selected.length === checks.length) return "Todas las categorías";
  if (!selected.length) return "Ningún tipo seleccionado";
  return selected.join(", ");
}

function appliedFiltersForReport() {
  return [
    ["Zona", selectedOptionText("#filterZone", "Todas las zonas")],
    ["Subzona", selectedOptionText("#filterSubzone", "Todas las subzonas")],
    ["Ubicación", selectedOptionText("#filterLocation", "Todas las ubicaciones")],
    ["Tipo", selectedTypesText()],
    ["FabAcademy", selectedOptionText("#filterWeek", "Todas las semanas FabAcademy")],
    ["Buscar", document.querySelector("#search")?.value?.trim() || "Sin búsqueda"],
    ["Estado de compra", selectedOptionText("#filterPurchaseStatus", "Todos los estados")],
    ["Prioridad", selectedOptionText("#filterPurchasePriority", "Todas las prioridades")],
    ["Orden", selectedOptionText("#sortMode", "Zona / subzona")],
  ];
}

function reportCards() {
  return nativeCards().filter(card => {
    const item = itemsById.get(card.dataset.itemId);
    return Boolean(item) && matchesExtraFilters(item) && !card.classList.contains("d-none");
  });
}

function cloneCardForPdf(card) {
  const clone = card.cloneNode(true);
  const item = itemsById.get(card.dataset.itemId);

  clone.classList.remove("d-none");
  clone.removeAttribute("data-purchase-status-signature");
  clone.querySelector(".admin-card-actions")?.remove();
  clone.querySelector(".purchase-bulk-selector")?.remove();

  // En el PDF no deben aparecer acciones operativas: editar, descargar,
  // mandar a comprar, cancelar o registrar recepción.
  clone.querySelectorAll("button").forEach(button => button.remove());

  // La prioridad se vuelve una etiqueta estática aun cuando el reporte
  // sea generado por un administrador que en pantalla ve un <select>.
  let priorityWrapper = clone.querySelector(".purchase-priority-wrapper");
  if (!priorityWrapper && item) {
    const body = clone.querySelector(".card-body");
    const header = body?.querySelector(":scope > .d-flex.justify-content-between");
    if (header) {
      priorityWrapper = document.createElement("div");
      priorityWrapper.className = "purchase-priority-wrapper ms-auto";
      header.appendChild(priorityWrapper);
    }
  }
  if (priorityWrapper && item) {
    const priority = itemPriority(item);
    priorityWrapper.innerHTML = `
      <div class="purchase-priority-box">
        <span class="purchase-priority-label">Prioridad de compra</span>
        <span class="badge priority-badge ${priorityBadgeClass(priority)}">${reportEscape(priorityLabel(priority))}</span>
      </div>`;
  }

  // Conservamos el estado y su franja de color, pero eliminamos cualquier
  // contenedor que haya quedado vacío al retirar los botones de acción.
  clone.querySelectorAll(".purchase-status-controls .d-flex").forEach(el => {
    if (!el.textContent.trim() && !el.querySelector("*") ) el.remove();
  });

  // Convertimos enlaces e imágenes a URL absoluta para que funcionen en la
  // ventana independiente usada para imprimir/guardar el PDF.
  clone.querySelectorAll("a[href]").forEach(anchor => {
    try {
      anchor.setAttribute("href", new URL(anchor.getAttribute("href"), document.baseURI).href);
    } catch (_) {}
  });
  clone.querySelectorAll("img[src]").forEach(img => {
    try {
      img.setAttribute("src", new URL(img.getAttribute("src"), document.baseURI).href);
    } catch (_) {}
  });

  return clone.outerHTML;
}

function exportPurchaseReportPdf() {
  const cards = reportCards();
  if (!cards.length) {
    alert("No hay elementos dentro del filtro actual para generar el PDF.");
    return;
  }

  const reportWindow = window.open("", "_blank");
  if (!reportWindow) {
    alert("El navegador bloqueó la ventana del reporte. Permite ventanas emergentes para este sitio e inténtalo nuevamente.");
    return;
  }

  const now = new Date();
  const dateIso = now.toISOString().slice(0, 10);
  const generatedAt = now.toLocaleString("es-MX", { dateStyle: "long", timeStyle: "short" });
  const filterRows = appliedFiltersForReport();
  const filterHtml = filterRows.map(([label, value]) => `
    <div class="report-filter">
      <span class="report-filter-label">${reportEscape(label)}</span>
      <span class="report-filter-value">${reportEscape(value)}</span>
    </div>`).join("");

  const totalText = document.querySelector("#purchaseSummaryTotals")?.textContent?.trim() || "";
  const metaText = document.querySelector("#purchaseSummaryMeta")?.textContent?.trim() || `${cards.length} elementos`;
  const statusText = selectedOptionText("#filterPurchaseStatus", "Todos los estados")
    .replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const documentTitle = `Reporte_Compras_FabLab_${dateIso}${statusText ? `_${statusText}` : ""}`;
  const cardsHtml = cards.map(cloneCardForPdf).join("\n");
  const stylesHref = new URL("css/styles.css", window.location.href).href;

  reportWindow.document.open();
  reportWindow.document.write(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <base href="${reportEscape(document.baseURI)}">
  <title>${reportEscape(documentTitle)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
  <link rel="stylesheet" href="https://use.typekit.net/jov3nat.css">
  <link rel="stylesheet" href="${reportEscape(stylesHref)}">
  <style>
    @page { size: A4 landscape; margin: 9mm; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    html, body { background: #fff !important; }
    body { margin: 0; color: #171717; }
    .report-page { width: 100%; }
    .report-header {
      border-bottom: 3px solid #c8102e;
      margin-bottom: 6mm;
      padding-bottom: 4mm;
    }
    .report-kicker {
      color: #c8102e;
      font-size: 10pt;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    .report-title {
      margin: 1mm 0 2mm;
      font-size: 24pt;
      line-height: 1.08;
    }
    .report-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 3mm 8mm;
      color: #555;
      font-size: 9.5pt;
    }
    .report-summary {
      display: grid;
      grid-template-columns: 1fr 2fr;
      gap: 5mm;
      margin: 5mm 0;
      padding: 4mm;
      border: 1px solid #ddd;
      border-radius: 3mm;
      background: #fafafa;
    }
    .report-summary-total { font-size: 18pt; font-weight: 700; }
    .report-summary-meta { color: #555; font-size: 10pt; }
    .report-filters-title {
      margin: 0 0 2mm;
      font-size: 11pt;
      font-weight: 700;
    }
    .report-filter-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 2mm;
      margin-bottom: 6mm;
    }
    .report-filter {
      min-width: 0;
      padding: 2.2mm 2.8mm;
      border: 1px solid #ddd;
      border-radius: 2mm;
      background: #fff;
    }
    .report-filter-label {
      display: block;
      color: #666;
      font-size: 7.5pt;
      font-weight: 700;
      text-transform: uppercase;
    }
    .report-filter-value {
      display: block;
      margin-top: .5mm;
      font-size: 9pt;
      overflow-wrap: anywhere;
    }
    .report-items-title {
      margin: 0 0 3mm;
      font-size: 13pt;
      font-weight: 700;
    }
    .items-list { display: block !important; }
    .item-card {
      break-inside: avoid;
      page-break-inside: avoid;
      margin-bottom: 6mm !important;
      box-shadow: none !important;
    }
    .item-card .card-body { padding: 4mm !important; }
    .item-card .image-wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 3mm;
      background: #fff;
    }
    .item-card .item-image {
      width: 100%;
      max-height: 54mm;
      object-fit: contain;
    }
    .item-card h2, .item-card h3, .item-card .card-title { break-after: avoid; }
    .purchase-status-controls {
      margin-top: 3mm;
      padding: 3mm 4mm;
      border: 1px solid transparent;
      border-left-width: 2mm;
      border-radius: 2.5mm;
    }
    .purchase-state-missing { background: #f8d7da !important; border-color: #dc3545 !important; }
    .purchase-state-ordered { background: #fff3cd !important; border-color: #f0ad00 !important; }
    .purchase-state-complete { background: #d1e7dd !important; border-color: #198754 !important; }
    .purchase-priority-box {
      min-width: 36mm;
      padding: 2.5mm 3mm;
      border: 1px solid #dee2e6;
      border-radius: 2.5mm;
      background: #fff !important;
      text-align: right;
    }
    .purchase-priority-label {
      display: block;
      margin-bottom: 1mm;
      color: #6c757d;
      font-size: 7pt;
      font-weight: 700;
      text-transform: uppercase;
    }
    .priority-badge { font-size: 8pt; padding: 1.6mm 2.2mm; }
    .admin-card-actions,
    .purchase-send-btn,
    .purchase-cancel-btn,
    .purchase-received-btn,
    .file-download,
    .item-card button { display: none !important; }
    a.btn {
      text-decoration: none !important;
      white-space: nowrap;
    }
    .report-footer-note {
      margin-top: 4mm;
      color: #666;
      font-size: 8pt;
    }
    .report-print-toolbar {
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      padding: 10px;
      background: rgba(255,255,255,.96);
      border-bottom: 1px solid #ddd;
    }
    @media print {
      .no-print { display: none !important; }
      body { font-size: 9.5pt; }
      a[href] { text-decoration: none !important; }
    }
  </style>
</head>
<body>
  <div class="report-print-toolbar no-print">
    <button type="button" class="btn btn-dark" onclick="window.print()">Imprimir / Guardar como PDF</button>
    <button type="button" class="btn btn-outline-secondary" onclick="window.close()">Cerrar</button>
  </div>
  <main class="report-page">
    <header class="report-header">
      <div class="report-kicker">Universidad Iberoamericana Ciudad de México · FabLab</div>
      <h1 class="report-title">Reporte visual de compras</h1>
      <div class="report-meta">
        <span><strong>Generado:</strong> ${reportEscape(generatedAt)}</span>
        <span><strong>Elementos:</strong> ${cards.length}</span>
      </div>
    </header>

    <section class="report-summary">
      <div>
        <div class="report-filter-label">Presupuesto estimado</div>
        <div class="report-summary-total">${reportEscape(totalText)}</div>
      </div>
      <div>
        <div class="report-filter-label">Resumen del filtro</div>
        <div class="report-summary-meta">${reportEscape(metaText)}</div>
      </div>
    </section>

    <section>
      <h2 class="report-filters-title">Filtros aplicados en el inventario</h2>
      <div class="report-filter-grid">${filterHtml}</div>
    </section>

    <section>
      <h2 class="report-items-title">Elementos del reporte</h2>
      <div class="items-list">${cardsHtml}</div>
    </section>

    <div class="report-footer-note">
      Los botones “Más info” e “Info Compra” conservan sus hipervínculos en el PDF generado por el navegador.
    </div>
  </main>
  <script>
    window.addEventListener("load", async () => {
      const waits = Array.from(document.images).map(img => img.complete
        ? Promise.resolve()
        : new Promise(resolve => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          })
      );
      await Promise.all(waits);
      setTimeout(() => window.print(), 350);
    });
  <\/script>
</body>
</html>`);
  reportWindow.document.close();
}

function currentStatusFilter() {
  return document.querySelector("#filterPurchaseStatus")?.value || "all";
}

function currentPriorityFilter() {
  return document.querySelector("#filterPurchasePriority")?.value || "all";
}

function matchesExtraFilters(item) {
  const statusFilter = currentStatusFilter();
  const priorityFilter = currentPriorityFilter();

  if (statusFilter !== "all" && purchaseVisualState(item).key !== statusFilter) return false;
  if (priorityFilter !== "all" && String(itemPriority(item)) !== String(priorityFilter)) return false;
  return true;
}

function nativeCards() {
  return [...document.querySelectorAll("#itemsList .item-card[data-item-id]")];
}

function effectiveRows() {
  return nativeCards()
    .map(card => itemsById.get(card.dataset.itemId))
    .filter(Boolean)
    .filter(matchesExtraFilters);
}

function applyCardFiltersAndOrdering() {
  const cards = nativeCards();
  let visible = 0;

  cards.forEach(card => {
    const item = itemsById.get(card.dataset.itemId);
    const show = Boolean(item) && matchesExtraFilters(item);
    card.classList.toggle("d-none", !show);
    if (show) visible += 1;
  });

  const sort = document.querySelector("#sortMode")?.value || "zone";
  if (sort === "priority") {
    const container = document.querySelector("#itemsList");
    const sorted = [...cards].sort((a, b) => {
      const ia = itemsById.get(a.dataset.itemId);
      const ib = itemsById.get(b.dataset.itemId);
      return itemPriority(ia) - itemPriority(ib);
    });

    const currentIds = cards.map(c => c.dataset.itemId).join("|");
    const sortedIds = sorted.map(c => c.dataset.itemId).join("|");
    if (container && currentIds !== sortedIds) {
      sorted.forEach(card => container.appendChild(card));
    }
  }

  const resultCount = document.querySelector("#resultCount");
  if (resultCount) {
    resultCount.textContent = `${visible} resultado${visible === 1 ? "" : "s"}`;
  }
}

function formatCurrency(value, currency = "MXN") {
  const n = num(value);
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

function purchaseCategory(tipo) {
  const raw = String(tipo || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
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
  const code = currency || "MXN";
  totals[code] = num(totals[code]) + num(amount);
}

function formatMoneyTotals(totals) {
  const entries = Object.entries(totals || {}).sort(([a], [b]) => String(a).localeCompare(String(b), "es"));
  return entries.length
    ? entries.map(([currency, total]) => formatCurrencyWithCode(total, currency)).join(" · ")
    : formatCurrencyWithCode(0, "MXN");
}

function buildCategorySummary(rows) {
  const groups = new Map();
  PURCHASE_CATEGORIES.forEach((category, index) => groups.set(category, {
    category,
    sort: index,
    totals: {},
    qty: 0,
    items: 0,
  }));

  rows.forEach(item => {
    const category = purchaseCategory(item.tipo);
    const group = groups.get(category);
    const qty = quantityToBuy(item);
    const currency = item.moneda || "MXN";
    const subtotal = qty * num(item.precioUnitario);
    group.items += 1;
    group.qty += qty;
    addMoneyTotal(group.totals, currency, subtotal);
  });

  return [...groups.values()].sort((a, b) => a.sort - b.sort);
}

function buildBreakdown(rows) {
  const zoneMap = new Map();

  rows.forEach(item => {
    const zoneId = String(item.zoneId || "s/z");
    const subzoneId = String(item.subzoneId || "s/s");
    const category = purchaseCategory(item.tipo);
    const qty = quantityToBuy(item);
    const currency = item.moneda || "MXN";
    const subtotal = qty * num(item.precioUnitario);

    if (!zoneMap.has(zoneId)) {
      zoneMap.set(zoneId, {
        zoneId,
        zoneName: item.zoneName || "Sin zona",
        totals: {},
        qty: 0,
        items: 0,
        subzones: new Map(),
      });
    }
    const zone = zoneMap.get(zoneId);

    if (!zone.subzones.has(subzoneId)) {
      zone.subzones.set(subzoneId, {
        subzoneId,
        subzoneName: item.subzoneName || "Sin subzona",
        totals: {},
        qty: 0,
        items: 0,
        categories: new Map(),
      });
    }
    const subzone = zone.subzones.get(subzoneId);

    if (!subzone.categories.has(category)) {
      subzone.categories.set(category, {
        category,
        totals: {},
        qty: 0,
        items: 0,
      });
    }
    const cat = subzone.categories.get(category);

    [zone, subzone, cat].forEach(group => {
      group.items += 1;
      group.qty += qty;
      addMoneyTotal(group.totals, currency, subtotal);
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
          categories: [...subzone.categories.values()].sort((a, b) =>
            PURCHASE_CATEGORIES.indexOf(a.category) - PURCHASE_CATEGORIES.indexOf(b.category)
          ),
        })),
    }));
}

function recalculateSummaryAndReport() {
  const rows = effectiveRows();
  const totalsEl = document.querySelector("#purchaseSummaryTotals");
  const metaEl = document.querySelector("#purchaseSummaryMeta");

  const totals = {};
  let totalQty = 0;
  rows.forEach(item => {
    const qty = quantityToBuy(item);
    totalQty += qty;
    addMoneyTotal(totals, item.moneda || "MXN", qty * num(item.precioUnitario));
  });

  if (totalsEl) totalsEl.textContent = formatMoneyTotals(totals);
  if (metaEl) {
    metaEl.textContent = `${rows.length} elemento${rows.length === 1 ? "" : "s"} en el filtro · ${totalQty} pieza${totalQty === 1 ? "" : "s"} sugerida${totalQty === 1 ? "" : "s"} a comprar`;
  }

  const report = document.querySelector("#purchaseBreakdownReport");
  if (!report) return;

  if (!rows.length) {
    report.innerHTML = '<p class="purchase-report-empty">No hay elementos dentro del filtro actual.</p>';
    return;
  }

  const categories = buildCategorySummary(rows);
  const breakdown = buildBreakdown(rows);

  report.innerHTML = `
    <div class="purchase-category-summary" aria-label="Totales por categoría">
      ${categories.map(cat => `
        <div class="purchase-category-summary-card">
          <div class="purchase-category-summary-label">${cat.category}</div>
          <div class="purchase-category-summary-total">${formatMoneyTotals(cat.totals)}</div>
          <div class="purchase-category-summary-meta">${cat.items} item${cat.items === 1 ? "" : "s"} · ${cat.qty} pieza${cat.qty === 1 ? "" : "s"} sugerida${cat.qty === 1 ? "" : "s"}</div>
        </div>`).join("")}
    </div>
    <div class="purchase-report-grid">
      ${breakdown.map(zone => `
        <section class="purchase-zone-report">
          <div class="purchase-zone-header">
            <h3 class="purchase-zone-title">Zona ${zone.zoneId} · ${zone.zoneName}</h3>
            <div class="purchase-zone-total">${formatMoneyTotals(zone.totals)}</div>
          </div>
          <div class="purchase-subzone-list">
            ${zone.subzones.map(subzone => `
              <div class="purchase-subzone-report">
                <div class="purchase-subzone-header">
                  <div class="purchase-subzone-title">Subzona ${subzone.subzoneId} · ${subzone.subzoneName}</div>
                  <div class="purchase-subzone-total">${formatMoneyTotals(subzone.totals)}</div>
                </div>
                <div class="purchase-category-table">
                  ${subzone.categories.map(cat => `
                    <div class="purchase-category-row">
                      <div>
                        <div class="purchase-category-name">${cat.category}</div>
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

function queueEnhancements() {
  if (enhancementQueued) {
    enhancementRerunRequested = true;
    return;
  }

  enhancementQueued = true;
  enhancementRerunRequested = false;
  const cards = nativeCards();
  let index = 0;
  const batchSize = 80;

  // Procesamos las tarjetas en lotes para no bloquear el hilo principal.
  // Esto mantiene la página interactiva incluso con más de 2,000 elementos.
  const processBatch = () => {
    const end = Math.min(index + batchSize, cards.length);
    for (; index < end; index += 1) {
      decorateCard(cards[index]);
    }

    if (index < cards.length) {
      requestAnimationFrame(processBatch);
      return;
    }

    applyCardFiltersAndOrdering();
    recalculateSummaryAndReport();
    updateBulkPurchaseToolbar();
    enhancementQueued = false;

    // Si hubo un cambio mientras procesábamos (por ejemplo, un filtro),
    // hacemos una última pasada con el estado más reciente.
    if (enhancementRerunRequested) {
      enhancementRerunRequested = false;
      queueEnhancements();
    }
  };

  requestAnimationFrame(processBatch);
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

function requestStatusLabel(status) {
  const labels = {
    [REQUEST_STATUS_DRAFT]: "Borrador",
    [REQUEST_STATUS_SENT]: "Enviada",
    [REQUEST_STATUS_PARTIAL]: "Parcial",
    [REQUEST_STATUS_COMPLETED]: "Completa",
    [REQUEST_STATUS_CANCELLED]: "Cancelada",
  };
  return labels[status] || status || "Sin estado";
}

function requestStatusBadgeClass(status) {
  if (status === REQUEST_STATUS_DRAFT) return "text-bg-dark";
  if (status === REQUEST_STATUS_SENT) return "text-bg-warning";
  if (status === REQUEST_STATUS_PARTIAL) return "text-bg-info";
  if (status === REQUEST_STATUS_COMPLETED) return "text-bg-success";
  if (status === REQUEST_STATUS_CANCELLED) return "text-bg-secondary";
  return "text-bg-secondary";
}

function requestDateValue(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function requestDateText(value) {
  const date = requestDateValue(value);
  return date ? date.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" }) : "";
}

function linePendingQty(line) {
  return Math.max(
    num(line?.quantityRequested) - num(line?.quantityReceived) - num(line?.quantityCancelled),
    0
  );
}

function normalizePendingRefs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(ref => ({
      requestId: String(ref?.requestId || ""),
      lineId: String(ref?.lineId || ref?.itemId || ""),
      folio: String(ref?.folio || ""),
      pendingQty: Math.max(num(ref?.pendingQty), 0),
    }))
    .filter(ref => ref.requestId && ref.lineId && ref.pendingQty > 0);
}

function snapshotLineFromItem(item, quantityRequested) {
  const qty = Math.max(num(quantityRequested), 0);
  return {
    itemId: item.id,
    sku: item.sku || "",
    nombre: item.nombre || "",
    descripcion: item.descripcion || "",
    tipo: item.tipo || "",
    zoneId: item.zoneId || "",
    zoneName: item.zoneName || "",
    subzoneId: item.subzoneId || "",
    subzoneName: item.subzoneName || "",
    locationId: item.locationId || "",
    locationName: item.locationName || "",
    locationCode: item.locationCode || item.areaCode || "",
    inventarioDeseadoSnapshot: num(item.inventarioDeseado),
    inventorySnapshot: currentInventory(item),
    pendingSnapshot: pendingPurchaseQty(item),
    quantityRequested: qty,
    quantityReceived: 0,
    quantityCancelled: 0,
    actualCostTotal: 0,
    unitPrice: num(item.precioUnitario),
    currency: item.moneda || "MXN",
    infoUrl: item.infoUrl || "",
    purchaseUrl: item.purchaseUrl || "",
    imageFileId: item.imageFileId || "",
    priority: itemPriority(item),
    status: REQUEST_STATUS_DRAFT,
    updatedAt: serverTimestamp(),
  };
}

const REQUEST_SORT_OPTIONS = [
  ["zone", "Zona / subzona"],
  ["nombre", "Nombre (alfabético)"],
  ["sku", "SKU"],
  ["tipo", "Tipo (alfabético)"],
  ["precio_desc", "Precio más alto"],
  ["precio_asc", "Precio más bajo"],
  ["priority", "Prioridad (1 → 3)"],
];

function requestSortLabel(mode) {
  return REQUEST_SORT_OPTIONS.find(([value]) => value === mode)?.[1] || "Zona / subzona";
}

function requestSortModeFromLabel(label) {
  const normalized = String(label || "").trim().toLocaleLowerCase("es");
  return REQUEST_SORT_OPTIONS.find(([, text]) => text.toLocaleLowerCase("es") === normalized)?.[0] || "zone";
}

function requestSortModeForRequest(request) {
  if (!request || request.id === currentDraftRequest?.id) return draftRequestSortMode;
  const snapshot = Array.isArray(request.filtersSnapshot) ? request.filtersSnapshot : [];
  const saved = snapshot.find(filter => String(filter?.label || "").toLocaleLowerCase("es") === "orden de solicitud");
  return saved ? requestSortModeFromLabel(saved.value) : "zone";
}

function compareRequestLines(a, b, mode = "zone") {
  const text = value => String(value || "");
  const locale = (left, right, numeric = false) =>
    text(left).localeCompare(text(right), "es", { numeric, sensitivity: "base" });
  const fallback = () => locale(a.sku, b.sku, true) || locale(a.nombre, b.nombre);

  if (mode === "nombre") return locale(a.nombre, b.nombre) || fallback();
  if (mode === "sku") return locale(a.sku, b.sku, true) || locale(a.nombre, b.nombre);
  if (mode === "tipo") return locale(a.tipo, b.tipo) || locale(a.nombre, b.nombre) || fallback();
  if (mode === "precio_desc") return num(b.unitPrice ?? b.precioUnitario) - num(a.unitPrice ?? a.precioUnitario) || fallback();
  if (mode === "precio_asc") return num(a.unitPrice ?? a.precioUnitario) - num(b.unitPrice ?? b.precioUnitario) || fallback();
  if (mode === "priority") return (num(a.priority ?? a.purchasePriority) || 3) - (num(b.priority ?? b.purchasePriority) || 3) || locale(a.nombre, b.nombre) || fallback();

  return locale(a.zoneId, b.zoneId, true)
    || locale(a.subzoneId, b.subzoneId, true)
    || locale(a.locationCode || a.locationId, b.locationCode || b.locationId, true)
    || fallback();
}

function sortRequestLines(lines, mode = draftRequestSortMode) {
  return [...(lines || [])].sort((a, b) => compareRequestLines(a, b, mode));
}

function filtersSnapshotForRequest() {
  const filters = appliedFiltersForReport()
    .filter(([label]) => String(label || "").toLocaleLowerCase("es") !== "orden de solicitud")
    .map(([label, value]) => ({
      label: String(label || ""),
      value: String(value || ""),
    }));

  filters.push({
    label: "Orden de solicitud",
    value: requestSortLabel(draftRequestSortMode),
  });
  return filters;
}

function draftLinesArray() {
  return sortRequestLines([...draftLinesByItemId.values()], draftRequestSortMode);
}

function totalsForLines(lines, quantityField = "quantityRequested") {
  const totals = {};
  let quantity = 0;
  for (const line of lines) {
    const qty = Math.max(num(line?.[quantityField]), 0);
    quantity += qty;
    addMoneyTotal(totals, line.currency || line.moneda || "MXN", qty * num(line.unitPrice ?? line.precioUnitario));
  }
  return { totals, quantity };
}

async function loadPurchaseRequests() {
  const snapshot = await getDocs(collection(db, "purchaseRequests"));
  purchaseRequestsById.clear();
  snapshot.docs.forEach(requestDoc => {
    purchaseRequestsById.set(requestDoc.id, { id: requestDoc.id, ...requestDoc.data() });
  });
}

async function loadDraftLines(requestId) {
  draftLinesByItemId.clear();
  if (!requestId) return;
  const snapshot = await getDocs(collection(db, "purchaseRequests", requestId, "items"));
  snapshot.docs.forEach(lineDoc => {
    const line = { id: lineDoc.id, ...lineDoc.data() };
    draftLinesByItemId.set(String(line.itemId || lineDoc.id), line);
  });
}

async function loadCurrentDraft() {
  const drafts = [...purchaseRequestsById.values()]
    .filter(request =>
      request.status === REQUEST_STATUS_DRAFT &&
      String(request.createdBy || "") === String(currentUser?.uid || "")
    )
    .sort((a, b) => {
      const da = requestDateValue(a.updatedAt || a.createdAt)?.getTime() || 0;
      const dbv = requestDateValue(b.updatedAt || b.createdAt)?.getTime() || 0;
      return dbv - da;
    });

  currentDraftRequest = drafts[0] || null;
  await loadDraftLines(currentDraftRequest?.id || "");

  const draftKey = currentDraftRequest?.id ? `purchaseDraftSort:${currentDraftRequest.id}` : "purchaseDraftSort:new";
  const savedMode = localStorage.getItem(draftKey);
  const mainSortMode = document.querySelector("#sortMode")?.value || "zone";
  draftRequestSortMode = REQUEST_SORT_OPTIONS.some(([value]) => value === savedMode)
    ? savedMode
    : (REQUEST_SORT_OPTIONS.some(([value]) => value === mainSortMode) ? mainSortMode : "zone");
}

async function ensureDraftRequest() {
  if (currentDraftRequest?.id) return currentDraftRequest;

  const ref = await addDoc(collection(db, "purchaseRequests"), {
    status: REQUEST_STATUS_DRAFT,
    folio: "",
    createdBy: currentUser.uid,
    createdByName: currentProfile?.nombre || currentUser.email || "",
    createdByEmail: currentProfile?.correo || currentUser.email || "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    itemCount: 0,
    totalQty: 0,
    totalsByCurrency: {},
  });

  currentDraftRequest = {
    id: ref.id,
    status: REQUEST_STATUS_DRAFT,
    folio: "",
    createdBy: currentUser.uid,
    createdByName: currentProfile?.nombre || currentUser.email || "",
  };
  purchaseRequestsById.set(ref.id, currentDraftRequest);
  localStorage.setItem(`purchaseDraftSort:${ref.id}`, draftRequestSortMode);
  return currentDraftRequest;
}

async function syncDraftRequestSummary() {
  if (!currentDraftRequest?.id) return;
  const lines = draftLinesArray();
  const { totals, quantity } = totalsForLines(lines);
  await updateDoc(doc(db, "purchaseRequests", currentDraftRequest.id), {
    itemCount: lines.length,
    totalQty: quantity,
    totalsByCurrency: totals,
    updatedAt: serverTimestamp(),
  });
  currentDraftRequest = {
    ...currentDraftRequest,
    itemCount: lines.length,
    totalQty: quantity,
    totalsByCurrency: totals,
  };
  purchaseRequestsById.set(currentDraftRequest.id, currentDraftRequest);
}

function ensureQuantityModal() {
  if (document.querySelector("#purchaseQuantityModal")) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <div class="modal fade" id="purchaseQuantityModal" tabindex="-1" aria-hidden="true">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="purchaseQuantityTitle">Cantidad</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <p id="purchaseQuantityMessage" class="mb-3"></p>
            <label class="form-label" for="purchaseQuantityInput">Cantidad</label>
            <input id="purchaseQuantityInput" class="form-control request-quantity-input" type="number" min="0" step="1">
            <div id="purchaseQuantityHelp" class="form-text"></div>
            <div id="purchaseQuantityCostGroup" class="mt-3 d-none">
              <label class="form-label" for="purchaseQuantityCostInput">Costo unitario real</label>
              <div class="input-group">
                <span class="input-group-text" id="purchaseQuantityCurrency">MXN</span>
                <input id="purchaseQuantityCostInput" class="form-control" type="number" min="0" step="0.01">
              </div>
              <div id="purchaseQuantityCostHelp" class="form-text"></div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancelar</button>
            <button type="button" class="btn btn-dark" id="purchaseQuantitySave">Guardar</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrapper.firstElementChild);
}

async function askQuantity({ title, message, max, value, allowZero = true, includeCost = false, costValue = 0, costEditable = false, currency = "MXN" }) {
  ensureQuantityModal();

  const modalEl = document.querySelector("#purchaseQuantityModal");
  const titleEl = document.querySelector("#purchaseQuantityTitle");
  const messageEl = document.querySelector("#purchaseQuantityMessage");
  const input = document.querySelector("#purchaseQuantityInput");
  const help = document.querySelector("#purchaseQuantityHelp");
  const save = document.querySelector("#purchaseQuantitySave");
  const costGroup = document.querySelector("#purchaseQuantityCostGroup");
  const costInput = document.querySelector("#purchaseQuantityCostInput");
  const costCurrency = document.querySelector("#purchaseQuantityCurrency");
  const costHelp = document.querySelector("#purchaseQuantityCostHelp");

  titleEl.textContent = title || "Cantidad";
  messageEl.textContent = message || "";
  input.min = allowZero ? "0" : "1";
  input.max = String(Math.max(num(max), allowZero ? 0 : 1));
  input.value = String(Math.max(num(value), allowZero ? 0 : 1));
  help.textContent = `Máximo permitido: ${Math.max(num(max), 0)}.`;
  costGroup?.classList.toggle("d-none", !includeCost);
  if (includeCost && costInput) {
    costInput.value = String(Math.max(num(costValue), 0));
    costInput.disabled = !costEditable;
    if (costCurrency) costCurrency.textContent = String(currency || "MXN").toUpperCase();
    if (costHelp) {
      costHelp.textContent = costEditable
        ? "Por defecto se usa el costo esperado. Ajústalo si la factura fue diferente."
        : "El Supervisor registra la recepción con el costo esperado; sólo el Administrador puede ajustar el costo real.";
    }
  }

  // Bootstrap 5 no maneja bien dos modales abiertos a la vez. Si el cuadro
  // de cantidad se invoca desde el detalle de una solicitud, ocultamos
  // temporalmente ese modal y lo restauramos al cerrar el de cantidad.
  const parentModalEl = [...document.querySelectorAll(".modal.show")]
    .find(element => element.id !== "purchaseQuantityModal");
  const parentModal = parentModalEl
    ? bootstrap.Modal.getOrCreateInstance(parentModalEl)
    : null;
  const parentBody = parentModalEl?.querySelector(".modal-body");
  const parentScrollTop = parentBody?.scrollTop || 0;

  if (parentModalEl && parentModal) {
    await new Promise(resolve => {
      parentModalEl.addEventListener("hidden.bs.modal", resolve, { once: true });
      parentModal.hide();
    });
  }

  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);

  return new Promise(resolve => {
    let result = null;
    let settled = false;

    const cleanup = () => {
      save.removeEventListener("click", onSave);
      modalEl.removeEventListener("hidden.bs.modal", onHidden);
    };

    const restoreParentModal = () => {
      if (!parentModalEl || !parentModal) return;
      parentModalEl.addEventListener("shown.bs.modal", () => {
        const restoredBody = parentModalEl.querySelector(".modal-body");
        if (restoredBody) restoredBody.scrollTop = parentScrollTop;
      }, { once: true });
      parentModal.show();
    };

    const onHidden = () => {
      if (settled) return;
      settled = true;
      cleanup();
      restoreParentModal();
      resolve(result);
    };

    const onSave = () => {
      const qty = Number(input.value);
      const min = allowZero ? 0 : 1;
      const maximum = Math.max(num(max), 0);
      if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < min || qty > maximum) {
        alert(`Captura una cantidad entera entre ${min} y ${maximum}.`);
        return;
      }
      if (includeCost) {
        const unitCost = Number(costInput?.value);
        if (!Number.isFinite(unitCost) || unitCost < 0) {
          alert("Captura un costo unitario real válido, mayor o igual a cero.");
          return;
        }
        result = { quantity: qty, unitCost };
      } else {
        result = qty;
      }
      modal.hide();
    };

    save.addEventListener("click", onSave);
    modalEl.addEventListener("hidden.bs.modal", onHidden);
    modal.show();
    setTimeout(() => input.select(), 150);
  });
}

async function addOrEditDraftItem(itemId) {
  const item = itemsById.get(String(itemId)) || await fetchLiveItem(itemId);
  const existingQty = draftQtyForItem(itemId);
  const maxQty = requestCapacity(item);

  if (maxQty <= 0 && existingQty <= 0) {
    alert("Todo lo faltante de este artículo ya está cubierto por solicitudes activas.");
    return;
  }

  const qty = await askQuantity({
    title: existingQty > 0 ? "Editar cantidad del borrador" : "Agregar a solicitud",
    message: `${item.nombre || item.sku || "Item"}\nDisponible para esta solicitud: ${maxQty}. Puedes solicitar una cantidad menor.`,
    max: maxQty,
    value: existingQty > 0 ? existingQty : Math.max(maxQty, 1),
    allowZero: true,
  });
  if (qty === null) return;

  const request = await ensureDraftRequest();
  const lineRef = doc(db, "purchaseRequests", request.id, "items", item.id);

  if (qty === 0) {
    await deleteDoc(lineRef);
    draftLinesByItemId.delete(String(item.id));
  } else {
    const existing = draftLinesByItemId.get(String(item.id));
    await setDoc(lineRef, {
      ...snapshotLineFromItem(item, qty),
      addedAt: existing?.addedAt || serverTimestamp(),
    }, { merge: true });
    draftLinesByItemId.set(String(item.id), {
      ...(existing || {}),
      ...snapshotLineFromItem(item, qty),
      itemId: item.id,
      quantityRequested: qty,
      addedAt: existing?.addedAt || new Date(),
    });
  }

  await syncDraftRequestSummary();
  renderPurchaseRequestManager();
  queueEnhancements();
}

async function emptyCurrentDraft() {
  if (!currentDraftRequest?.id || !draftLinesByItemId.size) return;
  if (!confirm("¿Vaciar todos los elementos del borrador actual?")) return;

  const deletions = [...draftLinesByItemId.values()].map(line =>
    deleteDoc(doc(db, "purchaseRequests", currentDraftRequest.id, "items", String(line.itemId || line.id)))
  );
  await Promise.all(deletions);
  draftLinesByItemId.clear();
  await syncDraftRequestSummary();
  renderPurchaseRequestManager();
  queueEnhancements();
}

function requestHistoryArray() {
  return [...purchaseRequestsById.values()]
    .filter(request => request.status !== REQUEST_STATUS_DRAFT)
    .sort((a, b) => {
      const da = requestDateValue(a.sentAt || a.createdAt)?.getTime() || 0;
      const dbv = requestDateValue(b.sentAt || b.createdAt)?.getTime() || 0;
      return dbv - da;
    });
}

function updatePurchaseRequestLauncher() {
  const countBadge = document.querySelector("#purchaseRequestLauncherCount");
  const draftBadge = document.querySelector("#purchaseRequestLauncherDraft");
  const historyCount = requestHistoryArray().length;
  const draftCount = draftLinesByItemId.size;

  if (countBadge) {
    countBadge.textContent = String(historyCount);
    countBadge.title = `${historyCount} solicitud${historyCount === 1 ? "" : "es"} en el historial`;
  }

  if (draftBadge) {
    draftBadge.classList.toggle("d-none", draftCount <= 0);
    draftBadge.textContent = draftCount > 0
      ? `Borrador: ${draftCount}`
      : "";
  }
}

function injectPurchaseRequestManager() {
  if (document.querySelector("#purchaseRequestManager")) {
    updatePurchaseRequestLauncher();
    return;
  }

  const heroLead = document.querySelector(".inventory-hero .inventory-lead");
  const heroColumn = heroLead?.parentElement;
  if (!heroLead || !heroColumn) return;

  // Solicitudes de compra no depende de los filtros. El acceso vive dentro
  // del hero, debajo de la descripción, aprovechando el espacio libre que
  // deja el título grande de Compras FabLab sin aumentar la altura del área
  // de trabajo ni desplazar el bloque de filtros.
  let launcher = document.querySelector("#purchaseRequestLauncher");
  if (!launcher) {
    launcher = document.createElement("div");
    launcher.id = "purchaseRequestLauncher";
    launcher.className = "purchase-request-launcher";
    launcher.innerHTML = `
      <button type="button" class="btn btn-dark" data-bs-toggle="offcanvas" data-bs-target="#purchaseRequestsPanel" aria-controls="purchaseRequestsPanel">
        <span>Solicitudes de compra</span>
        <span id="purchaseRequestLauncherDraft" class="badge rounded-pill text-bg-warning d-none"></span>
        <span id="purchaseRequestLauncherCount" class="badge rounded-pill text-bg-light text-dark">0</span>
      </button>`;
    heroColumn.appendChild(launcher);
  }

  let panel = document.querySelector("#purchaseRequestsPanel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "purchaseRequestsPanel";
    panel.className = "offcanvas offcanvas-top purchase-requests-offcanvas";
    panel.tabIndex = -1;
    panel.setAttribute("aria-labelledby", "purchaseRequestsPanelLabel");
    panel.innerHTML = `
      <div class="offcanvas-header">
        <div>
          <h2 class="offcanvas-title h4 mb-1" id="purchaseRequestsPanelLabel">Solicitudes de compra</h2>
          <div class="text-muted small">Borrador actual, historial, recepciones y cancelaciones.</div>
        </div>
        <button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="Cerrar"></button>
      </div>
      <div class="offcanvas-body" id="purchaseRequestsPanelBody"></div>`;
    document.body.appendChild(panel);
  }

  const panelBody = panel.querySelector("#purchaseRequestsPanelBody");
  if (!panelBody) return;

  const section = document.createElement("section");
  section.id = "purchaseRequestManager";
  section.className = "purchase-request-manager";
  section.innerHTML = `
    <div class="d-flex flex-wrap justify-content-end gap-2 mb-3">
      <button type="button" class="btn btn-outline-dark btn-sm" id="refreshPurchaseRequests">Actualizar solicitudes</button>
    </div>
    <div id="currentDraftPanel"></div>
    <hr class="my-4">
    <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
      <h3 class="h6 mb-0">Historial de solicitudes</h3>
      <span class="small text-muted" id="purchaseRequestHistoryCount"></span>
    </div>
    <div id="purchaseRequestHistory"></div>`;
  panelBody.appendChild(section);

  updatePurchaseRequestLauncher();
}

function renderPurchaseRequestManager() {
  injectPurchaseRequestManager();
  injectBudgetManager();

  const draftPanel = document.querySelector("#currentDraftPanel");
  const history = document.querySelector("#purchaseRequestHistory");
  const count = document.querySelector("#purchaseRequestHistoryCount");
  if (!draftPanel || !history) return;

  const draftLines = draftLinesArray();
  const { totals, quantity } = totalsForLines(draftLines);

  if (!currentDraftRequest || !draftLines.length) {
    draftPanel.innerHTML = `
      <div class="draft-request-card p-3">
        <div class="fw-semibold">Solicitud actual · Borrador</div>
        <div class="draft-request-empty">Todavía no hay elementos en el borrador. Usa “Agregar a solicitud” en las tarjetas.</div>
      </div>`;
  } else {
    draftPanel.innerHTML = `
      <div class="draft-request-card p-3">
        <div class="d-flex flex-wrap justify-content-between gap-3 align-items-start">
          <div>
            <div class="fw-semibold">Solicitud actual · Borrador</div>
            <div class="small text-muted">${draftLines.length} artículo${draftLines.length === 1 ? "" : "s"} · ${quantity} pieza${quantity === 1 ? "" : "s"} · ${reportEscape(formatMoneyTotals(totals))}</div>
          </div>
          <div class="d-flex flex-wrap gap-2 align-items-end justify-content-end">
            <div class="request-draft-sort">
              <label class="form-label small mb-1" for="requestDraftSortMode">Ordenar solicitud</label>
              <select id="requestDraftSortMode" class="form-select form-select-sm">
                ${REQUEST_SORT_OPTIONS.map(([value, label]) => `<option value="${value}" ${draftRequestSortMode === value ? "selected" : ""}>${reportEscape(label)}</option>`).join("")}
              </select>
            </div>
            <button type="button" class="btn btn-outline-danger btn-sm request-draft-pdf">PDF borrador</button>
            <button type="button" class="btn btn-outline-success btn-sm request-draft-xlsx">Excel borrador</button>
            <button type="button" class="btn btn-outline-secondary btn-sm request-draft-empty">Vaciar</button>
            <button type="button" class="btn btn-dark btn-sm request-draft-send">Enviar solicitud a Compras</button>
          </div>
        </div>
        <div class="mt-3">
          ${draftLines.map(line => `
            <div class="d-flex flex-wrap justify-content-between gap-2 border-top py-2">
              <div>
                <strong>${reportEscape(line.nombre || line.sku || "Item")}</strong>
                <span class="text-muted ms-2">${reportEscape(line.sku || "")}</span>
              </div>
              <div>
                <span class="badge text-bg-dark">${pluralPieces(line.quantityRequested)}</span>
                <button type="button" class="btn btn-link btn-sm request-draft-edit" data-item-id="${reportEscape(line.itemId)}">Editar</button>
              </div>
            </div>`).join("")}
        </div>
      </div>`;
  }

  const requests = requestHistoryArray();
  if (count) count.textContent = `${requests.length} solicitud${requests.length === 1 ? "" : "es"}`;
  updatePurchaseRequestLauncher();

  if (!requests.length) {
    history.innerHTML = `<div class="text-muted small">Aún no hay solicitudes enviadas.</div>`;
    return;
  }

  history.innerHTML = `
    <div class="table-responsive">
      <table class="table table-sm request-history-table">
        <thead>
          <tr>
            <th>Solicitud</th>
            <th>Fecha</th>
            <th>Estado</th>
            <th>Artículos</th>
            <th>Piezas</th>
            <th>Total</th>
            <th class="text-end">Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${requests.map(request => `
            <tr>
              <td><strong>${reportEscape(request.folio || request.id)}</strong></td>
              <td>${reportEscape(requestDateText(request.sentAt || request.createdAt))}</td>
              <td><span class="badge request-status-badge ${requestStatusBadgeClass(request.status)}">${reportEscape(requestStatusLabel(request.status))}</span></td>
              <td>${num(request.itemCount)}</td>
              <td>${num(request.totalQty)}</td>
              <td>${reportEscape(formatMoneyTotals(request.totalsByCurrency || {}))}</td>
              <td class="text-end">
                <div class="d-flex flex-wrap gap-1 justify-content-end">
                  <button type="button" class="btn btn-outline-dark btn-sm request-history-view" data-request-id="${request.id}">Ver</button>
                  <button type="button" class="btn btn-outline-danger btn-sm request-history-pdf" data-request-id="${request.id}">PDF</button>
                  <button type="button" class="btn btn-outline-success btn-sm request-history-xlsx" data-request-id="${request.id}">Excel</button>
                  ${[REQUEST_STATUS_SENT, REQUEST_STATUS_PARTIAL].includes(request.status) ? `<button type="button" class="btn btn-dark btn-sm request-history-cancel" data-request-id="${request.id}">${request.status === REQUEST_STATUS_SENT ? "Cancelar solicitud" : "Cancelar pendientes"}</button>` : ""}
                </div>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

async function fetchRequestLines(requestId) {
  const snapshot = await getDocs(collection(db, "purchaseRequests", requestId, "items"));
  return snapshot.docs.map(lineDoc => ({ id: lineDoc.id, ...lineDoc.data() }));
}

function calculateRequestStatus(lines) {
  let pending = 0;
  let received = 0;
  let cancelled = 0;
  for (const line of lines) {
    pending += linePendingQty(line);
    received += num(line.quantityReceived);
    cancelled += num(line.quantityCancelled);
  }

  if (pending > 0 && (received > 0 || cancelled > 0)) return REQUEST_STATUS_PARTIAL;
  if (pending > 0) return REQUEST_STATUS_SENT;
  if (received > 0) return REQUEST_STATUS_COMPLETED;
  return REQUEST_STATUS_CANCELLED;
}

async function refreshRequestAggregate(requestId) {
  const lines = await fetchRequestLines(requestId);
  const status = calculateRequestStatus(lines);
  const { totals, quantity } = totalsForLines(lines);
  await updateDoc(doc(db, "purchaseRequests", requestId), {
    status,
    itemCount: lines.length,
    totalQty: quantity,
    totalsByCurrency: totals,
    updatedAt: serverTimestamp(),
  });
  return { lines, status };
}

async function sendCurrentDraft() {
  if (purchaseUiBusy) return;
  const lines = draftLinesArray();
  if (!currentDraftRequest?.id || !lines.length) {
    alert("Agrega al menos un artículo al borrador antes de enviar la solicitud.");
    return;
  }

  const budgetValidation = await validateDraftBudget(lines);
  if (!budgetValidation.ok) {
    alert(`No se puede enviar la solicitud por presupuesto:\n\n${budgetValidation.message}\n\nAbre “Presupuestos” y asigna o incrementa el presupuesto de las zonas indicadas.`);
    return;
  }

  const ok = confirm(
    `¿Enviar esta solicitud a Compras?\n\n${lines.length} artículo${lines.length === 1 ? "" : "s"} · ${lines.reduce((sum, line) => sum + num(line.quantityRequested), 0)} piezas.\n\nPresupuesto validado. Una vez enviada, estas cantidades se contabilizarán como comprometidas y pendientes de recibir.`
  );
  if (!ok) return;

  purchaseUiBusy = true;
  try {
    const year = new Date().getFullYear();
    const requestRef = doc(db, "purchaseRequests", currentDraftRequest.id);
    const counterRef = doc(db, "purchaseRequestCounters", String(year));
    let generatedFolio = "";

    await runTransaction(db, async transaction => {
      const counterSnap = await transaction.get(counterRef);
      const requestSnap = await transaction.get(requestRef);
      if (!requestSnap.exists() || requestSnap.data().status !== REQUEST_STATUS_DRAFT) {
        throw new Error("El borrador ya no está disponible para enviarse.");
      }

      const itemSnapshots = [];
      for (const line of lines) {
        const itemRef = doc(db, "items", String(line.itemId));
        const itemSnap = await transaction.get(itemRef);
        if (!itemSnap.exists()) throw new Error(`Ya no existe el item ${line.sku || line.itemId}.`);
        itemSnapshots.push({ line, itemRef, itemSnap });
      }

      const next = num(counterSnap.data()?.last) + 1;
      generatedFolio = `SC-${year}-${String(next).padStart(4, "0")}`;

      for (const entry of itemSnapshots) {
        const item = { id: entry.itemSnap.id, ...entry.itemSnap.data() };
        const available = Math.max(
          num(item.inventarioDeseado) - currentInventory(item) - pendingPurchaseQty(item),
          0
        );
        if (num(entry.line.quantityRequested) > available) {
          throw new Error(
            `${item.nombre || item.sku}: el borrador solicita ${entry.line.quantityRequested}, pero ahora sólo hay ${available} disponibles para solicitar. Ajusta la cantidad.`
          );
        }
      }

      transaction.set(counterRef, { last: next, updatedAt: serverTimestamp() }, { merge: true });

      const { totals, quantity } = totalsForLines(lines);
      transaction.update(requestRef, {
        folio: generatedFolio,
        status: REQUEST_STATUS_SENT,
        sentAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        filtersSnapshot: filtersSnapshotForRequest(),
        itemCount: lines.length,
        totalQty: quantity,
        totalsByCurrency: totals,
      });

      for (const entry of itemSnapshots) {
        const line = entry.line;
        const item = { id: entry.itemSnap.id, ...entry.itemSnap.data() };
        const qty = num(line.quantityRequested);
        const refs = normalizePendingRefs(item.purchasePendingRefs)
          .filter(ref => ref.requestId !== currentDraftRequest.id);

        refs.push({
          requestId: currentDraftRequest.id,
          lineId: String(line.itemId),
          folio: generatedFolio,
          pendingQty: qty,
        });

        transaction.update(entry.itemRef, {
          purchasePendingQty: pendingPurchaseQty(item) + qty,
          purchasePendingRefs: refs,
          updatedAt: serverTimestamp(),
        });

        transaction.update(
          doc(db, "purchaseRequests", currentDraftRequest.id, "items", String(line.itemId)),
          {
            status: PURCHASE_STATUS_ORDERED,
            folio: generatedFolio,
            sentAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }
        );
      }
    });

    const sentDraftId = currentDraftRequest?.id || "";
    if (sentDraftId) localStorage.removeItem(`purchaseDraftSort:${sentDraftId}`);
    currentDraftRequest = null;
    draftLinesByItemId.clear();
    draftRequestSortMode = document.querySelector("#sortMode")?.value || "zone";
    await Promise.all([loadPurchaseItems(), loadPurchaseRequests()]);
    await loadCurrentDraft();
    renderPurchaseRequestManager();
    queueEnhancements();
    alert(`Solicitud ${generatedFolio} enviada correctamente.`);
  } catch (error) {
    console.error(error);
    alert(`No se pudo enviar la solicitud: ${error.message}`);
  } finally {
    purchaseUiBusy = false;
  }
}

function ensureRequestDetailModal() {
  if (document.querySelector("#purchaseRequestDetailModal")) return;
  const modal = document.createElement("div");
  modal.className = "modal fade";
  modal.id = "purchaseRequestDetailModal";
  modal.tabIndex = -1;
  modal.innerHTML = `
    <div class="modal-dialog modal-xl modal-dialog-scrollable">
      <div class="modal-content">
        <div class="modal-header">
          <div>
            <h5 class="modal-title mb-0" id="purchaseRequestDetailTitle">Solicitud de compra</h5>
            <div class="small text-muted" id="purchaseRequestDetailSubtitle"></div>
          </div>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body" id="purchaseRequestDetailBody"></div>
        <div class="modal-footer">
          <button type="button" class="btn btn-outline-danger" id="purchaseRequestDetailPdf">PDF</button>
          <button type="button" class="btn btn-outline-success" id="purchaseRequestDetailXlsx">Excel</button>
          <button type="button" class="btn btn-dark" id="purchaseRequestCancelAll">Cancelar solicitud</button>
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cerrar</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function openRequestDetail(requestId) {
  ensureRequestDetailModal();
  const request = purchaseRequestsById.get(requestId) || {
    id: requestId,
    ...(await getDoc(doc(db, "purchaseRequests", requestId))).data(),
  };
  const lines = sortRequestLines(await fetchRequestLines(requestId), requestSortModeForRequest(request));

  const title = document.querySelector("#purchaseRequestDetailTitle");
  const subtitle = document.querySelector("#purchaseRequestDetailSubtitle");
  const body = document.querySelector("#purchaseRequestDetailBody");
  const cancelAll = document.querySelector("#purchaseRequestCancelAll");
  const pdf = document.querySelector("#purchaseRequestDetailPdf");
  const xlsx = document.querySelector("#purchaseRequestDetailXlsx");

  title.textContent = request.folio || "Solicitud de compra";
  subtitle.textContent = `${requestStatusLabel(request.status)} · ${requestDateText(request.sentAt || request.createdAt)}`;
  pdf.dataset.requestId = requestId;
  xlsx.dataset.requestId = requestId;
  cancelAll.dataset.requestId = requestId;
  pdf.classList.remove("d-none");
  xlsx.classList.remove("d-none");

  const filters = Array.isArray(request.filtersSnapshot) ? request.filtersSnapshot : [];
  const filterHtml = filters.length
    ? `<div class="mb-3">${filters.map(filter => `<span class="request-filter-chip"><strong>${reportEscape(filter.label)}:</strong> ${reportEscape(filter.value)}</span>`).join("")}</div>`
    : "";

  body.innerHTML = `
    ${filterHtml}
    ${lines.map(line => {
      const pending = linePendingQty(line);
      return `
        <div class="request-line-row">
          <div class="d-flex flex-wrap justify-content-between gap-3">
            <div>
              <div class="request-line-title">${reportEscape(line.nombre || line.sku || "Item")}</div>
              <div class="request-line-meta">${reportEscape(line.sku || "")} · Prioridad ${itemPriority({ purchasePriority: line.priority })}</div>
            </div>
            <div class="text-end">
              <div><strong>Solicitado:</strong> ${num(line.quantityRequested)}</div>
              <div><strong>Recibido:</strong> ${num(line.quantityReceived)}</div>
              <div><strong>Cancelado:</strong> ${num(line.quantityCancelled)}</div>
              <div><strong>Pendiente:</strong> ${pending}</div>
              <div><strong>Costo esperado:</strong> ${reportEscape(formatCurrencyWithCode(line.unitPrice, line.currency || "MXN"))}</div>
              <div><strong>Gasto real recibido:</strong> ${reportEscape(formatCurrencyWithCode(lineActualSpent(line), line.currency || "MXN"))}</div>
            </div>
          </div>
          ${pending > 0 ? `
            <div class="d-flex flex-wrap gap-2 mt-3">
              <button type="button" class="btn btn-success btn-sm request-line-receive" data-request-id="${requestId}" data-line-id="${reportEscape(line.id)}" data-pending="${pending}">Registrar recepción</button>
              <button type="button" class="btn btn-dark btn-sm request-line-cancel" data-request-id="${requestId}" data-line-id="${reportEscape(line.id)}" data-pending="${pending}">Cancelar pendiente</button>
            </div>` : ""}
        </div>`;
    }).join("")}`;

  const hasPending = lines.some(line => linePendingQty(line) > 0);
  const hasReceived = lines.some(line => num(line.quantityReceived) > 0);
  cancelAll.classList.toggle("d-none", !hasPending);
  cancelAll.textContent = hasReceived ? "Cancelar pendientes restantes" : "Cancelar solicitud completa";
  bootstrap.Modal.getOrCreateInstance(document.querySelector("#purchaseRequestDetailModal")).show();
}

async function applyLineMovement(requestId, lineId, mode, quantity, { refresh = true, unitCost = null } = {}) {
  const qty = Math.max(num(quantity), 0);
  if (qty <= 0) return;

  const lineRef = doc(db, "purchaseRequests", requestId, "items", lineId);
  const requestRef = doc(db, "purchaseRequests", requestId);

  await runTransaction(db, async transaction => {
    const lineSnap = await transaction.get(lineRef);
    if (!lineSnap.exists()) throw new Error("La línea de compra ya no existe.");

    const line = { id: lineSnap.id, ...lineSnap.data() };
    const itemRef = doc(db, "items", String(line.itemId || lineId));
    const itemSnap = await transaction.get(itemRef);
    if (!itemSnap.exists()) throw new Error("El item asociado ya no existe.");

    const item = { id: itemSnap.id, ...itemSnap.data() };
    const remaining = linePendingQty(line);
    if (qty > remaining) throw new Error(`Sólo quedan ${remaining} piezas pendientes.`);

    const expectedUnitCost = num(line.unitPrice);
    const previousActualTotal = Object.prototype.hasOwnProperty.call(line, "actualCostTotal")
      ? num(line.actualCostTotal)
      : num(line.quantityReceived) * expectedUnitCost;
    const actualUnitCost = mode === "receive"
      ? Math.max(num(unitCost === null ? expectedUnitCost : unitCost), 0)
      : 0;

    const newReceived = num(line.quantityReceived) + (mode === "receive" ? qty : 0);
    const newCancelled = num(line.quantityCancelled) + (mode === "cancel" ? qty : 0);
    const newRemaining = Math.max(num(line.quantityRequested) - newReceived - newCancelled, 0);
    const newLineStatus = newRemaining > 0
      ? REQUEST_STATUS_PARTIAL
      : (newReceived > 0 ? PURCHASE_STATUS_RECEIVED : REQUEST_STATUS_CANCELLED);

    const currentPending = pendingPurchaseQty(item);
    const nextPending = Math.max(currentPending - qty, 0);
    const refs = normalizePendingRefs(item.purchasePendingRefs)
      .map(ref => {
        if (ref.requestId !== requestId || ref.lineId !== String(line.itemId || lineId)) return ref;
        return { ...ref, pendingQty: Math.max(ref.pendingQty - qty, 0) };
      })
      .filter(ref => ref.pendingQty > 0);

    const itemUpdate = {
      purchasePendingQty: nextPending,
      purchasePendingRefs: refs,
      updatedAt: serverTimestamp(),
    };
    if (mode === "receive") {
      itemUpdate.stockAlmacen = num(item.stockAlmacen) + qty;
    }

    transaction.update(itemRef, itemUpdate);
    transaction.update(lineRef, {
      quantityReceived: newReceived,
      quantityCancelled: newCancelled,
      status: newLineStatus,
      updatedAt: serverTimestamp(),
      ...(mode === "receive" ? {
        lastReceivedAt: serverTimestamp(),
        lastActualCostAt: serverTimestamp(),
        lastActualUnitCost: actualUnitCost,
        actualCostTotal: previousActualTotal + qty * actualUnitCost,
      } : { lastCancelledAt: serverTimestamp() }),
    });
    transaction.update(requestRef, { updatedAt: serverTimestamp() });
  });

  if (refresh) {
    await refreshRequestAggregate(requestId);
    await Promise.all([loadPurchaseItems(), loadPurchaseRequests()]);
    renderPurchaseRequestManager();
    queueEnhancements();
    if (document.querySelector("#purchaseBudgetsPanel.show")) {
      await refreshBudgetPanel();
    }
  }
}

async function registerLineReceipt(requestId, lineId, pending) {
  const lineSnap = await getDoc(doc(db, "purchaseRequests", requestId, "items", lineId));
  if (!lineSnap.exists()) {
    alert("La línea de compra ya no existe.");
    return;
  }
  const line = { id: lineSnap.id, ...lineSnap.data() };
  const expectedUnitCost = num(line.unitPrice);
  const currency = line.currency || "MXN";

  const result = await askQuantity({
    title: "Registrar recepción",
    message: `Indica cuántas piezas llegaron. El costo esperado por unidad es ${formatCurrencyWithCode(expectedUnitCost, currency)}.`,
    max: pending,
    value: pending,
    allowZero: false,
    includeCost: true,
    costValue: expectedUnitCost,
    costEditable: currentAccessRole === "admin",
    currency,
  });
  if (result === null) return;

  try {
    await applyLineMovement(requestId, lineId, "receive", result.quantity, { unitCost: result.unitCost });
    const budgetAlert = await budgetDeficitMessageForLine(line);
    if (budgetAlert) alert(budgetAlert);
    await openRequestDetail(requestId);
  } catch (error) {
    console.error(error);
    alert(`No se pudo registrar la recepción: ${error.message}`);
  }
}

async function cancelLinePending(requestId, lineId, pending) {
  const qty = await askQuantity({
    title: "Cancelar piezas pendientes",
    message: "Indica cuántas piezas pendientes se cancelaron en esta solicitud.",
    max: pending,
    value: pending,
    allowZero: false,
  });
  if (qty === null) return;

  try {
    await applyLineMovement(requestId, lineId, "cancel", qty);
    await openRequestDetail(requestId);
  } catch (error) {
    console.error(error);
    alert(`No se pudo cancelar la cantidad pendiente: ${error.message}`);
  }
}

async function cancelAllPendingInRequest(requestId, { reopenDetail = true } = {}) {
  const lines = await fetchRequestLines(requestId);
  const pendingLines = lines.filter(line => linePendingQty(line) > 0);
  if (!pendingLines.length) return;

  if (!confirm(`¿Cancelar ${pendingLines.length === lines.length ? "la solicitud completa" : "todas las cantidades pendientes de esta solicitud"}?\n\nSe liberará del presupuesto el importe estimado de todo lo que aún no se ha recibido. Se afectarán ${pendingLines.length} líneas.`)) return;

  purchaseUiBusy = true;
  try {
    for (const line of pendingLines) {
      await applyLineMovement(requestId, line.id, "cancel", linePendingQty(line), { refresh: false });
    }
    await refreshRequestAggregate(requestId);
    await Promise.all([loadPurchaseItems(), loadPurchaseRequests()]);
    renderPurchaseRequestManager();
    queueEnhancements();
    if (document.querySelector("#purchaseBudgetsPanel.show")) await refreshBudgetPanel();
    if (reopenDetail) await openRequestDetail(requestId);
  } catch (error) {
    console.error(error);
    alert(`No se pudo cancelar la solicitud: ${error.message}`);
  } finally {
    purchaseUiBusy = false;
  }
}

async function openItemRequests(itemId) {
  const item = itemsById.get(String(itemId)) || await fetchLiveItem(itemId);
  const refs = normalizePendingRefs(item.purchasePendingRefs);
  if (!refs.length) {
    alert("Este artículo no tiene solicitudes activas pendientes.");
    return;
  }

  const requestIds = [...new Set(refs.map(ref => ref.requestId))];
  if (requestIds.length === 1) {
    await openRequestDetail(requestIds[0]);
    return;
  }

  ensureRequestDetailModal();
  const body = document.querySelector("#purchaseRequestDetailBody");
  document.querySelector("#purchaseRequestDetailTitle").textContent = `Solicitudes activas · ${item.nombre || item.sku}`;
  document.querySelector("#purchaseRequestDetailSubtitle").textContent = `${refs.length} referencia${refs.length === 1 ? "" : "s"} pendiente${refs.length === 1 ? "" : "s"}`;
  document.querySelector("#purchaseRequestCancelAll").classList.add("d-none");
  document.querySelector("#purchaseRequestDetailPdf").classList.add("d-none");
  document.querySelector("#purchaseRequestDetailXlsx").classList.add("d-none");

  body.innerHTML = refs.map(ref => `
    <div class="request-line-row d-flex flex-wrap justify-content-between gap-3 align-items-center">
      <div>
        <div class="request-line-title">${reportEscape(ref.folio || ref.requestId)}</div>
        <div class="request-line-meta">Pendiente: ${pluralPieces(ref.pendingQty)}</div>
      </div>
      <button type="button" class="btn btn-outline-dark btn-sm request-open-from-item" data-request-id="${reportEscape(ref.requestId)}">Abrir solicitud</button>
    </div>`).join("");

  bootstrap.Modal.getOrCreateInstance(document.querySelector("#purchaseRequestDetailModal")).show();
}

async function migrateLegacyOrdersIfNeeded() {
  if (currentAccessRole !== "admin") return;

  const candidates = [...itemsById.values()].filter(item =>
    item.purchaseStatus === PURCHASE_STATUS_ORDERED &&
    item.purchaseLegacyMigrated !== true &&
    pendingPurchaseQty(item) <= 0 &&
    Math.max(num(item.inventarioDeseado) - currentInventory(item), 0) > 0
  );
  if (!candidates.length) return;

  const requestId = "legacy-migration-v1";
  const requestRef = doc(db, "purchaseRequests", requestId);
  const requestSnap = await getDoc(requestRef);
  const year = new Date().getFullYear();
  const folio = requestSnap.data()?.folio || `SC-MIGRADA-${year}`;

  const lines = candidates.map(item =>
    snapshotLineFromItem(item, Math.max(num(item.inventarioDeseado) - currentInventory(item), 0))
  );
  const { totals, quantity } = totalsForLines(lines);

  // Normalmente son pocos registros. Se divide en lotes para mantenernos
  // holgadamente por debajo del límite de 500 operaciones de Firestore.
  const chunks = [];
  for (let i = 0; i < candidates.length; i += 180) chunks.push(candidates.slice(i, i + 180));

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const batch = writeBatch(db);
    if (chunkIndex === 0) {
      batch.set(requestRef, {
        folio,
        status: REQUEST_STATUS_SENT,
        createdBy: currentUser.uid,
        createdByName: currentProfile?.nombre || currentUser.email || "",
        createdAt: serverTimestamp(),
        sentAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        itemCount: lines.length,
        totalQty: quantity,
        totalsByCurrency: totals,
        legacyMigration: true,
        filtersSnapshot: [{ label: "Origen", value: "Compras marcadas antes del sistema de solicitudes" }],
      }, { merge: true });
    }

    for (const item of chunks[chunkIndex]) {
      const qty = Math.max(num(item.inventarioDeseado) - currentInventory(item), 0);
      const line = snapshotLineFromItem(item, qty);
      const lineRef = doc(db, "purchaseRequests", requestId, "items", item.id);
      batch.set(lineRef, {
        ...line,
        folio,
        status: PURCHASE_STATUS_ORDERED,
        sentAt: serverTimestamp(),
        addedAt: serverTimestamp(),
      }, { merge: true });

      const refs = normalizePendingRefs(item.purchasePendingRefs)
        .filter(ref => ref.requestId !== requestId);
      refs.push({ requestId, lineId: item.id, folio, pendingQty: qty });

      batch.update(doc(db, "items", item.id), {
        purchasePendingQty: qty,
        purchasePendingRefs: refs,
        purchaseLegacyMigrated: true,
        purchaseStatus: "migrated",
        updatedAt: serverTimestamp(),
      });
    }
    await batch.commit();
  }

  await Promise.all([loadPurchaseItems(), loadPurchaseRequests()]);
}

function requestLineCardsHtml(lines) {
  return lines.map(line => {
    const pending = linePendingQty(line);
    const subtotal = num(line.quantityRequested) * num(line.unitPrice);
    const imageSrc = line.imageFileId ? fileViewUrl(line.imageFileId) : "assets/placeholder.svg";
    return `
      <article class="request-report-card">
        <div class="request-report-image"><img src="${reportEscape(imageSrc)}" alt="${reportEscape(line.nombre || "")}"></div>
        <div class="request-report-content">
          <div class="request-report-head">
            <div>
              <h2>${reportEscape(line.nombre || "Item")}</h2>
              <div class="muted">${reportEscape(line.sku || "")} · ${reportEscape(line.tipo || "")}</div>
            </div>
            <div class="priority-box"><strong>${reportEscape(priorityLabel(num(line.priority) || 3))}</strong></div>
          </div>
          <div class="cost-line"><strong>Precio unitario:</strong> ${reportEscape(formatCurrencyWithCode(line.unitPrice, line.currency || "MXN"))} &nbsp; <strong>Solicitado:</strong> ${num(line.quantityRequested)} &nbsp; <strong>Subtotal:</strong> ${reportEscape(formatCurrencyWithCode(subtotal, line.currency || "MXN"))}</div>
          <div class="area-line"><strong>Zona:</strong> ${reportEscape(line.zoneId || "")} · ${reportEscape(line.zoneName || "")} &nbsp; <strong>Subzona:</strong> ${reportEscape(line.subzoneId || "")} · ${reportEscape(line.subzoneName || "")} &nbsp; <strong>Área:</strong> ${reportEscape(line.locationCode || "")} ${reportEscape(line.locationName || "")}</div>
          ${line.descripcion ? `<p>${reportEscape(line.descripcion)}</p>` : ""}
          <div class="links">
            ${line.infoUrl ? `<a href="${reportEscape(line.infoUrl)}" target="_blank">Más info</a>` : ""}
            ${line.purchaseUrl ? `<a href="${reportEscape(line.purchaseUrl)}" target="_blank">Info Compra</a>` : ""}
          </div>
          <div class="status-band">
            Solicitado: <strong>${num(line.quantityRequested)}</strong> · Recibido: <strong>${num(line.quantityReceived)}</strong> · Cancelado: <strong>${num(line.quantityCancelled)}</strong> · Pendiente: <strong>${pending}</strong> · Gasto real recibido: <strong>${reportEscape(formatCurrencyWithCode(lineActualSpent(line), line.currency || "MXN"))}</strong>
          </div>
        </div>
      </article>`;
  }).join("");
}

async function exportRequestPdf(requestId, providedLines = null) {
  const request = requestId === currentDraftRequest?.id
    ? currentDraftRequest
    : purchaseRequestsById.get(requestId);
  const rawLines = providedLines || (requestId ? await fetchRequestLines(requestId) : draftLinesArray());
  const sortMode = requestId === currentDraftRequest?.id || !requestId
    ? draftRequestSortMode
    : requestSortModeForRequest(request);
  const lines = sortRequestLines(rawLines, sortMode);
  if (!lines.length) {
    alert("Esta solicitud no tiene elementos para generar el PDF.");
    return;
  }

  const popup = window.open("", "_blank");
  if (!popup) {
    alert("El navegador bloqueó la ventana del reporte. Permite ventanas emergentes e inténtalo nuevamente.");
    return;
  }

  const folio = request?.folio || "BORRADOR";
  const status = request?.status || REQUEST_STATUS_DRAFT;
  const filters = Array.isArray(request?.filtersSnapshot) && request.filtersSnapshot.length
    ? request.filtersSnapshot
    : filtersSnapshotForRequest();
  const { totals, quantity } = totalsForLines(lines);
  const created = requestDateText(request?.sentAt || request?.createdAt) || new Date().toLocaleString("es-MX");
  const stylesHref = new URL("css/styles.css", window.location.href).href;

  popup.document.write(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<base href="${reportEscape(document.baseURI)}">
<title>${reportEscape(folio)} · Solicitud de compra</title>
<link rel="stylesheet" href="https://use.typekit.net/jov3nat.css">
<link rel="stylesheet" href="${reportEscape(stylesHref)}">
<style>
@page{size:A4 landscape;margin:9mm}
*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;box-sizing:border-box}
body{font-family:Arial,sans-serif;color:#171717;margin:0;background:#fff}
.toolbar{display:flex;justify-content:flex-end;gap:8px;padding:10px;border-bottom:1px solid #ddd}
.page{padding:0}
header{border-bottom:3px solid #c8102e;padding-bottom:4mm;margin-bottom:5mm}
.kicker{font-size:9pt;font-weight:700;color:#c8102e;text-transform:uppercase}
h1{font-size:23pt;margin:1mm 0}
.meta{display:flex;gap:8mm;flex-wrap:wrap;font-size:9pt;color:#555}
.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:3mm;margin:4mm 0}
.summary>div{border:1px solid #ddd;border-radius:2mm;padding:3mm}
.summary .big{font-size:16pt;font-weight:700}
.filters{display:flex;flex-wrap:wrap;gap:2mm;margin-bottom:5mm}
.filter{border:1px solid #ddd;border-radius:99px;padding:1.5mm 2.5mm;font-size:8pt}
.request-report-card{display:grid;grid-template-columns:42mm 1fr;border:1.5px solid #e0b12f;border-radius:2mm;margin-bottom:5mm;break-inside:avoid;overflow:hidden}
.request-report-image{display:flex;align-items:center;justify-content:center;border-right:1px solid #eee;padding:3mm}
.request-report-image img{max-width:100%;max-height:48mm;object-fit:contain}
.request-report-content{padding:3.5mm}
.request-report-head{display:flex;justify-content:space-between;gap:4mm}
.request-report-head h2{font-size:15pt;margin:0 0 1mm}
.muted{color:#666;font-size:8.5pt}
.priority-box{border:1px solid #ddd;border-radius:2mm;padding:2mm 3mm;white-space:nowrap}
.cost-line{margin:2mm 0;padding:2mm;background:#fff8ed;border:1px solid #f1d4a7;font-size:9pt}
.area-line{margin:2mm 0;padding:2mm;border:1px solid #eee;background:#fafafa;font-size:8.5pt}
.request-report-content p{font-size:9pt;margin:2mm 0}
.links{display:flex;gap:2mm;margin:2mm 0}
.links a{border:1px solid #198754;border-radius:99px;padding:1.5mm 2.5mm;text-decoration:none;color:#176b3a;font-size:8.5pt}
.status-band{margin-top:2mm;background:#fff3cd;border-left:2mm solid #e0b12f;border-radius:2mm;padding:2.5mm;font-size:9pt}
@media print{.toolbar{display:none!important}}
</style>
</head>
<body>
<div class="toolbar"><button onclick="window.print()">Imprimir / Guardar PDF</button><button onclick="window.close()">Cerrar</button></div>
<main class="page">
<header>
<div class="kicker">Universidad Iberoamericana Ciudad de México · FabLab</div>
<h1>Solicitud de compra ${reportEscape(folio)}</h1>
<div class="meta"><span><strong>Estado:</strong> ${reportEscape(requestStatusLabel(status))}</span><span><strong>Fecha:</strong> ${reportEscape(created)}</span><span><strong>Generado por:</strong> ${reportEscape(request?.createdByName || currentProfile?.nombre || currentUser?.email || "")}</span></div>
</header>
<section class="summary">
<div><div class="muted">Artículos</div><div class="big">${lines.length}</div></div>
<div><div class="muted">Piezas solicitadas</div><div class="big">${quantity}</div></div>
<div><div class="muted">Importe</div><div class="big">${reportEscape(formatMoneyTotals(totals))}</div></div>
</section>
<section class="filters">${filters.map(filter => `<span class="filter"><strong>${reportEscape(filter.label)}:</strong> ${reportEscape(filter.value)}</span>`).join("")}</section>
<section>${requestLineCardsHtml(lines)}</section>
</main>
<script>
window.addEventListener("load",async()=>{const waits=Array.from(document.images).map(img=>img.complete?Promise.resolve():new Promise(r=>{img.onload=r;img.onerror=r}));await Promise.all(waits);setTimeout(()=>window.print(),350)});
<\/script>
</body></html>`);
  popup.document.close();
}

async function exportRequestXlsx(requestId, providedLines = null) {
  if (!window.XLSX) {
    alert("No se pudo cargar la librería XLSX.");
    return;
  }
  const request = requestId === currentDraftRequest?.id
    ? currentDraftRequest
    : purchaseRequestsById.get(requestId);
  const rawLines = providedLines || (requestId ? await fetchRequestLines(requestId) : draftLinesArray());
  const sortMode = requestId === currentDraftRequest?.id || !requestId
    ? draftRequestSortMode
    : requestSortModeForRequest(request);
  const lines = sortRequestLines(rawLines, sortMode);
  if (!lines.length) {
    alert("Esta solicitud no tiene elementos para exportar.");
    return;
  }

  const header = [
    "Solicitud", "Estado", "Zona", "Subzona", "Área", "SKU", "Tipo", "Nombre", "Prioridad",
    "Solicitado", "Recibido", "Cancelado", "Pendiente", "Precio unitario", "Moneda", "Subtotal solicitado",
    "Gasto real recibido", "Comprometido pendiente", "Más info", "Info compra"
  ];
  const folio = request?.folio || "BORRADOR";
  const rows = lines.map(line => [
    folio,
    requestStatusLabel(request?.status || REQUEST_STATUS_DRAFT),
    line.zoneName || "",
    line.subzoneName || "",
    `${line.locationCode || ""} ${line.locationName || ""}`.trim(),
    line.sku || "",
    line.tipo || "",
    line.nombre || "",
    num(line.priority) || 3,
    num(line.quantityRequested),
    num(line.quantityReceived),
    num(line.quantityCancelled),
    linePendingQty(line),
    num(line.unitPrice),
    line.currency || "MXN",
    num(line.quantityRequested) * num(line.unitPrice),
    lineActualSpent(line),
    linePendingQty(line) * num(line.unitPrice),
    line.infoUrl || "",
    line.purchaseUrl || "",
  ]);

  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws["!cols"] = [
    {wch:18},{wch:14},{wch:20},{wch:24},{wch:28},{wch:12},{wch:16},{wch:36},{wch:10},
    {wch:12},{wch:12},{wch:12},{wch:12},{wch:15},{wch:10},{wch:18},{wch:18},{wch:20},{wch:40},{wch:40}
  ];
  for (let r = 2; r <= rows.length + 1; r++) {
    ["I","J","K","L","M","N","P","Q","R"].forEach(col => setXlsxNumericCell(ws, `${col}${r}`));
    const currency = ws[`O${r}`]?.v || "MXN";
    const fmt = xlsxMoneyFormat(currency);
    if (ws[`N${r}`]) ws[`N${r}`].z = fmt;
    if (ws[`P${r}`]) ws[`P${r}`].z = fmt;
    if (ws[`Q${r}`]) ws[`Q${r}`].z = fmt;
    if (ws[`R${r}`]) ws[`R${r}`].z = fmt;
  }
  ws["!autofilter"] = { ref: `A1:T${rows.length + 1}` };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Solicitud");
  XLSX.writeFile(wb, `${folio.replace(/[^A-Za-z0-9_-]+/g, "_")}.xlsx`, { bookType: "xlsx", compression: true });
}

function bindPurchaseRequestManagerActions() {
  document.addEventListener("change", event => {
    const sortSelect = event.target.closest("#requestDraftSortMode");
    if (!sortSelect) return;
    const mode = String(sortSelect.value || "zone");
    if (!REQUEST_SORT_OPTIONS.some(([value]) => value === mode)) return;
    draftRequestSortMode = mode;
    const key = currentDraftRequest?.id ? `purchaseDraftSort:${currentDraftRequest.id}` : "purchaseDraftSort:new";
    localStorage.setItem(key, mode);
    renderPurchaseRequestManager();
  });

  document.addEventListener("click", async event => {
    const target = event.target;

    if (target.closest("#refreshPurchaseRequests")) {
      await Promise.all([loadPurchaseItems(), loadPurchaseRequests()]);
      await loadCurrentDraft();
      renderPurchaseRequestManager();
      queueEnhancements();
      return;
    }

    const draftEdit = target.closest(".request-draft-edit");
    if (draftEdit) {
      await addOrEditDraftItem(draftEdit.dataset.itemId);
      return;
    }

    if (target.closest(".request-draft-empty")) {
      await emptyCurrentDraft();
      return;
    }

    if (target.closest(".request-draft-send")) {
      await sendCurrentDraft();
      return;
    }

    if (target.closest(".request-draft-pdf")) {
      await exportRequestPdf(currentDraftRequest?.id || "", draftLinesArray());
      return;
    }

    if (target.closest(".request-draft-xlsx")) {
      await exportRequestXlsx(currentDraftRequest?.id || "", draftLinesArray());
      return;
    }

    const view = target.closest(".request-history-view");
    if (view) {
      await openRequestDetail(view.dataset.requestId);
      return;
    }

    const pdf = target.closest(".request-history-pdf");
    if (pdf) {
      await exportRequestPdf(pdf.dataset.requestId);
      return;
    }

    const xlsx = target.closest(".request-history-xlsx");
    if (xlsx) {
      await exportRequestXlsx(xlsx.dataset.requestId);
      return;
    }

    const historyCancel = target.closest(".request-history-cancel");
    if (historyCancel) {
      await cancelAllPendingInRequest(historyCancel.dataset.requestId, { reopenDetail: false });
      return;
    }

    const receive = target.closest(".request-line-receive");
    if (receive) {
      await registerLineReceipt(receive.dataset.requestId, receive.dataset.lineId, num(receive.dataset.pending));
      return;
    }

    const cancel = target.closest(".request-line-cancel");
    if (cancel) {
      await cancelLinePending(cancel.dataset.requestId, cancel.dataset.lineId, num(cancel.dataset.pending));
      return;
    }

    const openFromItem = target.closest(".request-open-from-item");
    if (openFromItem) {
      await openRequestDetail(openFromItem.dataset.requestId);
      return;
    }

    const detailPdf = target.closest("#purchaseRequestDetailPdf");
    if (detailPdf && detailPdf.dataset.requestId) {
      await exportRequestPdf(detailPdf.dataset.requestId);
      return;
    }

    const detailXlsx = target.closest("#purchaseRequestDetailXlsx");
    if (detailXlsx && detailXlsx.dataset.requestId) {
      await exportRequestXlsx(detailXlsx.dataset.requestId);
      return;
    }

    const cancelAll = target.closest("#purchaseRequestCancelAll");
    if (cancelAll && cancelAll.dataset.requestId) {
      await cancelAllPendingInRequest(cancelAll.dataset.requestId);
    }
  });
}

async function updatePriority(itemId, select) {
  if (currentAccessRole !== "admin") return;

  const priority = Number(select.value);
  if (![1, 2, 3].includes(priority)) return;

  select.disabled = true;
  try {
    await updateDoc(doc(db, "items", itemId), {
      purchasePriority: priority,
      updatedAt: serverTimestamp(),
    });

    const current = itemsById.get(itemId) || await fetchLiveItem(itemId);
    itemsById.set(itemId, { ...current, purchasePriority: priority });
    queueEnhancements();
  } catch (error) {
    console.error(error);
    alert(`No se pudo cambiar la prioridad: ${error.message}`);
    const item = itemsById.get(itemId);
    if (item) select.value = String(itemPriority(item));
  } finally {
    select.disabled = false;
  }
}

function bindPurchaseActions() {
  const itemsList = document.querySelector("#itemsList");
  if (!itemsList) return;

  itemsList.addEventListener("click", async event => {
    const addButton = event.target.closest(".purchase-add-request-btn");
    if (addButton) {
      await addOrEditDraftItem(addButton.dataset.id);
      return;
    }

    const viewButton = event.target.closest(".purchase-view-requests-btn");
    if (viewButton) {
      await openItemRequests(viewButton.dataset.id);
    }
  });

  itemsList.addEventListener("change", event => {
    const select = event.target.closest(".purchase-priority-select");
    if (select) updatePriority(select.dataset.id, select);
  });
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
    for (const col of moneyColumns) setXlsxNumericCell(ws, `${col}${r}`, format);
  }
}

function itemAreaCode(item) {
  return item.locationCode || item.areaCode || item.subzoneId || "";
}

function inventoryReportRows(rows) {
  return rows.map(item => ({
    zona: item.zoneName || "",
    subzona: item.subzoneName || "",
    area_codigo: itemAreaCode(item),
    area: item.locationName || "",
    sku: item.sku || "",
    tipo: item.tipo || "",
    nombre: item.nombre || "",
    descripcion: item.descripcion || "",
    estado_compra: purchaseStatusLabel(item),
    prioridad: itemPriority(item),
    inventario_actual: currentInventory(item),
    inventario_deseado: num(item.inventarioDeseado),
    pendiente_recibir: pendingPurchaseQty(item),
    cantidad_a_comprar: quantityToBuy(item),
    precio_unitario: num(item.precioUnitario),
    moneda: item.moneda || "MXN",
    subtotal: quantityToBuy(item) * num(item.precioUnitario),
    liga_compra: item.purchaseUrl || "",
  }));
}

function exportVisibleXlsx(rows) {
  if (!window.XLSX) {
    alert("No se pudo cargar la librería XLSX. Revisa tu conexión a internet o la consola del navegador.");
    return;
  }
  if (!rows.length) {
    alert("No hay elementos para exportar con el filtro seleccionado.");
    return;
  }

  const data = inventoryReportRows(rows);
  const headers = [
    "Zona", "Subzona", "Código de área", "Área", "SKU", "Tipo", "Nombre", "Descripción",
    "Estado de compra", "Prioridad", "Inventario actual", "Inventario deseado", "Pendiente de recibir", "Disponible para solicitar",
    "Precio unitario", "Moneda", "Subtotal", "Liga de compra",
  ];
  const aoa = [headers, ...data.map(row => [
    cleanXlsxText(row.zona), cleanXlsxText(row.subzona), cleanXlsxText(row.area_codigo), cleanXlsxText(row.area),
    cleanXlsxText(row.sku), cleanXlsxText(row.tipo), cleanXlsxText(row.nombre), cleanXlsxText(row.descripcion),
    cleanXlsxText(row.estado_compra), cleanXlsxNumber(row.prioridad), cleanXlsxNumber(row.inventario_actual),
    cleanXlsxNumber(row.inventario_deseado), cleanXlsxNumber(row.pendiente_recibir), cleanXlsxNumber(row.cantidad_a_comprar),
    cleanXlsxNumber(row.precio_unitario), cleanXlsxText(row.moneda), cleanXlsxNumber(row.subtotal), cleanXlsxText(row.liga_compra),
  ])];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 18 }, { wch: 24 }, { wch: 16 }, { wch: 28 }, { wch: 12 }, { wch: 16 }, { wch: 36 }, { wch: 36 },
    { wch: 24 }, { wch: 10 }, { wch: 14 }, { wch: 16 }, { wch: 17 }, { wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 16 }, { wch: 40 },
  ];
  for (let r = 2; r <= data.length + 1; r++) {
    ["J", "K", "L", "M", "N"].forEach(col => setXlsxNumericCell(ws, `${col}${r}`));
  }
  applyXlsxMoneyFormat(ws, data.length, ["O", "Q"], "P");
  ws["!autofilter"] = { ref: `A1:R${data.length + 1}` };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Inventario filtrado");
  const date = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `inventario_compras_filtrado_${date}.xlsx`, { bookType: "xlsx", compression: true });
}

function flattenMoneyTotals(totals) {
  const entries = Object.entries(totals || {}).sort(([a], [b]) => String(a).localeCompare(String(b), "es"));
  return entries.length ? entries : [["MXN", 0]];
}

function exportPurchaseReportXlsx(rows) {
  if (!window.XLSX) {
    alert("No se pudo cargar la librería XLSX. Revisa tu conexión a internet o la consola del navegador.");
    return;
  }
  if (!rows.length) {
    alert("No hay elementos dentro del filtro actual.");
    return;
  }

  const categorySummary = buildCategorySummary(rows);
  const categoryAoa = [
    ["Categoría", "Items", "Piezas sugeridas", "Moneda", "Total"],
    ...categorySummary.flatMap(cat => flattenMoneyTotals(cat.totals).map(([currency, total]) => [
      cleanXlsxText(cat.category), cleanXlsxNumber(cat.items), cleanXlsxNumber(cat.qty), cleanXlsxText(currency), cleanXlsxNumber(total),
    ])),
  ];

  const breakdown = buildBreakdown(rows);
  const breakdownAoa = [
    ["Zona", "Nombre zona", "Subzona", "Nombre subzona", "Categoría", "Items", "Piezas sugeridas", "Moneda", "Total"],
    ...breakdown.flatMap(zone => zone.subzones.flatMap(subzone => subzone.categories.flatMap(cat =>
      flattenMoneyTotals(cat.totals).map(([currency, total]) => [
        cleanXlsxText(zone.zoneId), cleanXlsxText(zone.zoneName), cleanXlsxText(subzone.subzoneId), cleanXlsxText(subzone.subzoneName),
        cleanXlsxText(cat.category), cleanXlsxNumber(cat.items), cleanXlsxNumber(cat.qty), cleanXlsxText(currency), cleanXlsxNumber(total),
      ])
    ))),
  ];

  const detail = inventoryReportRows(rows);
  const detailAoa = [
    ["Zona", "Subzona", "Código de área", "Área", "SKU", "Tipo", "Nombre", "Estado de compra", "Prioridad", "Inventario actual", "Inventario deseado", "Pendiente de recibir", "Disponible para solicitar", "Precio unitario", "Moneda", "Subtotal", "Liga de compra"],
    ...detail.map(row => [
      cleanXlsxText(row.zona), cleanXlsxText(row.subzona), cleanXlsxText(row.area_codigo), cleanXlsxText(row.area), cleanXlsxText(row.sku),
      cleanXlsxText(row.tipo), cleanXlsxText(row.nombre), cleanXlsxText(row.estado_compra), cleanXlsxNumber(row.prioridad),
      cleanXlsxNumber(row.inventario_actual), cleanXlsxNumber(row.inventario_deseado), cleanXlsxNumber(row.pendiente_recibir), cleanXlsxNumber(row.cantidad_a_comprar),
      cleanXlsxNumber(row.precio_unitario), cleanXlsxText(row.moneda), cleanXlsxNumber(row.subtotal), cleanXlsxText(row.liga_compra),
    ]),
  ];

  const wb = XLSX.utils.book_new();
  const wsCategories = XLSX.utils.aoa_to_sheet(categoryAoa);
  wsCategories["!cols"] = [{ wch: 44 }, { wch: 10 }, { wch: 18 }, { wch: 10 }, { wch: 16 }];
  applyXlsxMoneyFormat(wsCategories, categoryAoa.length - 1, ["E"], "D");

  const wsBreakdown = XLSX.utils.aoa_to_sheet(breakdownAoa);
  wsBreakdown["!cols"] = [{ wch: 10 }, { wch: 28 }, { wch: 12 }, { wch: 30 }, { wch: 44 }, { wch: 10 }, { wch: 18 }, { wch: 10 }, { wch: 16 }];
  applyXlsxMoneyFormat(wsBreakdown, breakdownAoa.length - 1, ["I"], "H");

  const wsDetail = XLSX.utils.aoa_to_sheet(detailAoa);
  wsDetail["!cols"] = [
    { wch: 20 }, { wch: 24 }, { wch: 16 }, { wch: 28 }, { wch: 12 }, { wch: 16 }, { wch: 36 }, { wch: 24 },
    { wch: 10 }, { wch: 14 }, { wch: 16 }, { wch: 17 }, { wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 16 }, { wch: 40 },
  ];
  applyXlsxMoneyFormat(wsDetail, detailAoa.length - 1, ["N", "P"], "O");

  XLSX.utils.book_append_sheet(wb, wsCategories, "Totales categoria");
  XLSX.utils.book_append_sheet(wb, wsBreakdown, "Zona subzona categoria");
  XLSX.utils.book_append_sheet(wb, wsDetail, "Detalle items");

  const date = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `reporte_compras_fablab_${date}.xlsx`, { bookType: "xlsx", compression: true });
}

function lineActualSpent(line) {
  if (Object.prototype.hasOwnProperty.call(line || {}, "actualCostTotal")) {
    return Math.max(num(line.actualCostTotal), 0);
  }
  return Math.max(num(line?.quantityReceived) * num(line?.unitPrice), 0);
}

function requestYear(request) {
  const sent = requestDateValue(request?.sentAt || request?.createdAt);
  if (sent) return sent.getFullYear();
  const match = String(request?.folio || "").match(/SC-(\d{4})-/i);
  return match ? Number(match[1]) : new Date().getFullYear();
}

function budgetDocId(year, zoneId) {
  return `${year}__${String(zoneId || "sin-zona").replaceAll("/", "_")}`;
}

function budgetZoneKey(zoneId) {
  return String(zoneId || "");
}

function zoneCatalog() {
  const map = new Map();
  for (const zone of budgetZonesById.values()) map.set(zone.zoneId, { ...zone });
  const add = source => {
    const zoneId = budgetZoneKey(source?.zoneId);
    if (!zoneId) return;
    const zoneName = source?.zoneName || `Zona ${zoneId}`;
    if (!map.has(zoneId) || map.get(zoneId).zoneName === `Zona ${zoneId}`) {
      map.set(zoneId, { zoneId, zoneName });
    }
  };
  for (const item of itemsById.values()) add(item);
  for (const budget of purchaseBudgetsByZone.values()) add(budget);
  for (const line of budgetFinancialLines) add(line);
  return [...map.values()].sort((a, b) => String(a.zoneId).localeCompare(String(b.zoneId), "es", { numeric: true }));
}


async function loadBudgetZones() {
  const snapshot = await getDocs(collection(db, "zones"));
  budgetZonesById.clear();
  snapshot.docs.forEach(zoneDoc => {
    const data = zoneDoc.data();
    const zoneId = String(data.code ?? zoneDoc.id ?? "");
    if (!zoneId) return;
    budgetZonesById.set(zoneId, {
      zoneId,
      zoneName: data.name || data.nombre || `Zona ${zoneId}`,
    });
  });
}

async function loadBudgetAllocations(year = budgetReportYear) {
  const snapshot = await getDocs(query(collection(db, "purchaseBudgets"), where("year", "==", Number(year))));
  purchaseBudgetsByZone.clear();
  snapshot.docs.forEach(budgetDoc => {
    const data = { id: budgetDoc.id, ...budgetDoc.data() };
    purchaseBudgetsByZone.set(budgetZoneKey(data.zoneId), data);
  });
}

async function loadBudgetFinancialLines(year = budgetReportYear) {
  const requests = requestHistoryArray().filter(request => requestYear(request) === Number(year));
  const lines = [];
  const chunkSize = 8;
  for (let index = 0; index < requests.length; index += chunkSize) {
    const chunk = requests.slice(index, index + chunkSize);
    const groups = await Promise.all(chunk.map(async request => {
      const requestLines = await fetchRequestLines(request.id);
      return requestLines.map(line => ({
        ...line,
        requestId: request.id,
        requestFolio: request.folio || request.id,
        requestStatus: request.status,
        requestSentAt: request.sentAt || request.createdAt,
      }));
    }));
    groups.forEach(group => lines.push(...group));
  }
  budgetFinancialLines = lines;
  return lines;
}

function budgetLineFinancials(line) {
  const currency = String(line?.currency || "MXN").toUpperCase();
  const pendingQty = linePendingQty(line);
  const expectedUnit = num(line?.unitPrice);
  const actualSpent = lineActualSpent(line);
  const committed = pendingQty * expectedUnit;
  const released = num(line?.quantityCancelled) * expectedUnit;
  const expectedOriginal = num(line?.quantityRequested) * expectedUnit;
  return { currency, pendingQty, expectedUnit, actualSpent, committed, released, expectedOriginal };
}

function budgetUsageByZone(lines = budgetFinancialLines) {
  const map = new Map();
  for (const line of lines) {
    const zoneId = budgetZoneKey(line.zoneId);
    if (!zoneId) continue;
    const financial = budgetLineFinancials(line);
    if (financial.currency !== "MXN") continue;
    if (!map.has(zoneId)) map.set(zoneId, { committed: 0, spent: 0, expected: 0, released: 0 });
    const row = map.get(zoneId);
    row.committed += financial.committed;
    row.spent += financial.actualSpent;
    row.expected += financial.expectedOriginal;
    row.released += financial.released;
  }
  return map;
}

function budgetAllocated(zoneId) {
  return Math.max(num(purchaseBudgetsByZone.get(budgetZoneKey(zoneId))?.allocatedAmount), 0);
}

function budgetAvailable(zoneId, usageMap = budgetUsageByZone()) {
  const usage = usageMap.get(budgetZoneKey(zoneId)) || { committed: 0, spent: 0 };
  return budgetAllocated(zoneId) - usage.committed - usage.spent;
}

async function validateDraftBudget(lines) {
  const year = new Date().getFullYear();
  // Refrescamos primero las solicitudes para no validar contra un historial
  // desactualizado si otro usuario acaba de enviar o cancelar una compra.
  await loadPurchaseRequests();
  await Promise.all([loadBudgetZones(), loadBudgetAllocations(year), loadBudgetFinancialLines(year)]);
  const usage = budgetUsageByZone();
  const draftByZone = new Map();
  const errors = [];

  for (const line of lines) {
    const zoneId = budgetZoneKey(line.zoneId);
    if (!zoneId) {
      errors.push(`${line.nombre || line.sku || "Item"}: no tiene zona asignada.`);
      continue;
    }
    const currency = String(line.currency || "MXN").toUpperCase();
    if (currency !== "MXN") {
      errors.push(`${line.nombre || line.sku || "Item"}: está en ${currency}. El presupuesto se controla en MXN; ajusta el precio del item a MXN antes de enviarlo.`);
      continue;
    }
    const amount = num(line.quantityRequested) * num(line.unitPrice);
    draftByZone.set(zoneId, num(draftByZone.get(zoneId)) + amount);
  }

  for (const [zoneId, required] of draftByZone.entries()) {
    const zone = zoneCatalog().find(entry => entry.zoneId === zoneId);
    const available = budgetAvailable(zoneId, usage);
    if (required > available + 0.005) {
      const missing = required - available;
      errors.push(`${zone?.zoneName || `Zona ${zoneId}`}: requiere ${formatCurrencyWithCode(required, "MXN")}, disponible ${formatCurrencyWithCode(Math.max(available, 0), "MXN")}; faltan ${formatCurrencyWithCode(missing, "MXN")}.`);
    }
  }

  return { ok: errors.length === 0, message: errors.join("\n") };
}

async function budgetDeficitMessageForLine(line) {
  if (String(line?.currency || "MXN").toUpperCase() !== "MXN") return "";
  const zoneId = budgetZoneKey(line?.zoneId);
  if (!zoneId) return "";
  const year = new Date().getFullYear();
  await loadPurchaseRequests();
  await Promise.all([loadBudgetZones(), loadBudgetAllocations(year), loadBudgetFinancialLines(year)]);
  const usage = budgetUsageByZone();
  const available = budgetAvailable(zoneId, usage);
  if (available >= -0.005) return "";
  const zone = zoneCatalog().find(entry => entry.zoneId === zoneId);
  return `${zone?.zoneName || `Zona ${zoneId}`} quedó por encima del presupuesto por ${formatCurrencyWithCode(Math.abs(available), "MXN")} después de registrar el costo real. El Administrador debe incrementar el presupuesto de la zona.`;
}

function injectBudgetManager() {
  const launcher = document.querySelector("#purchaseRequestLauncher");
  if (!launcher) return;

  if (!document.querySelector("#purchaseBudgetLauncher")) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = "purchaseBudgetLauncher";
    button.className = "btn btn-outline-dark";
    button.setAttribute("data-bs-toggle", "offcanvas");
    button.setAttribute("data-bs-target", "#purchaseBudgetsPanel");
    button.setAttribute("aria-controls", "purchaseBudgetsPanel");
    button.innerHTML = `<span>Presupuestos</span>`;
    launcher.appendChild(button);
  }

  if (!document.querySelector("#purchaseBudgetsPanel")) {
    const panel = document.createElement("div");
    panel.id = "purchaseBudgetsPanel";
    panel.className = "offcanvas offcanvas-top purchase-requests-offcanvas purchase-budget-offcanvas";
    panel.tabIndex = -1;
    panel.setAttribute("aria-labelledby", "purchaseBudgetsPanelLabel");
    panel.innerHTML = `
      <div class="offcanvas-header">
        <div>
          <h2 class="offcanvas-title h4 mb-1" id="purchaseBudgetsPanelLabel">Presupuestos de compras</h2>
          <div class="text-muted small">Asignación por zona, compromisos pendientes y gasto real recibido.</div>
        </div>
        <button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="Cerrar"></button>
      </div>
      <div class="offcanvas-body" id="purchaseBudgetsPanelBody">
        <div class="text-center text-muted py-5">Abre o actualiza el panel para consultar presupuestos.</div>
      </div>`;
    document.body.appendChild(panel);
  }
}

function budgetStatusClass(allocated, available) {
  if (available < -0.005) return "purchase-budget-negative";
  if (allocated > 0 && available <= allocated * 0.1) return "purchase-budget-warning";
  return "";
}

function uniqueBudgetValues(lines, field, labelField) {
  const map = new Map();
  lines.forEach(line => {
    const value = String(line?.[field] || "");
    if (!value) return;
    if (!map.has(value)) map.set(value, String(line?.[labelField] || value));
  });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "es", { numeric: true }));
}

function filteredBudgetLines() {
  return budgetFinancialLines.filter(line => {
    if (budgetFilterZone !== "all" && String(line.zoneId || "") !== budgetFilterZone) return false;
    if (budgetFilterSubzone !== "all" && String(line.subzoneId || "") !== budgetFilterSubzone) return false;
    const area = String(line.locationCode || line.locationId || "");
    if (budgetFilterArea !== "all" && area !== budgetFilterArea) return false;
    return true;
  });
}

function budgetBreakdownRows(lines = filteredBudgetLines()) {
  const map = new Map();
  for (const line of lines) {
    const f = budgetLineFinancials(line);
    if (f.currency !== "MXN") continue;
    const zoneId = String(line.zoneId || "");
    const subzoneId = String(line.subzoneId || "");
    const areaId = String(line.locationCode || line.locationId || "");
    const key = `${zoneId}|${subzoneId}|${areaId}`;
    if (!map.has(key)) map.set(key, {
      zoneId,
      zoneName: line.zoneName || "Sin zona",
      subzoneId,
      subzoneName: line.subzoneName || "Sin subzona",
      areaId,
      areaName: line.locationName || "Sin área",
      committed: 0,
      spent: 0,
      expected: 0,
      released: 0,
    });
    const row = map.get(key);
    row.committed += f.committed;
    row.spent += f.actualSpent;
    row.expected += f.expectedOriginal;
    row.released += f.released;
  }
  return [...map.values()].sort((a, b) =>
    a.zoneId.localeCompare(b.zoneId, "es", { numeric: true })
    || a.subzoneId.localeCompare(b.subzoneId, "es", { numeric: true })
    || a.areaId.localeCompare(b.areaId, "es", { numeric: true })
  );
}

function renderBudgetReport() {
  const target = document.querySelector("#purchaseBudgetReport");
  if (!target) return;
  const rows = budgetBreakdownRows();
  if (!rows.length) {
    target.innerHTML = `<div class="text-muted py-3">No hay movimientos de compras para los filtros seleccionados.</div>`;
    return;
  }
  target.innerHTML = `
    <div class="table-responsive">
      <table class="table table-sm purchase-budget-report-table">
        <thead><tr><th>Zona</th><th>Subzona</th><th>Área</th><th class="text-end">Comprometido</th><th class="text-end">Gasto real</th><th class="text-end">Cancelado/liberado</th><th class="text-end">Carga actual</th></tr></thead>
        <tbody>
          ${rows.map(row => `
            <tr>
              <td>${reportEscape(`${row.zoneId} · ${row.zoneName}`)}</td>
              <td>${reportEscape(`${row.subzoneId} · ${row.subzoneName}`)}</td>
              <td>${reportEscape(`${row.areaId} ${row.areaName}`.trim())}</td>
              <td class="text-end">${reportEscape(formatCurrencyWithCode(row.committed, "MXN"))}</td>
              <td class="text-end">${reportEscape(formatCurrencyWithCode(row.spent, "MXN"))}</td>
              <td class="text-end">${reportEscape(formatCurrencyWithCode(row.released, "MXN"))}</td>
              <td class="text-end fw-semibold">${reportEscape(formatCurrencyWithCode(row.committed + row.spent, "MXN"))}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

function renderBudgetPanel() {
  const body = document.querySelector("#purchaseBudgetsPanelBody");
  if (!body) return;
  const zones = zoneCatalog();
  const usage = budgetUsageByZone();
  const totalAllocated = zones.reduce((sum, zone) => sum + budgetAllocated(zone.zoneId), 0);
  const totalCommitted = [...usage.values()].reduce((sum, row) => sum + row.committed, 0);
  const totalSpent = [...usage.values()].reduce((sum, row) => sum + row.spent, 0);
  const totalAvailable = totalAllocated - totalCommitted - totalSpent;
  const foreignLines = budgetFinancialLines.filter(line => budgetLineFinancials(line).currency !== "MXN");
  const subzones = uniqueBudgetValues(budgetFinancialLines, "subzoneId", "subzoneName");
  const areas = uniqueBudgetValues(budgetFinancialLines, "locationCode", "locationName");

  body.innerHTML = `
    <div class="d-flex flex-wrap justify-content-between align-items-end gap-3 mb-3">
      <div>
        <label class="form-label small mb-1" for="purchaseBudgetYear">Ejercicio</label>
        <input id="purchaseBudgetYear" class="form-control" type="number" min="2020" max="2100" value="${budgetReportYear}" style="max-width:140px">
      </div>
      <button type="button" class="btn btn-outline-dark btn-sm" id="refreshPurchaseBudgets">Actualizar presupuestos</button>
    </div>

    <div class="purchase-budget-summary-grid">
      <div class="purchase-budget-summary-card"><div class="purchase-budget-summary-label">Asignado</div><div class="purchase-budget-summary-value">${reportEscape(formatCurrencyWithCode(totalAllocated, "MXN"))}</div></div>
      <div class="purchase-budget-summary-card"><div class="purchase-budget-summary-label">Comprometido</div><div class="purchase-budget-summary-value">${reportEscape(formatCurrencyWithCode(totalCommitted, "MXN"))}</div></div>
      <div class="purchase-budget-summary-card"><div class="purchase-budget-summary-label">Gasto real</div><div class="purchase-budget-summary-value">${reportEscape(formatCurrencyWithCode(totalSpent, "MXN"))}</div></div>
      <div class="purchase-budget-summary-card"><div class="purchase-budget-summary-label">Disponible</div><div class="purchase-budget-summary-value ${totalAvailable < 0 ? "purchase-budget-negative" : ""}">${reportEscape(formatCurrencyWithCode(totalAvailable, "MXN"))}</div></div>
    </div>

    ${foreignLines.length ? `<div class="purchase-budget-foreign-warning"><strong>Atención:</strong> hay ${foreignLines.length} línea${foreignLines.length === 1 ? "" : "s"} de compra en moneda distinta de MXN. No se incluyen en el consumo presupuestal hasta que el precio esperado esté expresado en MXN.</div>` : ""}

    <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
      <h3 class="h6 mb-0">Asignación por zona</h3>
      <span class="small text-muted">Sólo Administrador puede modificar la asignación.</span>
    </div>
    <div class="table-responsive mb-4">
      <table class="table table-sm purchase-budget-zone-table">
        <thead><tr><th>Zona</th><th class="text-end">Asignado</th><th class="text-end">Comprometido</th><th class="text-end">Gasto real</th><th class="text-end">Disponible</th><th class="text-end">Asignación</th></tr></thead>
        <tbody>
          ${zones.map(zone => {
            const row = usage.get(zone.zoneId) || { committed: 0, spent: 0 };
            const allocated = budgetAllocated(zone.zoneId);
            const available = allocated - row.committed - row.spent;
            const cls = budgetStatusClass(allocated, available);
            return `<tr>
              <td><strong>${reportEscape(zone.zoneId)}</strong> · ${reportEscape(zone.zoneName)}</td>
              <td class="text-end">${reportEscape(formatCurrencyWithCode(allocated, "MXN"))}</td>
              <td class="text-end">${reportEscape(formatCurrencyWithCode(row.committed, "MXN"))}</td>
              <td class="text-end">${reportEscape(formatCurrencyWithCode(row.spent, "MXN"))}</td>
              <td class="text-end ${cls}">${reportEscape(formatCurrencyWithCode(available, "MXN"))}</td>
              <td class="text-end">
                ${currentAccessRole === "admin" ? `<div class="d-inline-flex gap-1 align-items-center"><input class="form-control form-control-sm purchase-budget-zone-input" type="number" min="0" step="0.01" value="${allocated}" data-zone-id="${reportEscape(zone.zoneId)}" data-zone-name="${reportEscape(zone.zoneName)}"><button type="button" class="btn btn-dark btn-sm budget-save-zone" data-zone-id="${reportEscape(zone.zoneId)}">Guardar</button></div>` : `<span class="text-muted">Sólo lectura</span>`}
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>

    <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
      <h3 class="h6 mb-0">Reporte de gastos y compromisos</h3>
      <button type="button" class="btn btn-outline-success btn-sm" id="exportBudgetReportXlsx">Exportar Excel</button>
    </div>
    <div class="row g-2 mb-3">
      <div class="col-lg-4"><label class="form-label small mb-1">Zona</label><select id="budgetFilterZone" class="form-select form-select-sm"><option value="all">Todas las zonas</option>${zones.map(zone => `<option value="${reportEscape(zone.zoneId)}" ${budgetFilterZone === zone.zoneId ? "selected" : ""}>${reportEscape(`${zone.zoneId} · ${zone.zoneName}`)}</option>`).join("")}</select></div>
      <div class="col-lg-4"><label class="form-label small mb-1">Subzona</label><select id="budgetFilterSubzone" class="form-select form-select-sm"><option value="all">Todas las subzonas</option>${subzones.map(([id,name]) => `<option value="${reportEscape(id)}" ${budgetFilterSubzone === id ? "selected" : ""}>${reportEscape(`${id} · ${name}`)}</option>`).join("")}</select></div>
      <div class="col-lg-4"><label class="form-label small mb-1">Área</label><select id="budgetFilterArea" class="form-select form-select-sm"><option value="all">Todas las áreas</option>${areas.map(([id,name]) => `<option value="${reportEscape(id)}" ${budgetFilterArea === id ? "selected" : ""}>${reportEscape(`${id} · ${name}`)}</option>`).join("")}</select></div>
    </div>
    <div id="purchaseBudgetReport"></div>`;
  renderBudgetReport();
}

async function refreshBudgetPanel() {
  if (budgetUiBusy) return;
  budgetUiBusy = true;
  const body = document.querySelector("#purchaseBudgetsPanelBody");
  if (body) body.innerHTML = `<div class="text-center text-muted py-5">Calculando presupuesto y gastos…</div>`;
  try {
    await Promise.all([loadBudgetZones(), loadBudgetAllocations(budgetReportYear), loadBudgetFinancialLines(budgetReportYear)]);
    renderBudgetPanel();
  } catch (error) {
    console.error(error);
    if (body) body.innerHTML = `<div class="alert alert-danger">No se pudo cargar Presupuestos: ${reportEscape(error.message)}</div>`;
  } finally {
    budgetUiBusy = false;
  }
}

async function saveZoneBudget(zoneId) {
  if (currentAccessRole !== "admin") return;
  const input = document.querySelector(`.purchase-budget-zone-input[data-zone-id="${CSS.escape(String(zoneId))}"]`);
  if (!input) return;
  const allocatedAmount = Number(input.value);
  if (!Number.isFinite(allocatedAmount) || allocatedAmount < 0) {
    alert("El presupuesto asignado debe ser un número mayor o igual a cero.");
    return;
  }
  const zone = zoneCatalog().find(entry => entry.zoneId === String(zoneId));
  await setDoc(doc(db, "purchaseBudgets", budgetDocId(budgetReportYear, zoneId)), {
    year: Number(budgetReportYear),
    zoneId: String(zoneId),
    zoneName: zone?.zoneName || input.dataset.zoneName || `Zona ${zoneId}`,
    allocatedAmount,
    currency: "MXN",
    updatedBy: currentUser.uid,
    updatedByName: currentProfile?.nombre || currentUser.email || "",
    updatedAt: serverTimestamp(),
  }, { merge: true });
  await refreshBudgetPanel();
}

function exportBudgetReportXlsx() {
  if (!window.XLSX) {
    alert("No se pudo cargar la librería XLSX.");
    return;
  }
  const rows = budgetBreakdownRows();
  const usage = budgetUsageByZone();
  const zones = zoneCatalog();
  if (!rows.length && !zones.length) {
    alert("No hay información presupuestal para exportar.");
    return;
  }

  const summaryAoa = [["Ejercicio", "Zona", "Nombre zona", "Presupuesto asignado", "Comprometido", "Gasto real", "Disponible"],
    ...zones.map(zone => {
      const row = usage.get(zone.zoneId) || { committed: 0, spent: 0 };
      const allocated = budgetAllocated(zone.zoneId);
      return [budgetReportYear, zone.zoneId, zone.zoneName, allocated, row.committed, row.spent, allocated - row.committed - row.spent];
    })];

  const detailAoa = [["Ejercicio", "Zona", "Nombre zona", "Subzona", "Nombre subzona", "Área", "Nombre área", "Comprometido", "Gasto real", "Cancelado/liberado", "Carga actual"],
    ...rows.map(row => [budgetReportYear, row.zoneId, row.zoneName, row.subzoneId, row.subzoneName, row.areaId, row.areaName, row.committed, row.spent, row.released, row.committed + row.spent])];

  const filterAoa = [
    ["Filtro", "Valor"],
    ["Ejercicio", budgetReportYear],
    ["Zona", budgetFilterZone === "all" ? "Todas" : budgetFilterZone],
    ["Subzona", budgetFilterSubzone === "all" ? "Todas" : budgetFilterSubzone],
    ["Área", budgetFilterArea === "all" ? "Todas" : budgetFilterArea],
  ];

  const wsSummary = XLSX.utils.aoa_to_sheet(summaryAoa);
  wsSummary["!cols"] = [{wch:10},{wch:10},{wch:28},{wch:20},{wch:16},{wch:16},{wch:16}];
  for (let r=2; r<=summaryAoa.length; r++) ["D","E","F","G"].forEach(col => setXlsxNumericCell(wsSummary, `${col}${r}`, '"$"#,##0.00'));

  const wsDetail = XLSX.utils.aoa_to_sheet(detailAoa);
  wsDetail["!cols"] = [{wch:10},{wch:10},{wch:24},{wch:12},{wch:28},{wch:14},{wch:30},{wch:16},{wch:16},{wch:18},{wch:16}];
  for (let r=2; r<=detailAoa.length; r++) ["H","I","J","K"].forEach(col => setXlsxNumericCell(wsDetail, `${col}${r}`, '"$"#,##0.00'));

  const wsFilters = XLSX.utils.aoa_to_sheet(filterAoa);
  wsFilters["!cols"] = [{wch:18},{wch:30}];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsSummary, "Resumen zonas");
  XLSX.utils.book_append_sheet(wb, wsDetail, "Zona subzona area");
  XLSX.utils.book_append_sheet(wb, wsFilters, "Filtros");
  XLSX.writeFile(wb, `presupuesto_compras_${budgetReportYear}.xlsx`, { bookType: "xlsx", compression: true });
}

function bindBudgetActions() {
  const panel = document.querySelector("#purchaseBudgetsPanel");
  panel?.addEventListener("show.bs.offcanvas", () => refreshBudgetPanel());

  document.addEventListener("click", async event => {
    const save = event.target.closest(".budget-save-zone");
    if (save) {
      try { await saveZoneBudget(save.dataset.zoneId); }
      catch (error) { console.error(error); alert(`No se pudo guardar el presupuesto: ${error.message}`); }
      return;
    }
    if (event.target.closest("#refreshPurchaseBudgets")) {
      await refreshBudgetPanel();
      return;
    }
    if (event.target.closest("#exportBudgetReportXlsx")) {
      exportBudgetReportXlsx();
    }
  });

  document.addEventListener("change", async event => {
    if (event.target.matches("#purchaseBudgetYear")) {
      const year = Number(event.target.value);
      if (Number.isInteger(year) && year >= 2020 && year <= 2100) {
        budgetReportYear = year;
        budgetFilterZone = budgetFilterSubzone = budgetFilterArea = "all";
        await refreshBudgetPanel();
      }
      return;
    }
    if (event.target.matches("#budgetFilterZone")) budgetFilterZone = event.target.value;
    else if (event.target.matches("#budgetFilterSubzone")) budgetFilterSubzone = event.target.value;
    else if (event.target.matches("#budgetFilterArea")) budgetFilterArea = event.target.value;
    else return;
    renderBudgetReport();
  });
}

function bindExportOverrides() {
  document.addEventListener("click", event => {
    const exportInventory = event.target.closest("#exportXlsx");
    const exportReport = event.target.closest("#exportPurchaseReport");
    const exportPdf = event.target.closest("#exportPurchasePdf");
    if (!exportInventory && !exportReport && !exportPdf) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (exportPdf) {
      exportPurchaseReportPdf();
      return;
    }

    const rows = effectiveRows();
    if (exportInventory) exportVisibleXlsx(rows);
    else exportPurchaseReportXlsx(rows);
  }, true);
}

function observePurchaseCards() {
  const itemsList = document.querySelector("#itemsList");
  if (!itemsList) return;

  // Sólo observamos altas/bajas de tarjetas DIRECTAMENTE dentro de itemsList.
  // No observamos el subárbol: los cambios internos que hace este mismo módulo
  // (prioridad, costos, estado, botones) no deben volver a disparar otro ciclo
  // completo de decoración.
  observer = new MutationObserver(mutations => {
    const cardsChanged = mutations.some(mutation =>
      mutation.type === "childList" &&
      (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)
    );
    if (cardsChanged) queueEnhancements();
  });
  observer.observe(itemsList, { childList: true, subtree: false });
}

async function loadPurchaseItems() {
  const snapshot = await getDocs(query(collection(db, "items"), where("activo", "==", true)));
  itemsById.clear();
  snapshot.docs.forEach(itemDoc => {
    itemsById.set(itemDoc.id, { id: itemDoc.id, ...itemDoc.data() });
  });
}

async function initPurchaseWorkflow() {
  injectStyles();

  const user = await waitForUser();
  if (!user) {
    window.location.replace("login.html");
    return;
  }

  const profile = await getUserProfile(user.uid);
  currentUser = user;
  currentProfile = profile;
  currentAccessRole = profile?.appRole || profile?.role || "";

  if (!ALLOWED_ROLES.has(currentAccessRole)) {
    alert("La sección de Compras está disponible únicamente para Administrador y Supervisor.");
    window.location.replace("index.html");
    return;
  }

  // Mostramos la página inmediatamente después de validar el acceso.
  revealPage();

  addFilters();
  addPrioritySortOption();
  addLegend();
  addBulkPurchaseToolbar();
  addPdfReportButton();
  injectPurchaseRequestManager();
  bindPurchaseActions();
  bindBulkPurchaseActions();
  bindPurchaseRequestManagerActions();
  bindBudgetActions();
  bindExportOverrides();

  // Datos del inventario y solicitudes se cargan con la página ya visible.
  await Promise.all([loadPurchaseItems(), loadPurchaseRequests()]);

  // Migra una sola vez las compras antiguas que estaban marcadas como ordered
  // antes de existir el sistema formal de solicitudes.
  await migrateLegacyOrdersIfNeeded();

  await loadCurrentDraft();
  renderPurchaseRequestManager();

  observePurchaseCards();
  queueEnhancements();
}

initPurchaseWorkflow().catch(error => {
  console.error("No se pudo inicializar el flujo de Compras:", error);
  alert(`No se pudo abrir Compras: ${error.message}`);
  window.location.replace("index.html");
});
