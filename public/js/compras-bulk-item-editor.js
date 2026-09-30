import { db } from "./firebase-app.js";
import { waitForUser, getUserProfile, uploadItemAsset, fileViewUrl } from "./common.js";
import {
  collection,
  doc,
  getDocs,
  getDocFromServer,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/*
 * Editor masivo de items para Compras (solo administrador).
 *
 * Principios de seguridad operativa:
 * - Nunca permite editar SKU.
 * - Solo se edita UNA propiedad por operación.
 * - Dos modos: mismo valor para todos o valores diferenciados por item.
 * - La selección usa el conjunto lógico completo del filtro actual, aunque el
 *   render progresivo solo haya materializado una parte de las tarjetas.
 */

const ITEM_TYPES = [
  "Máquina",
  "Mobiliario",
  "Cómputo",
  "Herramienta",
  "Consumible",
  "Material",
  "Refacción",
  "Accesorio",
  "Equipo auxiliar",
  "Equipo de seguridad",
  "Kit",
  "Otro",
];

const selectedItemIds = new Set();
const itemsById = new Map();
const livePatchedItemIds = new Set();
let logicalItemIds = [];
let zones = [];
let subzones = [];
let locations = [];
let weeks = [];
let modalInstance = null;
let saving = false;
let refreshingVisible = false;

const PROPERTY_DEFS = [
  { key: "nombre", label: "Nombre", kind: "text", group: "Datos generales", required: true },
  { key: "tipo", label: "Tipo", kind: "itemType", group: "Datos generales" },
  { key: "descripcion", label: "Descripción", kind: "textarea", group: "Datos generales" },
  { key: "locationRoute", label: "Ubicación física (zona / subzona / área)", kind: "location", group: "Ubicación" },
  { key: "relatedMachineId", label: "Máquina relacionada", kind: "machine", group: "Ubicación" },
  { key: "fabacademyWeeks", label: "Semanas FabAcademy", kind: "weeks", group: "Clasificación" },
  { key: "visibleParaAlumno", label: "Visible para alumnos", kind: "boolean", group: "Visibilidad y acciones" },
  { key: "prestamoHabilitado", label: "Se puede prestar", kind: "boolean", group: "Visibilidad y acciones" },
  { key: "reservaHabilitada", label: "Reservable / asistencia", kind: "boolean", group: "Visibilidad y acciones" },
  { key: "requiereAsistencia", label: "Requiere técnico", kind: "boolean", group: "Visibilidad y acciones" },
  { key: "stockAlmacen", label: "Stock almacén", kind: "number", group: "Cantidades", min: 0, integer: true, sensitiveStock: true },
  { key: "inventarioDeseado", label: "Inventario deseado", kind: "number", group: "Cantidades", min: 0, integer: true },
  { key: "stockPrestadoTemporal", label: "Prestado temporal", kind: "number", group: "Cantidades", min: 0, integer: true, sensitiveStock: true },
  { key: "stockLargoPlazo", label: "Largo plazo", kind: "number", group: "Cantidades", min: 0, integer: true, sensitiveStock: true },
  { key: "stockDanado", label: "Dañado", kind: "number", group: "Cantidades", min: 0, integer: true, sensitiveStock: true },
  { key: "stockPerdido", label: "Perdido", kind: "number", group: "Cantidades", min: 0, integer: true, sensitiveStock: true },
  { key: "precioUnitario", label: "Precio unitario", kind: "number", group: "Compras", min: 0, step: 0.01 },
  { key: "moneda", label: "Moneda", kind: "currency", group: "Compras" },
  { key: "purchaseUrl", label: "Liga de compra", kind: "url", group: "Compras" },
  { key: "infoUrl", label: "Más info URL", kind: "url", group: "Compras" },
  { key: "purchasePriority", label: "Prioridad de compra", kind: "priority", group: "Compras" },
  { key: "imageFile", label: "Imagen del item", kind: "imageFile", group: "Archivos" },
  { key: "documentationFile", label: "Documentación / manual / ficha", kind: "documentFile", group: "Archivos" },
  { key: "activo", label: "Item activo", kind: "boolean", group: "Administración" },
];

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function roleFromProfile(profile) {
  return profile?.appRole || profile?.role || "";
}

function propertyDef(key) {
  return PROPERTY_DEFS.find(def => def.key === key) || PROPERTY_DEFS[0];
}

function zoneCode(zone) {
  return String(zone?.zoneId ?? zone?.id ?? "");
}

function subzoneCode(subzone) {
  return String(subzone?.subzoneId ?? subzone?.id ?? "");
}

function locationId(location) {
  return String(location?.locationId ?? location?.id ?? "");
}

function locationCode(location) {
  return String(location?.areaCode || location?.locationCode || location?.subzoneId || "");
}

function locationLabel(location) {
  if (!location) return "Sin área específica";
  const z = String(location.zoneId ?? "");
  const s = String(location.subzoneId ?? "");
  const code = locationCode(location);
  const name = String(location.name || "Sin nombre");
  return [z, s, code, name].filter(Boolean).join(" · ");
}

function weekLabel(week) {
  return `${week.weekId ?? ""}${week.name ? ` · ${week.name}` : ""}`;
}

function currentLocationForItem(item) {
  return locations.find(loc => locationId(loc) === String(item?.locationId || "")) || null;
}

function currentMachineForItem(item) {
  return locations.find(loc => locationId(loc) === String(item?.relatedMachineId || "")) || null;
}

function getLogicalIds() {
  const perfIds = window.__purchasePerformance?.getLogicalItemIds?.();
  if (Array.isArray(perfIds) && perfIds.length) return perfIds.map(String);

  const domIds = [...document.querySelectorAll("#itemsList .item-card[data-item-id]")]
    .filter(card => !card.classList.contains("d-none"))
    .map(card => String(card.dataset.itemId || ""))
    .filter(Boolean);

  if (domIds.length) return domIds;
  return Array.isArray(perfIds) ? perfIds.map(String) : [];
}

function selectedItems() {
  return [...selectedItemIds]
    .map(id => itemsById.get(String(id)))
    .filter(Boolean)
    .sort((a, b) =>
      String(a.zoneId || "").localeCompare(String(b.zoneId || ""), "es", { numeric: true })
      || String(a.subzoneId || "").localeCompare(String(b.subzoneId || ""), "es", { numeric: true })
      || String(a.sku || "").localeCompare(String(b.sku || ""), "es", { numeric: true })
    );
}

function syncLogicalIds(nextIds = null) {
  logicalItemIds = (nextIds || getLogicalIds()).map(String);
  const logicalSet = new Set(logicalItemIds);
  for (const id of [...selectedItemIds]) {
    if (!logicalSet.has(String(id))) selectedItemIds.delete(String(id));
  }
  updateToolbar();
  decorateCards();
}

function injectStyles() {
  if (document.querySelector("#bulkItemEditorStyles")) return;
  const style = document.createElement("style");
  style.id = "bulkItemEditorStyles";
  style.textContent = `
    #bulkItemEditToolbar { border-left: 6px solid #212529; }
    #bulkItemEditToolbar .bulk-item-editor-title { font-weight: 700; font-size: 1.05rem; }
    #purchaseBulkToolbar .purchase-bulk-section-heading {
      flex: 0 0 100%; width: 100%; padding-bottom: .65rem; margin-bottom: .1rem;
      border-bottom: 1px solid #e9ecef;
    }
    #purchaseBulkToolbar .purchase-bulk-section-title { font-weight: 700; font-size: 1.05rem; color: #212529; }
    #purchaseBulkToolbar .purchase-bulk-section-subtitle { color: #6c757d; font-size: .88rem; margin-top: .1rem; }
    #bulkItemEditToolbar .bulk-item-editor-subtitle { color: #6c757d; font-size: .9rem; }
    .bulk-item-card-selector {
      display:flex; align-items:center; gap:.45rem; padding:.45rem .6rem; margin-bottom:.7rem;
      border:1px solid #dee2e6; background:#f8f9fa; border-radius:.5rem; width:max-content; max-width:100%;
    }
    .bulk-item-card-selector label { cursor:pointer; font-size:.82rem; font-weight:700; }
    .bulk-item-card-selector input { cursor:pointer; margin-top:0; }
    .item-card.bulk-edit-selected { box-shadow:0 0 0 3px rgba(13,110,253,.2); }
    #bulkItemEditorModal .bulk-editor-table-wrap { max-height:55vh; overflow:auto; border:1px solid #dee2e6; }
    #bulkItemEditorModal .bulk-editor-table { margin-bottom:0; min-width:900px; }
    #bulkItemEditorModal .bulk-editor-table thead th { position:sticky; top:0; z-index:2; background:#fff; box-shadow:inset 0 -1px 0 #dee2e6; }
    #bulkItemEditorModal .bulk-current-value { color:#6c757d; font-size:.84rem; max-width:360px; white-space:normal; }
    #bulkItemEditorModal .bulk-editor-help { color:#6c757d; font-size:.88rem; }
    #bulkItemEditorModal .bulk-editor-warning { border-left:5px solid #f0ad00; }
    #bulkItemEditorModal .bulk-file-progress { font-size:.85rem; color:#6c757d; }
    #bulkItemEditorModal .bulk-uniform-control { max-width:760px; }
    #bulkItemEditorModal select[multiple] { min-height:140px; }
    #purchaseLiveRefreshButton {
      position:fixed; right:18px; bottom:20px; z-index:1045;
      display:inline-flex; align-items:center; gap:.5rem; border-radius:999px;
      box-shadow:0 .35rem 1rem rgba(0,0,0,.18); padding:.65rem 1rem;
      font-weight:700;
    }
    #purchaseLiveRefreshButton .refresh-icon { display:inline-block; font-size:1.05rem; line-height:1; }
    #purchaseLiveRefreshButton.is-refreshing .refresh-icon { animation:purchaseRefreshSpin .8s linear infinite; }
    @keyframes purchaseRefreshSpin { to { transform:rotate(360deg); } }
    @media (max-width: 767.98px) {
      .bulk-item-card-selector { width:100%; }
      #bulkItemEditToolbar .bulk-editor-actions { width:100%; }
      #bulkItemEditToolbar .bulk-editor-actions .btn { flex:1 1 auto; }
    }
  `;
  document.head.appendChild(style);
}

function addToolbar() {
  if (document.querySelector("#bulkItemEditToolbar")) return;
  const filterCard = document.querySelector(".filter-card");
  if (!filterCard?.parentNode) return;

  const section = document.createElement("section");
  section.id = "bulkItemEditToolbar";
  section.className = "card mb-4";
  section.innerHTML = `
    <div class="card-body">
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-3">
        <div>
          <div class="bulk-item-editor-title">Editor masivo de items</div>
          <div class="bulk-item-editor-subtitle">Solo administrador · selecciona items y modifica una sola propiedad por operación. El SKU nunca se edita aquí.</div>
        </div>
        <span class="badge text-bg-dark" id="bulkItemSelectedBadge">0 seleccionados</span>
      </div>
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-3 mt-3">
        <div class="form-check mb-0">
          <input class="form-check-input" type="checkbox" id="bulkItemSelectFiltered">
          <label class="form-check-label fw-semibold" for="bulkItemSelectFiltered">Seleccionar todos los resultados del filtro</label>
          <div class="form-text" id="bulkItemFilterMeta">0 items en el filtro actual</div>
        </div>
        <div class="d-flex flex-wrap gap-2 bulk-editor-actions">
          <button type="button" class="btn btn-outline-secondary btn-sm" id="bulkItemClearSelection" disabled>Limpiar selección</button>
          <button type="button" class="btn btn-primary btn-sm" id="bulkItemOpenEditor" disabled>Editar selección</button>
        </div>
      </div>
    </div>`;

  filterCard.insertAdjacentElement("afterend", section);
}

function labelPurchaseRequestBulkToolbar() {
  const toolbar = document.querySelector("#purchaseBulkToolbar");
  if (!toolbar || toolbar.querySelector(".purchase-bulk-section-heading")) return Boolean(toolbar);

  const heading = document.createElement("div");
  heading.className = "purchase-bulk-section-heading";
  heading.innerHTML = `
    <div class="purchase-bulk-section-title">Agregar a Solicitud de compra</div>
    <div class="purchase-bulk-section-subtitle">Selecciona los artículos del filtro que quieres agregar al borrador de una Solicitud de compra.</div>`;
  toolbar.prepend(heading);
  return true;
}

function addFloatingRefreshButton() {
  if (document.querySelector("#purchaseLiveRefreshButton")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.id = "purchaseLiveRefreshButton";
  button.className = "btn btn-dark";
  button.title = "Actualizar los datos visibles sin perder filtros ni posición";
  button.setAttribute("aria-label", "Actualizar datos visibles");
  button.innerHTML = '<span class="refresh-icon" aria-hidden="true">↻</span><span class="refresh-label">Actualizar</span>';
  document.body.appendChild(button);
}

function addModal() {
  if (document.querySelector("#bulkItemEditorModal")) return;
  const modal = document.createElement("div");
  modal.className = "modal fade";
  modal.id = "bulkItemEditorModal";
  modal.tabIndex = -1;
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `
    <div class="modal-dialog modal-xl modal-dialog-scrollable">
      <div class="modal-content">
        <div class="modal-header">
          <div>
            <h5 class="modal-title mb-1">Editor masivo de items</h5>
            <div class="small text-muted" id="bulkEditorSelectionSummary"></div>
          </div>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button>
        </div>
        <div class="modal-body">
          <div class="row g-3 align-items-end">
            <div class="col-lg-6">
              <label class="form-label fw-semibold" for="bulkEditorProperty">Propiedad a cambiar</label>
              <select id="bulkEditorProperty" class="form-select"></select>
              <div class="form-text">SKU está excluido deliberadamente. Solo puede modificarse una propiedad a la vez.</div>
            </div>
            <div class="col-lg-6">
              <div class="form-label fw-semibold">Modo de edición</div>
              <div class="d-flex flex-wrap gap-3">
                <label class="form-check">
                  <input class="form-check-input" type="radio" name="bulkEditorMode" value="uniform" checked>
                  <span class="form-check-label">Mismo valor para todos</span>
                </label>
                <label class="form-check">
                  <input class="form-check-input" type="radio" name="bulkEditorMode" value="individual">
                  <span class="form-check-label">Valores diferentes por item</span>
                </label>
              </div>
            </div>
          </div>

          <div id="bulkEditorWarning" class="alert alert-warning bulk-editor-warning mt-3 d-none"></div>
          <div id="bulkEditorBody" class="mt-3"></div>
        </div>
        <div class="modal-footer d-flex justify-content-between gap-2">
          <div class="bulk-file-progress" id="bulkEditorProgress"></div>
          <div class="d-flex gap-2">
            <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancelar</button>
            <button type="button" class="btn btn-primary" id="bulkEditorSave">Guardar cambios</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modalInstance = window.bootstrap?.Modal ? new window.bootstrap.Modal(modal) : null;
}

function groupedPropertyOptions() {
  const groups = new Map();
  PROPERTY_DEFS.forEach(def => {
    if (!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group).push(def);
  });
  return [...groups.entries()].map(([group, defs]) => `
    <optgroup label="${esc(group)}">
      ${defs.map(def => `<option value="${esc(def.key)}">${esc(def.label)}</option>`).join("")}
    </optgroup>`).join("");
}

function updateToolbar() {
  const toolbar = document.querySelector("#bulkItemEditToolbar");
  if (!toolbar) return;

  const logicalSet = new Set(logicalItemIds.map(String));
  const selectedVisible = [...selectedItemIds].filter(id => logicalSet.has(String(id))).length;
  const total = logicalItemIds.length;
  const selected = selectedItemIds.size;

  const master = toolbar.querySelector("#bulkItemSelectFiltered");
  const badge = toolbar.querySelector("#bulkItemSelectedBadge");
  const meta = toolbar.querySelector("#bulkItemFilterMeta");
  const clear = toolbar.querySelector("#bulkItemClearSelection");
  const open = toolbar.querySelector("#bulkItemOpenEditor");

  if (master) {
    master.disabled = total === 0 || saving;
    master.checked = total > 0 && selectedVisible === total;
    master.indeterminate = selectedVisible > 0 && selectedVisible < total;
  }
  if (badge) badge.textContent = `${selected} seleccionado${selected === 1 ? "" : "s"}`;
  if (meta) meta.textContent = `${total} item${total === 1 ? "" : "s"} en el filtro actual`;
  if (clear) clear.disabled = selected === 0 || saving;
  if (open) {
    open.disabled = selected === 0 || saving;
    open.textContent = selected ? `Editar selección (${selected})` : "Editar selección";
  }
}

function decorateCard(card) {
  const itemId = String(card?.dataset?.itemId || "");
  if (!itemId) return;
  const body = card.querySelector(".card-body");
  if (!body) return;

  let wrapper = body.querySelector(".bulk-item-card-selector");
  if (!wrapper) {
    wrapper = document.createElement("div");
    wrapper.className = "bulk-item-card-selector";
    body.prepend(wrapper);
  }

  const item = itemsById.get(itemId);
  const sku = String(item?.sku || "");
  const signature = `${itemId}|${sku}`;

  // Importante: no reescribir innerHTML en cada pasada. Hacerlo dispara
  // mutaciones del DOM y puede provocar un ciclo de renderizado continuo.
  if (wrapper.dataset.signature !== signature || !wrapper.querySelector(".bulk-item-edit-check")) {
    wrapper.dataset.signature = signature;
    wrapper.innerHTML = `
      <input class="form-check-input bulk-item-edit-check" type="checkbox" id="bulk-edit-${esc(itemId)}" data-id="${esc(itemId)}">
      <label for="bulk-edit-${esc(itemId)}">Edición masiva${sku ? ` · ${esc(sku)}` : ""}</label>`;
  }

  const checkbox = wrapper.querySelector(".bulk-item-edit-check");
  if (checkbox) checkbox.checked = selectedItemIds.has(itemId);
  card.classList.toggle("bulk-edit-selected", selectedItemIds.has(itemId));
}

function decorateCards() {
  document.querySelectorAll("#itemsList .item-card[data-item-id]").forEach(decorateCard);
}

function liveFormatCurrency(value, currency = "MXN") {
  const code = String(currency || "MXN").toUpperCase();
  try {
    return `${new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value || 0))} ${code}`;
  } catch (_) {
    return `$${Number(value || 0).toFixed(2)} ${code}`;
  }
}

function liveCurrentInventory(item) {
  return asNumber(item?.stockAlmacen) + asNumber(item?.stockPrestadoTemporal);
}

function liveDraftQty(card) {
  const text = card?.querySelector(".purchase-status-controls")?.textContent || "";
  const match = text.match(/En borrador:\s*(\d+)/i);
  return match ? asNumber(match[1]) : 0;
}

function liveAvailableToRequest(item, card) {
  const desired = asNumber(item?.inventarioDeseado);
  const current = liveCurrentInventory(item);
  const pending = Math.max(asNumber(item?.purchasePendingQty), 0);
  const draft = liveDraftQty(card);
  return Math.max(desired - current - pending - draft, 0);
}

function livePurchaseState(item, card) {
  const current = liveCurrentInventory(item);
  const desired = asNumber(item?.inventarioDeseado);
  const pending = Math.max(asNumber(item?.purchasePendingQty), 0);
  const requisition = Math.min(Math.max(asNumber(item?.purchaseRequisitionQty), 0), pending);
  const draft = liveDraftQty(card);
  const rawMissing = Math.max(desired - current, 0);
  const available = Math.max(rawMissing - pending - draft, 0);

  if (pending > 0 && requisition > 0) {
    return {
      key: "requisition", bandClass: "purchase-state-requisition", borderClass: "border-primary",
      badgeClass: "text-bg-primary", label: requisition >= pending ? "En requisición" : "En requisición parcial",
      current, desired, pending, requisition, draft, available,
      orderedWithoutRequisition: Math.max(pending - requisition, 0),
    };
  }
  if (pending > 0) {
    return {
      key: "ordered", bandClass: "purchase-state-ordered", borderClass: "border-warning",
      badgeClass: "text-bg-warning", label: "En compras", current, desired, pending, requisition: 0, draft, available,
    };
  }
  if (rawMissing <= 0) {
    return {
      key: "complete", bandClass: "purchase-state-complete", borderClass: "border-success",
      badgeClass: "text-bg-success", label: "Inventario completo", current, desired, pending: 0, requisition: 0, draft, available: 0,
    };
  }
  return {
    key: "missing", bandClass: "purchase-state-missing", borderClass: "border-danger",
    badgeClass: "text-bg-danger", label: "Falta comprar", current, desired, pending: 0, requisition: 0, draft, available,
  };
}

function livePluralPieces(value) {
  const n = asNumber(value);
  return `${n} pieza${n === 1 ? "" : "s"}`;
}

function liveStatusBodyHtml(item, state) {
  const draftBadge = state.draft > 0
    ? `<span class="badge text-bg-dark">En borrador: ${livePluralPieces(state.draft)}</span>`
    : "";
  const addLabel = state.draft > 0 ? "Editar cantidad" : "Agregar a solicitud";

  if (state.key === "complete") {
    return `
      <div class="d-flex flex-wrap gap-3 align-items-center justify-content-between">
        <div class="d-flex flex-wrap gap-2 align-items-center">
          <span class="badge ${state.badgeClass}">${state.label}</span>
          <span class="purchase-status-text">Inventario actual: <strong>${state.current}</strong> / deseado: <strong>${state.desired}</strong></span>
          ${draftBadge}
        </div>
        ${state.draft > 0 ? `<button type="button" class="btn btn-dark purchase-add-request-btn" data-id="${esc(item.id)}">${addLabel}</button>` : ""}
      </div>`;
  }

  if (state.key === "requisition") {
    return `
      <div class="d-flex flex-wrap gap-3 align-items-center justify-content-between">
        <div class="d-flex flex-column gap-1">
          <div class="d-flex flex-wrap gap-2 align-items-center">
            <span class="badge ${state.badgeClass}">${state.label}</span>
            <span class="purchase-status-text">En requisición: <strong>${livePluralPieces(state.requisition)}</strong></span>
            <span class="purchase-status-text">Pendiente total: <strong>${livePluralPieces(state.pending)}</strong></span>
            ${state.orderedWithoutRequisition > 0 ? `<span class="badge text-bg-warning">Sin requisición: ${livePluralPieces(state.orderedWithoutRequisition)}</span>` : ""}
            ${draftBadge}
          </div>
          ${state.available > 0 ? `<div class="purchase-status-note-danger">Aún disponible para solicitar adicionalmente: ${livePluralPieces(state.available)}</div>` : '<div class="purchase-status-note-muted">Las piezas en requisición siguen pendientes de recepción y todavía no aumentan el inventario.</div>'}
        </div>
        <div class="d-flex flex-wrap gap-2 align-items-center">
          <button type="button" class="btn btn-primary purchase-view-requests-btn" data-id="${esc(item.id)}">Ver solicitudes</button>
          ${state.available > 0 || state.draft > 0 ? `<button type="button" class="btn btn-danger purchase-add-request-btn" data-id="${esc(item.id)}">${addLabel}</button>` : ""}
        </div>
      </div>`;
  }

  if (state.key === "ordered") {
    return `
      <div class="d-flex flex-wrap gap-3 align-items-center justify-content-between">
        <div class="d-flex flex-column gap-1">
          <div class="d-flex flex-wrap gap-2 align-items-center">
            <span class="badge ${state.badgeClass}">${state.label}</span>
            <span class="purchase-status-text">Pendiente de recibir: <strong>${livePluralPieces(state.pending)}</strong></span>
            ${draftBadge}
          </div>
          ${state.available > 0 ? `<div class="purchase-status-note-danger">Aún disponible para solicitar: ${livePluralPieces(state.available)}</div>` : '<div class="purchase-status-note-muted">Todo lo faltante ya está cubierto por solicitudes activas.</div>'}
        </div>
        <div class="d-flex flex-wrap gap-2 align-items-center">
          <button type="button" class="btn btn-dark purchase-view-requests-btn" data-id="${esc(item.id)}">Ver solicitudes</button>
          ${state.available > 0 || state.draft > 0 ? `<button type="button" class="btn btn-danger purchase-add-request-btn" data-id="${esc(item.id)}">${addLabel}</button>` : ""}
        </div>
      </div>`;
  }

  return `
    <div class="d-flex flex-wrap gap-3 align-items-center justify-content-between">
      <div class="d-flex flex-column gap-1">
        <div class="d-flex flex-wrap gap-2 align-items-center">
          <span class="badge ${state.badgeClass}">${state.label}</span>
          <span class="purchase-status-text">Disponible para solicitar: <strong>${livePluralPieces(state.available)}</strong></span>
          ${draftBadge}
        </div>
        <div class="purchase-status-note-muted">Actual: ${state.current} / Deseado: ${state.desired}</div>
      </div>
      <button type="button" class="btn btn-danger purchase-add-request-btn" data-id="${esc(item.id)}">${addLabel}</button>
    </div>`;
}

function refreshLivePurchaseStatus(card, item) {
  const controls = card?.querySelector(".purchase-status-controls");
  if (!controls || !item) return;

  const state = livePurchaseState(item, card);
  const selector = controls.querySelector(".purchase-bulk-selector");
  const checkbox = selector?.querySelector(".purchase-bulk-checkbox");
  const wasChecked = Boolean(checkbox?.checked);

  selector?.remove();
  controls.classList.remove("purchase-state-missing", "purchase-state-ordered", "purchase-state-requisition", "purchase-state-complete");
  controls.classList.add(state.bandClass);
  controls.dataset.signature = `live|${state.key}|${state.current}|${state.desired}|${state.pending}|${state.requisition}|${state.available}|${state.draft}`;
  controls.innerHTML = liveStatusBodyHtml(item, state);

  if (selector) {
    const eligible = state.available > 0;
    selector.classList.toggle("is-disabled", !eligible);
    controls.prepend(selector);
    const liveCheckbox = selector.querySelector(".purchase-bulk-checkbox");
    if (liveCheckbox) {
      liveCheckbox.disabled = !eligible;
      liveCheckbox.checked = eligible && wasChecked;
      if (!eligible && wasChecked) {
        // Ya conectado al DOM: el listener delegado de Compras elimina también
        // este item de la selección masiva para Solicitud de compra.
        liveCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }

  card.classList.remove("border-success", "border-warning", "border-danger", "border-primary", "border-2");
  card.classList.add("border-2", state.borderClass);
}

function liveStatusBadges(item) {
  const badges = [];
  if (item.visibleParaAlumno === false) badges.push('<span class="badge text-bg-secondary">Oculto alumno</span>');
  if (item.prestamoHabilitado === true) badges.push('<span class="badge text-bg-primary">Prestable</span>');
  else badges.push('<span class="badge text-bg-light border">No prestable</span>');
  if (item.reservaHabilitada === true) badges.push('<span class="badge text-bg-warning">Reservable/asistencia</span>');
  if (item.requiereAsistencia === true) badges.push('<span class="badge text-bg-info">Requiere técnico</span>');
  return badges.join(" ");
}

function livePathHtml(item) {
  const zone = `${item.zoneId ?? ""}${item.zoneName ? ` · ${item.zoneName}` : ""}`.trim();
  const subzone = `${item.subzoneId ?? ""}${item.subzoneName ? ` · ${item.subzoneName}` : ""}`.trim();
  const areaCode = String(item.locationCode || item.subzoneId || "s/c");
  const areaName = String(item.locationName || "Sin ubicación");
  return `
    <span><strong>Zona:</strong> ${esc(zone || "Sin zona")}</span>
    <span><strong>Subzona:</strong> ${esc(subzone || "Sin subzona")}</span>
    <span><strong>Área:</strong> <span class="area-code-chip">${esc(areaCode)}</span> ${esc(areaName)}</span>`;
}

function refreshRenderedCard(itemId) {
  const id = String(itemId || "");
  const item = itemsById.get(id);
  const card = document.querySelector(`#itemsList .item-card[data-item-id="${CSS.escape(id)}"]`);
  if (!item || !card) return;

  const body = card.querySelector(".card-body");
  if (!body) return;

  const title = body.querySelector(".card-title");
  if (title) title.textContent = item.nombre || "Sin nombre";

  const headerMeta = [...body.querySelectorAll(".text-muted.small")]
    .find(el => el.textContent.includes("Disponible:") && el.textContent.includes("Deseado:"));
  if (headerMeta) {
    headerMeta.innerHTML =
      `${esc(item.sku || "")} · ${esc(item.tipo || "Otro")} · Disponible: <strong>${asNumber(item.stockAlmacen)}</strong> · Deseado: <strong>${asNumber(item.inventarioDeseado)}</strong>`;
  }

  const titleWrap = title?.parentElement;
  const badgeRow = titleWrap?.querySelector(".mt-1");
  if (badgeRow) badgeRow.innerHTML = liveStatusBadges(item);

  const cost = body.querySelector(".purchase-item-cost");
  if (cost) {
    const currency = item.moneda || "MXN";
    const price = asNumber(item.precioUnitario);
    const pending = Math.max(asNumber(item.purchasePendingQty), 0);
    const draft = liveDraftQty(card);
    const available = liveAvailableToRequest(item, card);
    const subtotal = available * price;
    cost.innerHTML = `
      <span><strong>Precio unitario:</strong> ${esc(liveFormatCurrency(price, currency))}</span>
      <span><strong>Pendiente de recibir:</strong> ${pending}</span>
      ${draft > 0 ? `<span><strong>En borrador:</strong> ${draft}</span>` : ""}
      <span><strong>Disponible para solicitar:</strong> ${available}</span>
      <span><strong>Subtotal disponible:</strong> ${esc(liveFormatCurrency(subtotal, currency))}</span>`;
    cost.dataset.purchaseCostSignature = `live|${currency}|${price}|${pending}|${draft}|${available}|${subtotal}`;
  }

  // La franja de Solicitud de compra usa un estado separado; se actualiza aquí
  // con el mismo item para no depender de una recarga completa de la página.
  refreshLivePurchaseStatus(card, item);

  const prioritySelect = body.querySelector(".purchase-priority-select");
  if (prioritySelect && document.activeElement !== prioritySelect) {
    prioritySelect.value = String([1, 2, 3].includes(Number(item.purchasePriority)) ? Number(item.purchasePriority) : 3);
  }

  const path = body.querySelector(".path-compact");
  if (path) path.innerHTML = livePathHtml(item);

  const description = body.querySelector(".card-text.mt-2");
  if (description) description.textContent = item.descripcion || "";

  const fabBlock = [...body.querySelectorAll(".small.mb-2")]
    .find(el => el.textContent.trim().startsWith("FabAcademy:"));
  if (fabBlock) {
    const names = Array.isArray(item.fabacademyWeekNames) ? item.fabacademyWeekNames : [];
    fabBlock.innerHTML = `<strong>FabAcademy:</strong> ${esc(names.join(", ") || "Sin clasificación")}`;
  }

  const relatedBlock = [...body.querySelectorAll(".small.mb-1")]
    .find(el => el.textContent.trim().startsWith("Máquina relacionada:"));
  if (item.relatedMachineName) {
    if (relatedBlock) {
      relatedBlock.innerHTML = `<strong>Máquina relacionada:</strong> ${esc(item.relatedMachineName)}`;
    } else if (fabBlock) {
      fabBlock.insertAdjacentHTML("beforebegin",
        `<div class="small mb-1"><strong>Máquina relacionada:</strong> ${esc(item.relatedMachineName)}</div>`);
    }
  } else {
    relatedBlock?.remove();
  }

  const image = card.querySelector(".item-image");
  if (image && item.imageFileId) {
    image.src = fileViewUrl(item.imageFileId);
    image.alt = item.nombre || "";
  }

  const infoLink = [...body.querySelectorAll("a.btn")].find(a => a.textContent.trim() === "Más info");
  if (item.infoUrl) {
    if (infoLink) infoLink.href = item.infoUrl;
  } else {
    infoLink?.remove();
  }

  const purchaseLink = [...body.querySelectorAll("a.btn")].find(a => a.textContent.trim() === "Info Compra");
  if (item.purchaseUrl) {
    if (purchaseLink) purchaseLink.href = item.purchaseUrl;
  } else {
    purchaseLink?.remove();
  }

  decorateCard(card);
}

