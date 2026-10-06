import { db } from "./firebase-app.js";
import { waitForUser, getUserProfile } from "./common.js";
import {
  collection,
  getDocs,
  query,
  where,
  doc,
  updateDoc,
  serverTimestamp,
  deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/*
 * ============================================================================
 * COMPRAS · CLASIFICACION DE ALMACENAMIENTO / TAMANO DE EMBALAJE
 * ============================================================================
 *
 * Campo Firestore en items:
 *   purchaseStorageSize: "small" | "medium" | "large"
 *
 * - Admin: puede asignar/cambiar el valor desde cada tarjeta de Compras.
 * - Supervisor: ve el valor como etiqueta de solo lectura.
 * - Otros roles / usuario sin sesion: este modulo no muestra el dato.
 * - "Sin asignar" es solo un estado de revision; no se guarda como categoria.
 * - Agrega al selector Ordenar: Estado de compra y Tamaño de almacenamiento.
 *   Los órdenes personalizados se aplican al conjunto lógico completo.
 * ============================================================================
 */

const ALLOWED_ROLES = new Set(["admin", "supervisor"]);
const STORAGE_VALUES = new Set(["small", "medium", "large"]);
const STORAGE_LABELS = {
  small: "Pequeño",
  medium: "Mediano",
  large: "Grande",
};

const CUSTOM_SORT_MODES = new Set(["purchase_status", "storage_size"]);
const PURCHASE_STATE_ORDER = {
  missing: 1,
  ordered: 2,
  requisition: 3,
  complete: 4,
};
const STORAGE_SIZE_ORDER = {
  small: 1,
  medium: 2,
  large: 3,
  unassigned: 4,
};

const itemsById = new Map();
let currentRole = "";
let observer = null;
let decorateQueued = false;
let customSortTimer = null;
let customSortInProgress = false;

function normalizeStorageSize(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return STORAGE_VALUES.has(normalized) ? normalized : "";
}

function storageLabel(value) {
  const normalized = normalizeStorageSize(value);
  return normalized ? STORAGE_LABELS[normalized] : "Sin asignar";
}

function storageBadgeClass(value) {
  const normalized = normalizeStorageSize(value);
  if (normalized === "small") return "storage-size-small";
  if (normalized === "medium") return "storage-size-medium";
  if (normalized === "large") return "storage-size-large";
  return "storage-size-unassigned";
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function purchaseStateKey(item) {
  if (!item) return "missing";

  const current = num(item.stockAlmacen) + num(item.stockPrestadoTemporal);
  const desired = num(item.inventarioDeseado);
  const pending = Math.max(num(item.purchasePendingQty), 0);
  const requisition = Math.min(
    Math.max(num(item.purchaseRequisitionQty), 0),
    pending
  );

  if (pending > 0 && requisition > 0) return "requisition";
  if (pending > 0) return "ordered";
  if (Math.max(desired - current, 0) <= 0) return "complete";
  return "missing";
}

function purchaseStateKeyFromCard(card, item) {
  const status = card?.querySelector?.(".purchase-status-controls");
  if (status?.classList.contains("purchase-state-missing")) return "missing";
  if (status?.classList.contains("purchase-state-ordered")) return "ordered";
  if (status?.classList.contains("purchase-state-requisition")) return "requisition";
  if (status?.classList.contains("purchase-state-complete")) return "complete";
  return purchaseStateKey(item);
}

function currentCustomSortMode() {
  const mode = document.querySelector("#sortMode")?.value || "";
  return CUSTOM_SORT_MODES.has(mode) ? mode : "";
}

function addCustomSortOptions() {
  const sort = document.querySelector("#sortMode");
  if (!sort) return;

  const options = [
    ["purchase_status", "Estado de compra (pendiente → completo)"],
    ["storage_size", "Tamaño (Pequeño → Grande)"],
  ];

  options.forEach(([value, label]) => {
    if (sort.querySelector(`option[value="${value}"]`)) return;
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    sort.appendChild(option);
  });
}

function compareText(left, right) {
  return String(left || "").localeCompare(
    String(right || ""),
    "es",
    { numeric: true, sensitivity: "base" }
  );
}

function storageSortRank(item) {
  const value = normalizeStorageSize(item?.purchaseStorageSize);
  return STORAGE_SIZE_ORDER[value || "unassigned"] || STORAGE_SIZE_ORDER.unassigned;
}

function compareCardsForCustomSort(leftCard, rightCard, mode) {
  const leftItem = itemsById.get(String(leftCard.dataset.itemId || "")) || {};
  const rightItem = itemsById.get(String(rightCard.dataset.itemId || "")) || {};

  if (mode === "purchase_status") {
    const leftState = purchaseStateKeyFromCard(leftCard, leftItem);
    const rightState = purchaseStateKeyFromCard(rightCard, rightItem);
    const stateDiff = (PURCHASE_STATE_ORDER[leftState] || 99) - (PURCHASE_STATE_ORDER[rightState] || 99);
    if (stateDiff) return stateDiff;

    const priorityDiff = (num(leftItem.purchasePriority) || 3) - (num(rightItem.purchasePriority) || 3);
    if (priorityDiff) return priorityDiff;
  }

  if (mode === "storage_size") {
    const storageDiff = storageSortRank(leftItem) - storageSortRank(rightItem);
    if (storageDiff) return storageDiff;
  }

  return compareText(leftItem.nombre, rightItem.nombre)
    || compareText(leftItem.sku, rightItem.sku);
}

function reorderMaterializedCards(mode) {
  if (!CUSTOM_SORT_MODES.has(mode) || customSortInProgress) return;

  const container = document.querySelector("#itemsList");
  if (!container) return;

  const cards = [...container.querySelectorAll(":scope > .item-card[data-item-id]")];
  if (cards.length < 2) return;

  const sorted = [...cards].sort((a, b) => compareCardsForCustomSort(a, b, mode));
  const currentIds = cards.map(card => card.dataset.itemId).join("|");
  const sortedIds = sorted.map(card => card.dataset.itemId).join("|");
  if (currentIds === sortedIds) return;

  customSortInProgress = true;
  try {
    sorted.forEach(card => container.appendChild(card));
  } finally {
    queueMicrotask(() => {
      customSortInProgress = false;
    });
  }
}

function scheduleCustomSort({ materialize = true } = {}) {
  clearTimeout(customSortTimer);

  customSortTimer = window.setTimeout(() => {
    const mode = currentCustomSortMode();
    if (!mode) return;

    if (materialize) {
      window.__purchasePerformance?.materializeAll?.();
    }

    // Da oportunidad a compras-status y a esta misma capa de decorar las
    // tarjetas recién materializadas antes de calcular el orden definitivo.
    requestAnimationFrame(() => {
      decorateVisibleCards();
      requestAnimationFrame(() => reorderMaterializedCards(mode));
    });
  }, 0);
}

function bindCustomSort() {
  const sort = document.querySelector("#sortMode");
  if (!sort) return;

  const handleSortChange = () => {
    const mode = currentCustomSortMode();
    if (mode) {
      scheduleCustomSort({ materialize: true });
      return;
    }

    // Al volver a un orden nativo, permitimos que la capa de rendimiento
    // recupere la paginación progresiva normal.
    window.__purchasePerformance?.restoreProgressive?.({ delay: 0 });
  };

  sort.addEventListener("input", handleSortChange);
  sort.addEventListener("change", handleSortChange);

  document.addEventListener("purchase:render-batch", () => {
    if (currentCustomSortMode()) scheduleCustomSort({ materialize: true });
  });

  document.addEventListener("purchase:materialized-all", () => {
    if (currentCustomSortMode()) scheduleCustomSort({ materialize: false });
  });
}

function injectStyles() {
  if (document.querySelector("#purchaseStorageStyles")) return;

  const style = document.createElement("style");
  style.id = "purchaseStorageStyles";
  style.textContent = `
    .purchase-storage-wrapper {
      flex: 0 0 auto;
    }

    .purchase-storage-box {
      min-width: 150px;
      padding: .55rem .7rem;
      border: 1px solid #dee2e6;
      border-radius: .65rem;
      background: #fff;
      text-align: right;
    }

    .purchase-storage-box .form-select {
      min-width: 125px;
    }

    .purchase-storage-label {
      display: block;
      margin-bottom: .25rem;
      color: #6c757d;
      font-size: .75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .02em;
    }

    .purchase-storage-badge {
      display: inline-block;
      border-radius: 999px;
      padding: .42rem .65rem;
      font-size: .78rem;
      font-weight: 700;
      line-height: 1;
      white-space: nowrap;
    }

    .storage-size-unassigned {
      border: 1px solid #ced4da;
      background: #f8f9fa;
      color: #6c757d;
    }

    .storage-size-small {
      border: 1px solid #adb5bd;
      background: #f8f9fa;
      color: #343a40;
    }

    .storage-size-medium {
      border: 1px solid #6c757d;
      background: #e9ecef;
      color: #212529;
    }

    .storage-size-large {
      border: 1px solid #343a40;
      background: #343a40;
      color: #fff;
    }

    .purchase-storage-select.is-saving {
      opacity: .65;
    }

    .purchase-storage-select.is-saved {
      box-shadow: 0 0 0 .2rem rgba(25,135,84,.16);
    }

    @media (max-width: 575.98px) {
      .purchase-storage-wrapper,
      .purchase-storage-box {
        width: 100%;
      }

      .purchase-storage-box {
        text-align: left;
      }
    }

    @media print {
      .purchase-storage-box {
        min-width: 36mm;
        padding: 2.5mm 3mm;
        border: 1px solid #dee2e6;
        border-radius: 2.5mm;
        background: #fff !important;
        text-align: right;
      }

      .purchase-storage-label {
        margin-bottom: 1mm;
        font-size: 7pt;
        font-weight: 700;
      }

      .purchase-storage-badge {
        font-size: 8pt;
        padding: 1.6mm 2.2mm;
      }
    }
  `;
  document.head.appendChild(style);
}

function storageControlHtml(item) {
  const value = normalizeStorageSize(item?.purchaseStorageSize);

  if (currentRole === "admin") {
    return `
      <div class="purchase-storage-box" title="Tamaño aproximado del embalaje al momento de compra, útil para prever su almacenamiento.">
        <label class="purchase-storage-label" for="purchase-storage-${item.id}">Almacenamiento</label>
        <select
          id="purchase-storage-${item.id}"
          class="form-select form-select-sm purchase-storage-select"
          data-id="${item.id}"
          aria-label="Tamaño de embalaje para almacenamiento">
          <option value="" ${value === "" ? "selected" : ""}>Sin asignar</option>
          <option value="small" ${value === "small" ? "selected" : ""}>Pequeño</option>
          <option value="medium" ${value === "medium" ? "selected" : ""}>Mediano</option>
          <option value="large" ${value === "large" ? "selected" : ""}>Grande</option>
        </select>
      </div>`;
  }

  return `
    <div class="purchase-storage-box" title="Tamaño aproximado del embalaje al momento de compra.">
      <span class="purchase-storage-label">Almacenamiento</span>
      <span class="purchase-storage-badge ${storageBadgeClass(value)}">${storageLabel(value)}</span>
    </div>`;
}

function decorateStorage(card) {
  const itemId = String(card?.dataset?.itemId || "");
  if (!itemId) return;

  const item = itemsById.get(itemId);
  if (!item) return;

  const body = card.querySelector(".card-body");
  if (!body) return;

  const header = body.querySelector(":scope > .d-flex.justify-content-between");
  if (!header) return;

  let wrapper = header.querySelector(".purchase-storage-wrapper");
  if (!wrapper) {
    wrapper = document.createElement("div");
    wrapper.className = "purchase-storage-wrapper";

    const priorityWrapper = header.querySelector(".purchase-priority-wrapper");
    if (priorityWrapper) {
      priorityWrapper.insertAdjacentElement("afterend", wrapper);
    } else {
      wrapper.classList.add("ms-auto");
      header.appendChild(wrapper);
    }
  }

  const value = normalizeStorageSize(item.purchaseStorageSize);
  const signature = `${currentRole}|${value}`;
  if (wrapper.dataset.storageSignature === signature) return;

  wrapper.dataset.storageSignature = signature;
  wrapper.innerHTML = storageControlHtml(item);
}

function decorateVisibleCards() {
  document
    .querySelectorAll("#itemsList .item-card[data-item-id]")
    .forEach(decorateStorage);
}

function queueDecoration() {
  if (decorateQueued) return;
  decorateQueued = true;

  requestAnimationFrame(() => {
    decorateQueued = false;
    decorateVisibleCards();
  });
}

async function updateStorageSize(itemId, select) {
  if (currentRole !== "admin") return;

  const previous = normalizeStorageSize(itemsById.get(itemId)?.purchaseStorageSize);
  const next = normalizeStorageSize(select.value);

  select.disabled = true;
  select.classList.add("is-saving");
  select.classList.remove("is-saved");

  try {
    const payload = {
      updatedAt: serverTimestamp(),
      purchaseStorageSize: next || deleteField(),
    };

    await updateDoc(doc(db, "items", itemId), payload);

    const current = itemsById.get(itemId) || { id: itemId };
    itemsById.set(itemId, {
      ...current,
      purchaseStorageSize: next,
    });

    const wrapper = select.closest(".purchase-storage-wrapper");
    if (wrapper) wrapper.dataset.storageSignature = `${currentRole}|${next}`;

    select.classList.add("is-saved");
    window.setTimeout(() => select.classList.remove("is-saved"), 700);

    document.dispatchEvent(new CustomEvent("purchase:storage-updated", {
      detail: {
        itemId,
        purchaseStorageSize: next,
      },
    }));

    if (currentCustomSortMode() === "storage_size") {
      scheduleCustomSort({ materialize: false });
    }
  } catch (error) {
    console.error("No se pudo cambiar el almacenamiento:", error);
    select.value = previous;
    alert(`No se pudo cambiar el almacenamiento: ${error.message}`);
  } finally {
    select.classList.remove("is-saving");
    select.disabled = false;
  }
}

function bindActions() {
  const itemsList = document.querySelector("#itemsList");
  if (!itemsList) return;

  itemsList.addEventListener("change", event => {
    const select = event.target.closest(".purchase-storage-select");
    if (!select) return;
    updateStorageSize(String(select.dataset.id || ""), select);
  });
}

function observeCards() {
  const itemsList = document.querySelector("#itemsList");
  if (!itemsList) return;

  observer?.disconnect();
  observer = new MutationObserver(mutations => {
    const changed = mutations.some(mutation =>
      mutation.type === "childList"
      && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)
    );

    if (changed) {
      queueDecoration();
      if (!customSortInProgress && currentCustomSortMode()) {
        scheduleCustomSort({ materialize: false });
      }
    }
  });

  observer.observe(itemsList, {
    childList: true,
    subtree: false,
  });
}

async function loadItems() {
  const snapshot = await getDocs(
    query(collection(db, "items"), where("activo", "==", true))
  );

  itemsById.clear();
  snapshot.docs.forEach(itemDoc => {
    itemsById.set(itemDoc.id, {
      id: itemDoc.id,
      ...itemDoc.data(),
    });
  });
}

async function initPurchaseStorage() {
  const user = await waitForUser();
  if (!user) return;

  const profile = await getUserProfile(user.uid);
  currentRole = profile?.appRole || profile?.role || "";

  if (!ALLOWED_ROLES.has(currentRole)) return;

  injectStyles();
  await loadItems();
  addCustomSortOptions();
  bindActions();
  bindCustomSort();
  observeCards();
  queueDecoration();

  // Si otra capa del módulo de Compras actualiza visualmente las tarjetas,
  // volvemos a colocar el control sin recargar la página.
  document.addEventListener("purchase:items-local-updated", event => {
    const rows = Array.isArray(event.detail?.items) ? event.detail.items : [];
    rows.forEach(row => {
      if (!row?.id) return;
      const previous = itemsById.get(String(row.id)) || {};
      itemsById.set(String(row.id), { ...previous, ...row });
    });
    queueDecoration();
    if (currentCustomSortMode()) {
      scheduleCustomSort({ materialize: false });
    }
  });
}

initPurchaseStorage().catch(error => {
  console.error("No se pudo activar la clasificación de almacenamiento en Compras:", error);
});
