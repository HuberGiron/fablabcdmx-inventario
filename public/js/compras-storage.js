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
 * COMPRAS · CLASIFICACIÓN DE ALMACENAMIENTO / TAMAÑO DE EMBALAJE
 * ============================================================================
 *
 * Campo Firestore en items:
 *   purchaseStorageSize: "small" | "medium" | "large"
 *
 * - Admin: puede asignar/cambiar el valor desde cada tarjeta de Compras.
 * - Supervisor: ve el valor como etiqueta de sólo lectura.
 * - Otros roles / usuario sin sesión: este módulo no muestra el dato.
 * - "Sin asignar" es sólo un estado de revisión; no se guarda como categoría.
 * - Agrega al selector Ordenar: Estado de compra y Tamaño de almacenamiento.
 * - Agrega filtro múltiple por tamaño.
 *
 * IMPORTANTE:
 * Esta capa YA NO reordena, materializa ni oculta tarjetas directamente.
 * El filtrado/orden se resuelve en compras-performance.js antes del render.
 * Así no compite con compras-status.js ni con sus colores/decoraciones.
 * ============================================================================
 */

const ALLOWED_ROLES = new Set(["admin", "supervisor"]);
const STORAGE_VALUES = new Set(["small", "medium", "large"]);
const STORAGE_LABELS = {
  small: "Pequeño",
  medium: "Mediano",
  large: "Grande",
};

const itemsById = new Map();
let currentRole = "";
let observer = null;
let decorateQueued = false;
let storageFilterUiObserver = null;

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

function ensureStorageFilterUi() {
  const row = document.querySelector("#purchaseStatusFilterRow");
  if (!row) return false;

  if (row.querySelector("#filterPurchaseStorageGroup")) return true;

  // Estado, Prioridad y Tamaño quedan en tres columnas equivalentes.
  [...row.children].forEach(column => {
    if (column.classList.contains("col-lg-6")) {
      column.classList.remove("col-lg-6");
      column.classList.add("col-lg-4");
    }
  });

  const column = document.createElement("div");
  column.className = "col-lg-4";
  column.innerHTML = `
    <div class="form-label small mb-1 fw-semibold">Tamaño de almacenamiento</div>
    <div id="filterPurchaseStorageGroup" class="purchase-multi-filter" role="group" aria-label="Tamaño de almacenamiento">
      <div class="form-check">
        <input class="form-check-input purchase-storage-check" type="checkbox" value="small" id="filterPurchaseStorageSmall" checked>
        <label class="form-check-label" for="filterPurchaseStorageSmall">Pequeño</label>
      </div>
      <div class="form-check">
        <input class="form-check-input purchase-storage-check" type="checkbox" value="medium" id="filterPurchaseStorageMedium" checked>
        <label class="form-check-label" for="filterPurchaseStorageMedium">Mediano</label>
      </div>
      <div class="form-check">
        <input class="form-check-input purchase-storage-check" type="checkbox" value="large" id="filterPurchaseStorageLarge" checked>
        <label class="form-check-label" for="filterPurchaseStorageLarge">Grande</label>
      </div>
      <div class="form-check">
        <input class="form-check-input purchase-storage-check" type="checkbox" value="unassigned" id="filterPurchaseStorageUnassigned" checked>
        <label class="form-check-label" for="filterPurchaseStorageUnassigned">Sin asignar</label>
      </div>
    </div>`;

  row.appendChild(column);
  return true;
}

function watchForStorageFilterUi() {
  if (ensureStorageFilterUi()) return;
  if (storageFilterUiObserver) return;

  storageFilterUiObserver = new MutationObserver(() => {
    if (!ensureStorageFilterUi()) return;
    storageFilterUiObserver?.disconnect();
    storageFilterUiObserver = null;
  });

  storageFilterUiObserver.observe(document.body, {
    childList: true,
    subtree: true,
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

function replayCurrentOrdering() {
  const sort = document.querySelector("#sortMode");
  if (!sort) return;

  const event = new Event("input", { bubbles: true });
  sort.dispatchEvent(event);
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
    const updated = {
      ...current,
      id: itemId,
      purchaseStorageSize: next,
    };

    itemsById.set(itemId, updated);
    window.__purchasePerformance?.patchItems?.([updated]);

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
  } catch (error) {
    console.error("No se pudo cambiar el almacenamiento:", error);
    select.value = previous;

    const current = itemsById.get(itemId) || { id: itemId };
    const reverted = {
      ...current,
      id: itemId,
      purchaseStorageSize: previous,
    };
    itemsById.set(itemId, reverted);
    window.__purchasePerformance?.patchItems?.([reverted]);

    // Si el cambio optimista había alterado filtro/orden, recupera el estado
    // anterior una única vez. No mueve nodos directamente.
    replayCurrentOrdering();

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

    // Sólo decoramos las tarjetas nuevas. NO reordenamos ni volvemos a
    // materializar aquí; compras-performance.js ya entregó el orden correcto.
    if (changed) queueDecoration();
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
  watchForStorageFilterUi();
  bindActions();
  observeCards();
  queueDecoration();

  // Si otra capa de Compras actualiza datos locales, mantenemos sincronizada
  // únicamente nuestra caché y volvemos a decorar las tarjetas afectadas.
  document.addEventListener("purchase:items-local-updated", event => {
    const rows = Array.isArray(event.detail?.items) ? event.detail.items : [];
    rows.forEach(row => {
      if (!row?.id) return;
      const previous = itemsById.get(String(row.id)) || {};
      itemsById.set(String(row.id), { ...previous, ...row });
    });
    queueDecoration();
  });
}

initPurchaseStorage().catch(error => {
  console.error("No se pudo activar la clasificación de almacenamiento en Compras:", error);
});