function refreshRenderedCards(ids = null) {
  const targets = Array.isArray(ids)
    ? ids.map(String)
    : [...livePatchedItemIds];

  targets.forEach(refreshRenderedCard);
}

function scheduleLiveCardRefresh(ids = null) {
  [0, 70, 220].forEach(delay => {
    window.setTimeout(() => refreshRenderedCards(ids), delay);
  });
}

async function refreshOneItemFromFirestore(itemId) {
  const id = String(itemId || "");
  if (!id) return;
  try {
    const snap = await getDocFromServer(doc(db, "items", id));
    if (!snap.exists()) return;
    const fresh = { id: snap.id, ...snap.data() };
    itemsById.set(id, fresh);
    livePatchedItemIds.add(id);
    scheduleLiveCardRefresh([id]);
  } catch (error) {
    console.warn("No se pudo refrescar el item después de editarlo:", error);
  }
}

async function refreshVisibleItemsFromServer() {
  if (refreshingVisible) return;

  const button = document.querySelector("#purchaseLiveRefreshButton");
  const label = button?.querySelector(".refresh-label");
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const ids = [...document.querySelectorAll("#itemsList .item-card[data-item-id]")]
    .filter(card => !card.classList.contains("d-none"))
    .map(card => String(card.dataset.itemId || ""))
    .filter(Boolean);

  if (!ids.length) return;

  refreshingVisible = true;
  if (button) {
    button.disabled = true;
    button.classList.add("is-refreshing");
  }
  if (label) label.textContent = "Actualizando…";

  try {
    // Solo releemos las tarjetas materializadas/visibles. Así no se reconstruye
    // la lista completa de miles de items y se conserva exactamente el scroll.
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      const snapshots = await Promise.all(chunk.map(id => getDocFromServer(doc(db, "items", id))));
      snapshots.forEach(snap => {
        if (!snap.exists()) return;
        const fresh = { id: snap.id, ...snap.data() };
        itemsById.set(String(snap.id), fresh);
        livePatchedItemIds.add(String(snap.id));
      });
    }

    refreshRenderedCards(ids);
    decorateCards();
    window.requestAnimationFrame(() => window.scrollTo(scrollX, scrollY));
    if (label) label.textContent = "Actualizado ✓";
    window.setTimeout(() => { if (label) label.textContent = "Actualizar"; }, 1400);
  } catch (error) {
    console.error(error);
    if (label) label.textContent = "Error al actualizar";
    window.setTimeout(() => { if (label) label.textContent = "Actualizar"; }, 1800);
    alert(`No se pudieron actualizar los datos visibles: ${error.message}`);
  } finally {
    refreshingVisible = false;
    if (button) {
      button.disabled = false;
      button.classList.remove("is-refreshing");
    }
    window.requestAnimationFrame(() => window.scrollTo(scrollX, scrollY));
  }
}

