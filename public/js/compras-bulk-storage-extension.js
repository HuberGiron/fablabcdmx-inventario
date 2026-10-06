import { db } from "./firebase-app.js";
import { waitForUser, getUserProfile } from "./common.js";
import {
  doc,
  writeBatch,
  serverTimestamp,
  deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/*
 * ============================================================================
 * COMPRAS · TAMAÑO DE ALMACENAMIENTO EN EDITOR MASIVO
 * ============================================================================
 *
 * Extiende el editor masivo existente sin duplicarlo:
 * - agrega "Tamaño de almacenamiento" al grupo Compras;
 * - soporta valor uniforme o diferenciado por SKU;
 * - valores: Sin asignar / Pequeño / Mediano / Grande;
 * - "Sin asignar" elimina purchaseStorageSize de Firestore;
 * - mantiene sincronizadas las cachés de Compras, filtros y ordenamiento;
 * - sólo se activa para Administrador.
 *
 * Campo Firestore:
 *   purchaseStorageSize: "small" | "medium" | "large"
 * ============================================================================
 */

const PROPERTY_KEY = "purchaseStorageSize";
const PROPERTY_LABEL = "Tamaño de almacenamiento";
const ALLOWED_VALUES = new Set(["small", "medium", "large"]);
const LABELS = {
  small: "Pequeño",
  medium: "Mediano",
  large: "Grande",
};

const selectedIds = new Set();
let saving = false;
let uiObserver = null;

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function roleFromProfile(profile) {
  return profile?.appRole || profile?.role || "";
}

function normalizeStorage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ALLOWED_VALUES.has(normalized) ? normalized : "";
}

function storageLabel(value) {
  const normalized = normalizeStorage(value);
  return normalized ? LABELS[normalized] : "Sin asignar";
}

function logicalIds() {
  const ids = window.__purchasePerformance?.getLogicalItemIds?.();
  return Array.isArray(ids) ? ids.map(String) : [];
}

function itemForId(id) {
  const fromPerformance = window.__purchasePerformance?.getItem?.(String(id));
  if (fromPerformance) return { ...fromPerformance, id: String(id) };

  const rows = window.__purchaseCatalog?.getAllItems?.();
  if (Array.isArray(rows)) {
    const found = rows.find(item => String(item?.id || "") === String(id));
    if (found) return { ...found, id: String(id) };
  }

  return null;
}

function syncSelectionFromUi() {
  document.querySelectorAll(".bulk-item-edit-check").forEach(check => {
    const id = String(check.dataset.id || "");
    if (!id) return;
    if (check.checked) selectedIds.add(id);
  });

  const master = document.querySelector("#bulkItemSelectFiltered");
  if (master?.checked && !master.indeterminate) {
    logicalIds().forEach(id => selectedIds.add(String(id)));
  }
}

function selectedItems() {
  syncSelectionFromUi();

  return [...selectedIds]
    .map(itemForId)
    .filter(Boolean)
    .sort((a, b) =>
      String(a.zoneId || "").localeCompare(String(b.zoneId || ""), "es", { numeric: true })
      || String(a.subzoneId || "").localeCompare(String(b.subzoneId || ""), "es", { numeric: true })
      || String(a.sku || "").localeCompare(String(b.sku || ""), "es", { numeric: true })
    );
}

function ensurePropertyOption() {
  const select = document.querySelector("#bulkEditorProperty");
  if (!select) return false;
  if (select.querySelector(`option[value="${PROPERTY_KEY}"]`)) return true;

  // Esperamos a que el editor masivo original termine de construir sus
  // propiedades. Si insertáramos antes, su groupedPropertyOptions() podría
  // reemplazar el contenido del <select> y borrar esta extensión.
  if (!select.querySelector('option[value="purchasePriority"]')) return false;

  const option = document.createElement("option");
  option.value = PROPERTY_KEY;
  option.textContent = PROPERTY_LABEL;

  const comprasGroup = [...select.querySelectorAll("optgroup")]
    .find(group => String(group.label || "").trim().toLowerCase() === "compras");

  if (comprasGroup) comprasGroup.appendChild(option);
  else select.appendChild(option);

  return true;
}

function storageOptions(selected = "", includePlaceholder = false) {
  const normalized = normalizeStorage(selected);
  return `${includePlaceholder ? '<option value="__no_selection__" selected>Selecciona tamaño…</option>' : ""}
    <option value="__clear__" ${!includePlaceholder && normalized === "" ? "selected" : ""}>Sin asignar</option>
    <option value="small" ${normalized === "small" ? "selected" : ""}>Pequeño</option>
    <option value="medium" ${normalized === "medium" ? "selected" : ""}>Mediano</option>
    <option value="large" ${normalized === "large" ? "selected" : ""}>Grande</option>`;
}