async function loadData() {
  const [itemsSnap, zonesSnap, subzonesSnap, locationsSnap, weeksSnap] = await Promise.all([
    getDocs(query(collection(db, "items"), where("activo", "==", true))),
    getDocs(collection(db, "zones")),
    getDocs(collection(db, "subzones")),
    getDocs(collection(db, "locations")),
    getDocs(collection(db, "fabacademyWeeks")),
  ]);

  itemsById.clear();
  itemsSnap.docs.forEach(snap => itemsById.set(snap.id, { id: snap.id, ...snap.data() }));
  zones = zonesSnap.docs.map(snap => ({ id: snap.id, ...snap.data() }));
  subzones = subzonesSnap.docs.map(snap => ({ id: snap.id, ...snap.data() }));
  locations = locationsSnap.docs
    .map(snap => ({ id: snap.id, ...snap.data() }))
    .sort((a, b) => locationLabel(a).localeCompare(locationLabel(b), "es", { numeric: true, sensitivity: "base" }));
  weeks = weeksSnap.docs
    .map(snap => ({ id: snap.id, ...snap.data() }))
    .sort((a, b) => asNumber(a.weekId) - asNumber(b.weekId));
}

function refreshItemMapFromCatalog() {
  const rows = window.__purchaseCatalog?.getAllItems?.();
  if (!Array.isArray(rows)) return;
  rows.forEach(item => {
    if (item?.id) itemsById.set(String(item.id), { ...(itemsById.get(String(item.id)) || {}), ...item });
  });
}

function locationOptions(selected = "", includePlaceholder = true) {
  const opts = [];
  if (includePlaceholder) opts.push('<option value="__no_selection__">Selecciona una ubicación…</option>');
  opts.push(`<option value="__clear__" ${selected === "__clear__" ? "selected" : ""}>Sin área específica (conservar zona/subzona)</option>`);
  locations.forEach(loc => {
    const id = locationId(loc);
    const inactive = loc.active === false;
    const disabled = inactive && String(selected) !== id ? "disabled" : "";
    const suffix = inactive ? " · Inactiva" : "";
    opts.push(`<option value="${esc(id)}" ${String(selected) === id ? "selected" : ""} ${disabled}>${esc(locationLabel(loc) + suffix)}</option>`);
  });
  return opts.join("");
}

function machineOptions(selected = "", includePlaceholder = true) {
  const opts = [];
  if (includePlaceholder) opts.push('<option value="__no_selection__">Selecciona una máquina…</option>');
  opts.push(`<option value="__clear__" ${selected === "__clear__" ? "selected" : ""}>Ninguna máquina relacionada</option>`);
  locations.filter(loc => loc.type === "machine").forEach(loc => {
    const id = locationId(loc);
    const inactive = loc.active === false;
    const disabled = inactive && String(selected) !== id ? "disabled" : "";
    const suffix = inactive ? " · Inactiva" : "";
    opts.push(`<option value="${esc(id)}" ${String(selected) === id ? "selected" : ""} ${disabled}>${esc(locationLabel(loc) + suffix)}</option>`);
  });
  return opts.join("");
}