function renderStorageEditor() {
  const property = document.querySelector("#bulkEditorProperty");
  if (!property || property.value !== PROPERTY_KEY) return;

  const body = document.querySelector("#bulkEditorBody");
  const warning = document.querySelector("#bulkEditorWarning");
  if (!body || !warning) return;

  const mode = document.querySelector('input[name="bulkEditorMode"]:checked')?.value || "uniform";
  const rows = selectedItems();

  warning.classList.add("d-none");
  warning.textContent = "";

  if (mode === "uniform") {
    body.innerHTML = `
      <div class="bulk-uniform-control">
        <label class="form-label fw-semibold">Nuevo valor para ${PROPERTY_LABEL}</label>
        <select class="form-select bulk-storage-uniform-input" data-property="${PROPERTY_KEY}">
          ${storageOptions("", true)}
        </select>
        <div class="form-text mt-2">
          Se aplicará a ${rows.length} item${rows.length === 1 ? "" : "s"}.
          “Sin asignar” elimina la clasificación de almacenamiento existente.
        </div>
      </div>`;
    return;
  }

  body.innerHTML = `
    <div class="bulk-editor-help mb-2">
      Edita directamente el tamaño de cada SKU. Los valores no modificados se omiten al guardar.
    </div>
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
              <td class="bulk-current-value">${esc(storageLabel(item.purchaseStorageSize))}</td>
              <td>
                <select class="form-select bulk-storage-individual-input"
                        data-item-id="${esc(item.id)}"
                        data-property="${PROPERTY_KEY}">
                  ${storageOptions(item.purchaseStorageSize, false)}
                </select>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

function readStorageValue(control) {
  if (!control) throw new Error("No encontré el control de tamaño de almacenamiento.");
  const value = String(control.value || "");
  if (value === "__no_selection__") throw new Error("Selecciona un tamaño de almacenamiento.");
  if (value === "__clear__") return "";
  if (!ALLOWED_VALUES.has(value)) throw new Error("El tamaño de almacenamiento seleccionado no es válido.");
  return value;
}

function collectChanges() {
  const rows = selectedItems();
  const mode = document.querySelector('input[name="bulkEditorMode"]:checked')?.value || "uniform";

  if (!rows.length) throw new Error("No hay items seleccionados.");

  if (mode === "uniform") {
    const value = readStorageValue(document.querySelector("#bulkEditorBody .bulk-storage-uniform-input"));
    return rows
      .filter(item => normalizeStorage(item.purchaseStorageSize) !== value)
      .map(item => ({ item, value }));
  }

  const changes = [];
  rows.forEach(item => {
    const control = document.querySelector(
      `#bulkEditorBody .bulk-storage-individual-input[data-item-id="${CSS.escape(String(item.id))}"]`
    );
    if (!control) return;
    const value = readStorageValue(control);
    if (normalizeStorage(item.purchaseStorageSize) === value) return;
    changes.push({ item, value });
  });
  return changes;
}

function patchLocalState(changes) {
  const changedItems = [];
  const catalogPatches = {};

  changes.forEach(({ item, value }) => {
    const updated = {
      ...item,
      id: String(item.id),
      purchaseStorageSize: value,
    };
    changedItems.push(updated);
    catalogPatches[String(item.id)] = { purchaseStorageSize: value };
  });

  window.__purchasePerformance?.patchItems?.(changedItems);
  window.__purchaseCatalog?.patchItems?.(catalogPatches);

  document.dispatchEvent(new CustomEvent("purchase:items-local-updated", {
    detail: {
      items: changedItems,
      source: "bulk-storage-editor",
    },
  }));

  const sort = document.querySelector("#sortMode");
  const storageChecks = [...document.querySelectorAll("#filterPurchaseStorageGroup .purchase-storage-check")];
  const storageFilterActive = storageChecks.length > 0 && storageChecks.some(check => !check.checked);

  if (sort && (sort.value === "storage_size" || storageFilterActive)) {
    const event = new Event("input", { bubbles: true });
    sort.dispatchEvent(event);
  }
}

function setEditorBusy(busy) {
  const save = document.querySelector("#bulkEditorSave");
  const property = document.querySelector("#bulkEditorProperty");
  const modeInputs = document.querySelectorAll('input[name="bulkEditorMode"]');

  if (save) {
    save.disabled = busy;
    save.textContent = busy ? "Guardando…" : "Guardar cambios";
  }
  if (property) property.disabled = busy;
  modeInputs.forEach(input => { input.disabled = busy; });
}