function weeksOptions(selected = []) {
  const set = new Set((selected || []).map(String));
  return weeks.map(week => {
    const value = String(week.weekId ?? week.id ?? "");
    return `<option value="${esc(value)}" ${set.has(value) ? "selected" : ""}>${esc(weekLabel(week))}</option>`;
  }).join("");
}

function itemTypeOptions(selected = "") {
  return ITEM_TYPES.map(value => `<option value="${esc(value)}" ${String(selected) === value ? "selected" : ""}>${esc(value)}</option>`).join("");
}

function currencyOptions(selected = "MXN", includePlaceholder = false) {
  const currencies = ["MXN", "USD", "EUR"];
  return `${includePlaceholder ? '<option value="__no_selection__">Selecciona moneda…</option>' : ""}${currencies.map(value => `<option value="${value}" ${String(selected) === value ? "selected" : ""}>${value}</option>`).join("")}`;
}

function booleanOptions(selected, includePlaceholder = false) {
  return `${includePlaceholder ? '<option value="__no_selection__">Selecciona…</option>' : ""}
    <option value="true" ${selected === true ? "selected" : ""}>Sí</option>
    <option value="false" ${selected === false ? "selected" : ""}>No</option>`;
}

function priorityOptions(selected = 3, includePlaceholder = false) {
  return `${includePlaceholder ? '<option value="__no_selection__">Selecciona prioridad…</option>' : ""}
    <option value="1" ${Number(selected) === 1 ? "selected" : ""}>1 · Alta</option>
    <option value="2" ${Number(selected) === 2 ? "selected" : ""}>2 · Media</option>
    <option value="3" ${Number(selected) === 3 ? "selected" : ""}>3 · Normal</option>`;
}

function inputHtml(def, item = null, mode = "uniform") {
  const itemId = item?.id ? String(item.id) : "uniform";
  const cls = mode === "uniform" ? "bulk-uniform-input" : "bulk-individual-input";
  const data = `data-item-id="${esc(itemId)}" data-property="${esc(def.key)}"`;
  const value = item ? item[def.key] : null;

  if (def.kind === "textarea") {
    return `<textarea class="form-control ${cls}" rows="${mode === "uniform" ? 4 : 2}" ${data}>${esc(item?.descripcion || "")}</textarea>`;
  }
  if (def.kind === "itemType") {
    return `<select class="form-select ${cls}" ${data}>${mode === "uniform" ? '<option value="__no_selection__" selected>Selecciona tipo…</option>' + itemTypeOptions("") : itemTypeOptions(item?.tipo || "Otro")}</select>`;
  }
  if (def.kind === "boolean") {
    const current = item ? item[def.key] === true : null;
    return `<select class="form-select ${cls}" ${data}>${booleanOptions(current, mode === "uniform")}</select>`;
  }
  if (def.kind === "number") {
    const attrs = [
      'type="number"',
      `class="form-control ${cls}"`,
      def.min !== undefined ? `min="${def.min}"` : "",
      def.step ? `step="${def.step}"` : (def.integer ? 'step="1"' : "any"),
      data,
      item ? `value="${esc(value ?? 0)}"` : 'value=""',
    ].filter(Boolean).join(" ");
    return `<input ${attrs}>`;
  }
  if (def.kind === "currency") {
    return `<select class="form-select ${cls}" ${data}>${mode === "uniform" ? '<option value="__no_selection__" selected>Selecciona moneda…</option>' + currencyOptions("") : currencyOptions(item?.moneda || "MXN")}</select>`;
  }
  if (def.kind === "priority") {
    return `<select class="form-select ${cls}" ${data}>${mode === "uniform" ? '<option value="__no_selection__" selected>Selecciona prioridad…</option>' + priorityOptions(0) : priorityOptions(item?.purchasePriority || 3)}</select>`;
  }
  if (def.kind === "location") {
    const selected = mode === "uniform" ? "__no_selection__" : (item?.locationId ? String(item.locationId) : "__clear__");
    return `<select class="form-select ${cls}" ${data}>${locationOptions(selected, mode === "uniform")}</select>`;
  }
  if (def.kind === "machine") {
    const selected = mode === "uniform" ? "__no_selection__" : (item?.relatedMachineId ? String(item.relatedMachineId) : "__clear__");
    return `<select class="form-select ${cls}" ${data}>${machineOptions(selected, mode === "uniform")}</select>`;
  }
  if (def.kind === "weeks") {
    return `<select class="form-select ${cls}" multiple size="${mode === "uniform" ? 7 : 4}" ${data}>${weeksOptions(item?.fabacademyWeeks || [])}</select>`;
  }
  if (def.kind === "imageFile") {
    return `<input type="file" accept="image/*" class="form-control ${cls}" ${data}>`;
  }
  if (def.kind === "documentFile") {
    return `<input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,application/pdf" class="form-control ${cls}" ${data}>`;
  }

  const type = def.kind === "url" ? "url" : "text";
  const itemValue = item ? String(item[def.key] ?? "") : "";
  return `<input type="${type}" class="form-control ${cls}" ${data} value="${esc(itemValue)}">`;
}