async function saveStorageChanges() {
  if (saving) return;

  let changes;
  try {
    changes = collectChanges();
  } catch (error) {
    alert(error.message);
    return;
  }

  if (!changes.length) {
    alert("No detecté cambios de tamaño para guardar.");
    return;
  }

  const ok = confirm(
    `Vas a modificar “${PROPERTY_LABEL}” en ${changes.length} item${changes.length === 1 ? "" : "s"}.\n\n` +
    "Solo se cambiará esta propiedad; SKU y los demás campos permanecerán intactos.\n\n¿Continuar?"
  );
  if (!ok) return;

  saving = true;
  setEditorBusy(true);
  const progress = document.querySelector("#bulkEditorProgress");

  try {
    const chunks = [];
    for (let i = 0; i < changes.length; i += 400) chunks.push(changes.slice(i, i + 400));

    for (let index = 0; index < chunks.length; index += 1) {
      const batch = writeBatch(db);

      chunks[index].forEach(({ item, value }) => {
        batch.update(doc(db, "items", String(item.id)), {
          purchaseStorageSize: value || deleteField(),
          updatedAt: serverTimestamp(),
        });
      });

      if (progress) progress.textContent = `Guardando lote ${index + 1} de ${chunks.length}…`;
      await batch.commit();
    }

    patchLocalState(changes);
    if (progress) {
      progress.textContent = `Listo: ${changes.length} item${changes.length === 1 ? "" : "s"} actualizado${changes.length === 1 ? "" : "s"}.`;
    }

    const modal = document.querySelector("#bulkItemEditorModal");
    const instance = modal && window.bootstrap?.Modal?.getInstance(modal);
    instance?.hide();
  } catch (error) {
    console.error("No se pudo guardar el tamaño de almacenamiento masivamente:", error);
    alert(`No se pudo completar la edición masiva de tamaño: ${error.message}`);
  } finally {
    saving = false;
    setEditorBusy(false);
  }
}

function bindSelectionMirror() {
  document.addEventListener("change", event => {
    const check = event.target.closest?.(".bulk-item-edit-check");
    if (check) {
      const id = String(check.dataset.id || "");
      if (id) {
        if (check.checked) selectedIds.add(id);
        else selectedIds.delete(id);
      }
      return;
    }

    if (event.target?.id === "bulkItemSelectFiltered") {
      const ids = logicalIds();
      ids.forEach(id => {
        if (event.target.checked) selectedIds.add(String(id));
        else selectedIds.delete(String(id));
      });
    }
  }, true);

  document.addEventListener("click", event => {
    if (event.target.closest?.("#bulkItemClearSelection")) {
      selectedIds.clear();
    }
  }, true);

  document.addEventListener("purchase:logical-filter-changed", event => {
    const ids = Array.isArray(event.detail?.itemIds) ? event.detail.itemIds.map(String) : logicalIds();
    const allowed = new Set(ids);
    [...selectedIds].forEach(id => {
      if (!allowed.has(String(id))) selectedIds.delete(String(id));
    });
  });
}

function bindEditorExtension() {
  document.addEventListener("change", event => {
    const property = document.querySelector("#bulkEditorProperty");

    if (event.target?.id === "bulkEditorProperty" && event.target.value === PROPERTY_KEY) {
      event.stopImmediatePropagation();
      renderStorageEditor();
      return;
    }

    if (event.target?.name === "bulkEditorMode" && property?.value === PROPERTY_KEY) {
      event.stopImmediatePropagation();
      renderStorageEditor();
    }
  }, true);

  document.addEventListener("click", event => {
    if (!event.target.closest?.("#bulkEditorSave")) return;
    if (document.querySelector("#bulkEditorProperty")?.value !== PROPERTY_KEY) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void saveStorageChanges();
  }, true);

  document.addEventListener("shown.bs.modal", event => {
    if (event.target?.id !== "bulkItemEditorModal") return;
    ensurePropertyOption();
    if (document.querySelector("#bulkEditorProperty")?.value === PROPERTY_KEY) {
      renderStorageEditor();
    }
  });
}

function watchForBulkEditorUi() {
  if (ensurePropertyOption()) return;
  if (uiObserver) return;

  uiObserver = new MutationObserver(() => {
    if (!ensurePropertyOption()) return;
    uiObserver.disconnect();
    uiObserver = null;
  });

  uiObserver.observe(document.body, { childList: true, subtree: true });
}

async function init() {
  const user = await waitForUser();
  if (!user) return;

  const profile = await getUserProfile(user.uid);
  if (roleFromProfile(profile) !== "admin") return;

  bindSelectionMirror();
  bindEditorExtension();
  watchForBulkEditorUi();
}

init().catch(error => {
  console.error("No se pudo extender el editor masivo con Tamaño de almacenamiento:", error);
});