function currentValueText(def, item) {
  if (!item) return "";
  if (def.kind === "boolean") return item[def.key] === true ? "Sí" : "No";
  if (def.kind === "location") return currentLocationForItem(item) ? locationLabel(currentLocationForItem(item)) : `${item.zoneId || ""} · ${item.subzoneId || ""} · Sin área específica`;
  if (def.kind === "machine") return currentMachineForItem(item) ? locationLabel(currentMachineForItem(item)) : "Ninguna";
  if (def.kind === "weeks") {
    const ids = new Set((item.fabacademyWeeks || []).map(String));
    return weeks.filter(week => ids.has(String(week.weekId ?? week.id))).map(weekLabel).join(", ") || "Sin clasificación";
  }
  if (def.kind === "imageFile") return item.imageFilename || (item.imageFileId ? "Imagen cargada" : "Sin imagen");
  if (def.kind === "documentFile") return item.documentationFilename || item.pdfFilename || (item.documentationFileId || item.pdfFileId ? "Documento cargado" : "Sin documento");
  if (def.kind === "priority") return `${Number(item.purchasePriority || 3)} · ${Number(item.purchasePriority) === 1 ? "Alta" : Number(item.purchasePriority) === 2 ? "Media" : "Normal"}`;
  const value = item[def.key];
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function renderEditorBody() {
  const body = document.querySelector("#bulkEditorBody");
  const warning = document.querySelector("#bulkEditorWarning");
  if (!body || !warning) return;

  const def = propertyDef(document.querySelector("#bulkEditorProperty")?.value);
  const mode = document.querySelector('input[name="bulkEditorMode"]:checked')?.value || "uniform";
  const rows = selectedItems();

  warning.classList.add("d-none");
  warning.textContent = "";
  if (def.sensitiveStock) {
    warning.textContent = "Esta propiedad representa existencias reales. El cambio se aplicará directamente al inventario operativo; verifica físicamente las cantidades antes de guardar.";
    warning.classList.remove("d-none");
  } else if (def.key === "activo") {
    warning.textContent = "Desactivar items hará que desaparezcan de las vistas activas. Esta operación no elimina documentos de Firestore.";
    warning.classList.remove("d-none");
  } else if (def.kind === "imageFile" || def.kind === "documentFile") {
    warning.textContent = "Los archivos se suben por item al backend. En selecciones grandes la operación puede tardar varios minutos; no cierres esta ventana durante el guardado.";
    warning.classList.remove("d-none");
  }

  if (mode === "uniform") {
    body.innerHTML = `
      <div class="bulk-uniform-control">
        <label class="form-label fw-semibold">Nuevo valor para ${esc(def.label)}</label>
        ${inputHtml(def, null, "uniform")}
        <div class="form-text mt-2">Se aplicará a ${rows.length} item${rows.length === 1 ? "" : "s"}. Los demás campos, incluido SKU, permanecerán intactos.</div>
      </div>`;
    return;
  }

  body.innerHTML = `
    <div class="bulk-editor-help mb-2">Edita directamente el valor de cada SKU. Los valores no modificados se detectan y se omiten al guardar.</div>
    <div class="bulk-editor-table-wrap">
      <table class="table table-sm align-middle bulk-editor-table">
        <thead>
          <tr>
            <th style="width:140px">SKU</th>
            <th style="width:260px">Item</th>
            <th>Valor actual</th>
            <th style="min-width:330px">Nuevo valor</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(item => `
            <tr data-row-item-id="${esc(item.id)}">
              <td><code>${esc(item.sku || "s/SKU")}</code></td>
              <td>${esc(item.nombre || "Sin nombre")}</td>
              <td class="bulk-current-value">${esc(currentValueText(def, item))}</td>
              <td>${inputHtml(def, item, "individual")}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

function openEditor() {
  refreshItemMapFromCatalog();
  const rows = selectedItems();
  if (!rows.length) return;

  const propertySelect = document.querySelector("#bulkEditorProperty");
  if (propertySelect && !propertySelect.options.length) propertySelect.innerHTML = groupedPropertyOptions();
  const summary = document.querySelector("#bulkEditorSelectionSummary");
  if (summary) summary.textContent = `${rows.length} item${rows.length === 1 ? "" : "s"} seleccionado${rows.length === 1 ? "" : "s"}. SKU no editable.`;
  const progress = document.querySelector("#bulkEditorProgress");
  if (progress) progress.textContent = "";
  renderEditorBody();

  if (modalInstance) modalInstance.show();
  else document.querySelector("#bulkItemEditorModal")?.classList.add("show");
}

function readControlValue(control, def) {
  if (!control) throw new Error("No encontré el control de edición.");
  if (def.kind === "imageFile" || def.kind === "documentFile") return control.files?.[0] || null;
  if (def.kind === "weeks") return [...control.selectedOptions].map(option => Number(option.value)).filter(Number.isFinite);
  if (["itemType", "currency", "priority", "location", "machine", "boolean"].includes(def.kind)) {
    if (control.value === "__no_selection__") throw new Error(`Selecciona un valor para ${def.label}.`);
  }
  if (def.kind === "boolean") return control.value === "true";
  if (def.kind === "priority") return Number(control.value || 3);
  if (def.kind === "number") {
    if (control.value === "") throw new Error(`Escribe un valor para ${def.label}.`);
    const n = Number(control.value);
    if (!Number.isFinite(n)) throw new Error(`${def.label} debe ser numérico.`);
    if (def.min !== undefined && n < def.min) throw new Error(`${def.label} no puede ser menor que ${def.min}.`);
    if (def.integer && !Number.isInteger(n)) throw new Error(`${def.label} debe ser un número entero.`);
    return n;
  }
  const value = String(control.value ?? "").trim();
  if (def.required && !value) throw new Error(`${def.label} no puede quedar vacío.`);
  return value;
}

function normalizedComparable(def, value) {
  if (def.kind === "weeks") return JSON.stringify([...(value || [])].map(Number).sort((a, b) => a - b));
  if (def.kind === "boolean") return Boolean(value);
  if (def.kind === "number" || def.kind === "priority") return Number(value || 0);
  if (def.kind === "location") return String(value || "__clear__");
  if (def.kind === "machine") return String(value || "__clear__");
  return String(value ?? "");
}

function currentComparable(def, item) {
  if (def.kind === "location") return String(item.locationId || "__clear__");
  if (def.kind === "machine") return String(item.relatedMachineId || "__clear__");
  if (def.kind === "weeks") return normalizedComparable(def, item.fabacademyWeeks || []);
  return normalizedComparable(def, item[def.key]);
}

function buildPayload(def, value, item) {
  if (def.kind === "location") {
    if (value === "__clear__") {
      return {
        locationId: "",
        locationName: "",
        locationCode: "",
        locationType: "",
      };
    }
    const loc = locations.find(row => locationId(row) === String(value));
    if (!loc) throw new Error(`No encontré la ubicación seleccionada para ${item?.sku || item?.id || "el item"}.`);
    const zone = zones.find(row => zoneCode(row) === String(loc.zoneId));
    const subzone = subzones.find(row => subzoneCode(row) === String(loc.subzoneId));
    return {
      zoneId: Number.isFinite(Number(loc.zoneId)) ? Number(loc.zoneId) : loc.zoneId,
      zoneName: loc.zoneName || zone?.name || "",
      subzoneId: loc.subzoneId || "",
      subzoneName: loc.subzoneName || subzone?.name || "",
      locationId: locationId(loc),
      locationName: loc.name || "",
      locationCode: locationCode(loc),
      locationType: loc.type || "",
    };
  }

  if (def.kind === "machine") {
    if (value === "__clear__") {
      return {
        relatedMachineId: "",
        relatedMachineName: "",
        relatedMachineCode: "",
      };
    }
    const machine = locations.find(row => locationId(row) === String(value));
    if (!machine) throw new Error(`No encontré la máquina relacionada para ${item?.sku || item?.id || "el item"}.`);
    return {
      relatedMachineId: locationId(machine),
      relatedMachineName: machine.name || "",
      relatedMachineCode: locationCode(machine),
    };
  }

  if (def.kind === "weeks") {
    const ids = (value || []).map(Number).filter(Number.isFinite);
    const names = ids.map(id => weeks.find(week => Number(week.weekId) === Number(id))?.name || "").filter(Boolean);
    return {
      fabacademyWeeks: ids,
      fabacademyWeekNames: names,
    };
  }

  return { [def.key]: value };
}

function collectChanges(def, mode) {
  const rows = selectedItems();
  if (!rows.length) throw new Error("No hay items seleccionados.");

  if (mode === "uniform") {
    const control = document.querySelector("#bulkEditorBody .bulk-uniform-input");
    const value = readControlValue(control, def);
    if ((def.kind === "imageFile" || def.kind === "documentFile") && !value) throw new Error("Selecciona un archivo antes de guardar.");
    return rows.map(item => ({ item, value, payload: (def.kind === "imageFile" || def.kind === "documentFile") ? null : buildPayload(def, value, item) }));
  }

  const changes = [];
  rows.forEach(item => {
    const control = document.querySelector(`#bulkEditorBody .bulk-individual-input[data-item-id="${CSS.escape(String(item.id))}"]`);
    if (!control) return;
    const value = readControlValue(control, def);

    if (def.kind === "imageFile" || def.kind === "documentFile") {
      if (value) changes.push({ item, value, payload: null });
      return;
    }

    if (normalizedComparable(def, value) === currentComparable(def, item)) return;
    changes.push({ item, value, payload: buildPayload(def, value, item) });
  });

  return changes;
}

async function saveBatchChanges(changes) {
  const chunks = [];
  for (let i = 0; i < changes.length; i += 400) chunks.push(changes.slice(i, i + 400));
  const localPatches = {};

  for (let index = 0; index < chunks.length; index += 1) {
    const batch = writeBatch(db);
    chunks[index].forEach(({ item, payload }) => {
      batch.update(doc(db, "items", String(item.id)), { ...payload, updatedAt: serverTimestamp() });
      localPatches[String(item.id)] = { ...(localPatches[String(item.id)] || {}), ...payload };
    });
    const progress = document.querySelector("#bulkEditorProgress");
    if (progress) progress.textContent = `Guardando lote ${index + 1} de ${chunks.length}…`;
    await batch.commit();
  }
  return localPatches;
}

async function saveFileChanges(def, changes) {
  const assetType = def.kind === "imageFile" ? "image" : "documentation";
  const localPatches = {};
  let completed = 0;
  let cursor = 0;
  const concurrency = Math.min(3, changes.length || 1);

  async function worker() {
    while (cursor < changes.length) {
      const index = cursor++;
      const { item, value: file } = changes[index];
      const result = await uploadItemAsset(String(item.id), assetType, file);
      const fields = result?.itemFields || {};
      localPatches[String(item.id)] = { ...(localPatches[String(item.id)] || {}), ...fields };
      completed += 1;
      const progress = document.querySelector("#bulkEditorProgress");
      if (progress) progress.textContent = `Subiendo archivo ${completed} de ${changes.length}…`;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return localPatches;
}

function applyLocalPatches(localPatches) {
  const changedIds = [];
  Object.entries(localPatches || {}).forEach(([id, patch]) => {
    const current = itemsById.get(String(id));
    if (current) {
      itemsById.set(String(id), { ...current, ...patch });
      livePatchedItemIds.add(String(id));
      changedIds.push(String(id));
    }
  });

  if (window.__purchaseCatalog?.patchItems) {
    window.__purchaseCatalog.patchItems(localPatches);
  }

  scheduleLiveCardRefresh(changedIds);
}

async function refreshAfterSave() {
  // No usamos refreshItems() del render progresivo: ese método reconstruye la
  // lista y puede sentirse como una recarga. Actualizamos solo las tarjetas.
  [0, 80, 220].forEach(delay => {
    window.setTimeout(() => {
      decorateCards();
      refreshRenderedCards();
    }, delay);
  });
}

async function saveEditor() {
  if (saving) return;
  const def = propertyDef(document.querySelector("#bulkEditorProperty")?.value);
  const mode = document.querySelector('input[name="bulkEditorMode"]:checked')?.value || "uniform";

  let changes;
  try {
    changes = collectChanges(def, mode);
  } catch (error) {
    alert(error.message);
    return;
  }

  if (!changes.length) {
    alert(mode === "individual" ? "No detecté cambios para guardar." : "No hay items seleccionados.");
    return;
  }

  const extra = def.sensitiveStock
    ? "\n\nEsta propiedad modifica existencias reales del inventario."
    : def.key === "activo"
      ? "\n\nLos items desactivados dejarán de mostrarse como activos."
      : "";
  const ok = confirm(
    `Vas a modificar “${def.label}” en ${changes.length} item${changes.length === 1 ? "" : "s"}.\n\n` +
    `Solo se cambiará esta propiedad; SKU y los demás campos permanecerán intactos.${extra}\n\n¿Continuar?`
  );
  if (!ok) return;

  saving = true;
  updateToolbar();
  const saveButton = document.querySelector("#bulkEditorSave");
  const propertySelect = document.querySelector("#bulkEditorProperty");
  document.querySelectorAll('input[name="bulkEditorMode"]').forEach(input => { input.disabled = true; });
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Guardando…";
  }
  if (propertySelect) propertySelect.disabled = true;

  try {
    const isFile = def.kind === "imageFile" || def.kind === "documentFile";
    const localPatches = isFile
      ? await saveFileChanges(def, changes)
      : await saveBatchChanges(changes);

    applyLocalPatches(localPatches);
    const progress = document.querySelector("#bulkEditorProgress");
    if (progress) progress.textContent = `Listo: ${changes.length} item${changes.length === 1 ? "" : "s"} actualizado${changes.length === 1 ? "" : "s"}.`;

    // No recargamos ni sacamos al usuario de Compras. Cerramos únicamente
    // la ventana de edición y conservamos la selección para poder modificar
    // otra propiedad de los mismos items inmediatamente.
    modalInstance?.hide();
    await refreshAfterSave();
  } catch (error) {
    console.error(error);
    alert(`No se pudo completar la edición masiva: ${error.message}`);
  } finally {
    saving = false;
    updateToolbar();
    document.querySelectorAll('input[name="bulkEditorMode"]').forEach(input => { input.disabled = false; });
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = "Guardar cambios";
    }
    if (propertySelect) propertySelect.disabled = false;
  }
}

function bindEvents() {
  document.addEventListener("change", event => {
    const check = event.target.closest?.(".bulk-item-edit-check");
    if (check) {
      const id = String(check.dataset.id || "");
      if (check.checked) selectedItemIds.add(id);
      else selectedItemIds.delete(id);
      updateToolbar();
      decorateCards();
      return;
    }

    if (event.target?.id === "bulkItemSelectFiltered") {
      logicalItemIds.forEach(id => {
        if (event.target.checked) selectedItemIds.add(String(id));
        else selectedItemIds.delete(String(id));
      });
      updateToolbar();
      decorateCards();
      return;
    }

    if (event.target?.id === "bulkEditorProperty" || event.target?.name === "bulkEditorMode") {
      renderEditorBody();
    }
  });

  document.addEventListener("click", event => {
    if (event.target.closest?.("#bulkItemClearSelection")) {
      selectedItemIds.clear();
      updateToolbar();
      decorateCards();
      return;
    }
    if (event.target.closest?.("#bulkItemOpenEditor")) {
      openEditor();
      return;
    }
    if (event.target.closest?.("#bulkEditorSave")) {
      void saveEditor();
      return;
    }
    if (event.target.closest?.("#purchaseLiveRefreshButton")) {
      void refreshVisibleItemsFromServer();
    }
  });

  document.addEventListener("purchase:logical-filter-changed", event => {
    const ids = Array.isArray(event.detail?.itemIds) ? event.detail.itemIds : null;
    syncLogicalIds(ids);
  });
  document.addEventListener("purchase:render-batch", () => { decorateCards(); scheduleLiveCardRefresh(); });
  document.addEventListener("purchase:materialized-all", () => { decorateCards(); scheduleLiveCardRefresh(); });
  document.addEventListener("purchase:item-cache-ready", () => {
    window.setTimeout(() => {
      // Si otro flujo de Compras cambió uno de los items que ya habíamos
      // refrescado en vivo, tomamos la copia más reciente de la caché común.
      livePatchedItemIds.forEach(id => {
        const fresh = window.__purchasePerformance?.getItem?.(id);
        if (fresh) itemsById.set(String(id), { ...fresh });
      });
      syncLogicalIds();
      scheduleLiveCardRefresh();
    }, 0);
  });

  // También corrige el problema histórico de la edición rápida individual:
  // compras.js guarda correctamente en Firestore, pero otros módulos pueden
  // conservar una copia anterior del item. Después del submit releemos ese
  // documento y actualizamos la tarjeta sin refrescar toda la página.
  document.addEventListener("submit", event => {
    const form = event.target.closest?.(".quick-edit-item-form");
    const itemId = String(form?.dataset?.id || "");
    if (!itemId) return;
    [450, 1100].forEach(delay => {
      window.setTimeout(() => void refreshOneItemFromFirestore(itemId), delay);
    });
  });

  // No usamos MutationObserver sobre todo el subárbol de #itemsList.
  // El editor ya recibe los eventos del render progresivo de Compras; observar
  // nuestras propias inserciones creaba un bucle de mutaciones y congelaba Chrome.
}

async function init() {
  const user = await waitForUser();
  if (!user) return;
  const profile = await getUserProfile(user.uid);
  if (roleFromProfile(profile) !== "admin") return;

  injectStyles();
  addToolbar();
  addModal();
  addFloatingRefreshButton();
  labelPurchaseRequestBulkToolbar();
  const propertySelect = document.querySelector("#bulkEditorProperty");
  if (propertySelect) propertySelect.innerHTML = groupedPropertyOptions();

  await loadData();
  refreshItemMapFromCatalog();
  bindEvents();
  syncLogicalIds();
  decorateCards();
  scheduleLiveCardRefresh();

  // compras.js y el render progresivo pueden terminar de materializar el filtro
  // después de que este módulo ya arrancó. Reintentamos unas veces para tomar
  // el conjunto lógico completo (no solo las primeras tarjetas visibles).
  [120, 450, 1000, 2200].forEach(delay => {
    window.setTimeout(() => {
      labelPurchaseRequestBulkToolbar();
      if (!saving) syncLogicalIds();
    }, delay);
  });
}

init().catch(error => {
  console.error("No se pudo iniciar el editor masivo de items:", error);
});
