/*
 * Compras FabLab — Deshacer requisición (individual y masiva).
 * Revierte exclusivamente la etapa de requisición, no la solicitud,
 * las recepciones, las cancelaciones, los precios ni el inventario físico.
 * Se limita a Administrador (también en las reglas de Firestore).
 */
import { auth, db } from "./firebase-app.js";
import { getUserProfile, waitForUser } from "./common.js";
import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const MODAL_ID = "purchaseUndoRequisitionModal";
const BUTTON_ID = "purchaseUndoRequisitionLauncher";
const detailLines = new Map();
let detailRequestId = "";
let loadSequence = 0;
let role = "";
let profile = null;
let rolePromise = null;
let busy = false;
let modalRequestId = "";
let reopenDetailId = "";
let detailObserver = null;
let detailObservedBody = null;

const num = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pendingQty(line) {
  return Math.max(
    num(line.quantityRequested) - num(line.quantityReceived) - num(line.quantityCancelled),
    0
  );
}

function canUndo(line) {
  return line?.requisitionStatus === "requisitioned"
    && pendingQty(line) > 0
    && num(line.quantityReceived) === 0
    && num(line.quantityCancelled) === 0;
}

function currentDetailRequestId() {
  return String(document.querySelector("#purchaseRequestDetailPdf")?.dataset.requestId || "");
}

function getDetailModal() {
  return document.querySelector("#purchaseRequestDetailModal");
}

async function loadRole() {
  if (!rolePromise) {
    rolePromise = (async () => {
      const user = auth.currentUser || await waitForUser();
      if (!user) return;
      profile = await getUserProfile(user.uid);
      role = String(profile?.appRole || profile?.role || "");
    })().catch(error => {
      rolePromise = null; // Permite reintentar si falla la red.
      throw error;
    });
  }
  await rolePromise;
  return role === "admin";
}

async function fetchLines(requestId) {
  const snap = await getDocs(collection(db, "purchaseRequests", requestId, "items"));
  return snap.docs.map(item => ({ id: item.id, ...item.data() }));
}

function renderDetailButtons() {
  if (role !== "admin" || !detailRequestId || currentDetailRequestId() !== detailRequestId) {
    return;
  }

  const body = document.querySelector("#purchaseRequestDetailBody");
  const toolbar = body?.querySelector("#requestGroupingToolbar");
  if (toolbar) {
    let launch = toolbar.querySelector(`#${BUTTON_ID}`);
    if (!launch) {
      launch = document.createElement("button");
      launch.type = "button";
      launch.id = BUTTON_ID;
      launch.className = "btn btn-outline-warning btn-sm";
      launch.addEventListener("click", () => openUndoModal(detailRequestId));
      toolbar.appendChild(launch);
    }
    const wide = toolbar.querySelector("#requestWideRequisitionButton");
    if (wide && wide.nextElementSibling !== launch) {
      wide.insertAdjacentElement("afterend", launch);
    }
    const available = [...detailLines.values()].filter(canUndo).length;
    const label = `Deshacer requisiciones (${available})`;
    if (launch.textContent !== label) launch.textContent = label;
    launch.disabled = available === 0;
    launch.title = available ? "Seleccionar SKU y regresar a En compras" : "No hay requisiciones reversibles";
  }

  // Ambas vistas contienen el botón existente de recepción con el lineId correcto.
  // No dependemos del orden de las tarjetas ni del nombre del producto.
  const seen = new Set();
  body?.querySelectorAll(".request-line-receive[data-line-id]").forEach(receive => {
    const requestId = receive.dataset.requestId;
    const lineId = receive.dataset.lineId;
    if (requestId !== detailRequestId || !lineId || seen.has(`${requestId}/${lineId}`)) return;
    seen.add(`${requestId}/${lineId}`);
    const line = detailLines.get(lineId);
    const parent = receive.closest(".grouped-line-actions") || receive.parentElement;
    if (!parent) return;
    let button = parent.querySelector(".request-line-undo-requisition");
    if (!canUndo(line)) {
      button?.remove();
      return;
    }
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-outline-warning btn-sm request-line-undo-requisition";
      button.dataset.requestId = requestId;
      button.dataset.lineId = lineId;
      button.textContent = "Deshacer requisición";
      button.title = "Regresar esta línea a En compras";
      receive.insertAdjacentElement("beforebegin", button);
    }
  });
}

function observeDetail() {
  const body = document.querySelector("#purchaseRequestDetailBody");
  if (!body || detailObservedBody === body) return;
  detailObserver?.disconnect();
  detailObservedBody = body;
  detailObserver = new MutationObserver(() => renderDetailButtons());
  detailObserver.observe(body, { childList: true, subtree: true });
}

async function updateDetail(requestId) {
  if (!requestId) return;
  const sequence = ++loadSequence;
  try {
    if (!await loadRole()) return;
    const lines = await fetchLines(requestId);
    if (sequence !== loadSequence || currentDetailRequestId() !== requestId) return;
    detailRequestId = requestId;
    detailLines.clear();
    lines.forEach(line => detailLines.set(line.id, line));
    observeDetail();
    renderDetailButtons();
  } catch (error) {
    console.error("No se pudieron preparar los botones Deshacer requisición:", error);
  }
}

function normalizeRequisitionRefs(refs) {
  if (!Array.isArray(refs)) return [];
  return refs.map(ref => ({
    requestId: String(ref?.requestId || ""),
    lineId: String(ref?.lineId || ref?.itemId || ""),
    folio: String(ref?.folio || ""),
    requisitionQty: Math.max(num(ref?.requisitionQty), 0),
  })).filter(ref => ref.requestId && ref.lineId && ref.requisitionQty > 0);
}

/** Una única operación atómica para ambas interfaces; lee antes de escribir. */
async function undoLine(requestId, lineId) {
  if (!auth.currentUser || !await loadRole()) {
    throw new Error("Sólo el Administrador puede deshacer requisiciones.");
  }
  const requestRef = doc(db, "purchaseRequests", requestId);
  const lineRef = doc(db, "purchaseRequests", requestId, "items", lineId);
  const user = auth.currentUser;

  await runTransaction(db, async transaction => {
    const lineSnap = await transaction.get(lineRef);
    if (!lineSnap.exists()) throw new Error("La línea de solicitud ya no existe.");
    const line = lineSnap.data();
    if (!canUndo(line)) {
      throw new Error(`${line.sku || line.nombre || lineId}: ya no puede deshacerse; verifica recepciones y cancelaciones.`);
    }

    const itemId = String(line.itemId || lineId);
    const itemRef = doc(db, "items", itemId);
    const itemSnap = await transaction.get(itemRef);
    if (!itemSnap.exists()) throw new Error(`${line.sku || lineId}: el producto ya no existe.`);
    const requestSnap = await transaction.get(requestRef);
    if (!requestSnap.exists() || requestSnap.data().status === "draft") {
      throw new Error("La solicitud no existe o todavía es un borrador.");
    }

    const refs = normalizeRequisitionRefs(itemSnap.data().purchaseRequisitionRefs);
    const matching = refs.filter(ref => ref.requestId === requestId && ref.lineId === itemId);
    const matchingQty = matching.reduce((sum, ref) => sum + ref.requisitionQty, 0);
    if (matching.length !== 1 || Math.abs(matchingQty - pendingQty(line)) > 0.00001) {
      throw new Error(`${line.sku || lineId}: las cantidades de requisición no coinciden con el inventario. No se modificó nada; es necesario revisar el registro.`);
    }
    const remaining = refs.filter(ref => !(ref.requestId === requestId && ref.lineId === itemId));
    const total = remaining.reduce((sum, ref) => sum + ref.requisitionQty, 0);

    transaction.update(itemRef, {
      purchaseRequisitionQty: total,
      purchaseRequisitionRefs: remaining,
      updatedAt: serverTimestamp(),
    });
    transaction.update(lineRef, {
      requisitionStatus: deleteField(),
      requisitionedAt: deleteField(),
      requisitionedBy: deleteField(),
      requisitionedByName: deleteField(),
      requisitionUnitCost: deleteField(),
      requisitionUndoAt: serverTimestamp(),
      requisitionUndoBy: user.uid,
      requisitionUndoByName: profile?.nombre || user.email || "",
      updatedAt: serverTimestamp(),
    });
    transaction.update(requestRef, { updatedAt: serverTimestamp() });
  });
}

function refreshRequestViews(requestId, { reopen = true } = {}) {
  // Los controladores existentes leen nuevamente desde Firestore y actualizan
  // tarjetas, badges, reportes y acumulados de la página sin recargarla.
  if (reopen) {
    const view = [...document.querySelectorAll(".request-history-view")]
      .find(button => button.dataset.requestId === requestId);
    view?.click();
  }
  document.querySelector("#refreshPurchaseRequests")?.click();
}

async function undoIndividual(requestId, lineId, button) {
  if (busy) return;
  const line = detailLines.get(lineId);
  if (!canUndo(line)) {
    alert("Esta línea ya no está disponible para deshacer. Actualiza la solicitud.");
    return;
  }
  const name = line.sku || line.nombre || lineId;
  if (!confirm(`¿Deshacer la requisición de ${name}?\n\nLa línea regresará a «En compras». No se alterarán las cantidades solicitadas, precios ni existencias.`)) return;

  busy = true;
  button.disabled = true;
  button.textContent = "Deshaciendo…";
  try {
    await undoLine(requestId, lineId);
    const changed = detailLines.get(lineId);
    if (changed) detailLines.set(lineId, { ...changed, requisitionStatus: "" });
    renderDetailButtons();
    refreshRequestViews(requestId);
    alert(`Requisición deshecha: ${name}. El artículo regresó a «En compras».`);
  } catch (error) {
    console.error("No se pudo deshacer la requisición:", error);
    alert(`No se pudo deshacer la requisición: ${error.message}`);
    button.disabled = false;
    button.textContent = "Deshacer requisición";
  } finally {
    busy = false;
  }
}

function ensureModal() {
  let modal = document.querySelector(`#${MODAL_ID}`);
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = MODAL_ID;
  modal.className = "modal fade";
  modal.tabIndex = -1;
  modal.innerHTML = `
    <div class="modal-dialog modal-xl modal-dialog-scrollable">
      <div class="modal-content">
        <div class="modal-header">
          <div><h5 class="modal-title mb-0">Deshacer requisiciones</h5>
            <div class="small text-muted" id="requestUndoSubtitle"></div></div>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button>
        </div>
        <div class="modal-body">
          <p class="small text-muted">Selecciona los SKU que fueron enviados a requisición por error. Volverán a <strong>En compras</strong>. No se modifican precios, cantidades solicitadas ni existencias. No pueden deshacerse líneas con recepciones o cancelaciones.</p>
          <div class="d-flex gap-2 flex-wrap mb-3">
            <button type="button" class="btn btn-outline-dark btn-sm" id="requestUndoSelectAll">Seleccionar todos</button>
            <button type="button" class="btn btn-outline-secondary btn-sm" id="requestUndoClear">Quitar selección</button>
            <span class="small text-muted align-self-center" id="requestUndoCount"></span>
          </div>
          <div id="requestUndoMessage" class="small text-danger mb-2" style="white-space: pre-line" role="status" aria-live="polite"></div>
          <div class="table-responsive"><table class="table table-sm table-hover align-middle">
            <thead><tr><th scope="col">Seleccionar</th><th scope="col">Producto</th><th scope="col">SKU</th><th scope="col">Zona / área</th><th scope="col" class="text-end">Pendientes</th></tr></thead>
            <tbody id="requestUndoRows"></tbody>
          </table></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cerrar</button>
          <button type="button" class="btn btn-warning" id="requestUndoSave">Deshacer seleccionadas</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("hidden.bs.modal", () => {
    const requestId = reopenDetailId;
    reopenDetailId = "";
    if (requestId) refreshRequestViews(requestId);
  });
  return modal;
}

function selectionCount() {
  const modal = ensureModal();
  const count = modal.querySelectorAll(".request-undo-check:checked").length;
  const countEl = modal.querySelector("#requestUndoCount");
  countEl.textContent = `${count} SKU seleccionados`;
  modal.querySelector("#requestUndoSave").disabled = !count || busy;
}

function renderMassLines(lines, message = "") {
  const modal = ensureModal();
  const eligible = lines.filter(canUndo).sort((a, b) =>
    String(a.nombre || "").localeCompare(String(b.nombre || ""), "es", { sensitivity: "base" })
    || String(a.sku || "").localeCompare(String(b.sku || ""), "es", { numeric: true })
  );
  modal.querySelector("#requestUndoRows").innerHTML = eligible.length
    ? eligible.map(line => `
      <tr>
        <td><input class="form-check-input request-undo-check" type="checkbox" value="${escapeHtml(line.id)}" aria-label="Seleccionar ${escapeHtml(line.sku || line.nombre || line.id)}"></td>
        <td>${escapeHtml(line.nombre || "Producto")}</td>
        <td><strong>${escapeHtml(line.sku || "")}</strong></td>
        <td class="small">${escapeHtml([line.zoneId, line.subzoneId, line.locationCode || line.locationName].filter(Boolean).join(" / "))}</td>
        <td class="text-end">${pendingQty(line)}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="text-center text-muted py-4">No hay requisiciones reversibles en esta solicitud.</td></tr>`;
  modal.querySelector("#requestUndoMessage").textContent = message;
  modal.querySelector("#requestUndoSubtitle").textContent = `${eligible.length} SKU con requisición reversible`;
  selectionCount();
}

async function openUndoModal(requestId) {
  if (busy || !requestId) return;
  try {
    if (!await loadRole()) {
      alert("Sólo el Administrador puede deshacer requisiciones.");
      return;
    }
    modalRequestId = requestId;
    const modal = ensureModal();
    modal.querySelector("#requestUndoRows").innerHTML = `<tr><td colspan="5" class="text-center py-3">Cargando requisiciones…</td></tr>`;
    const requestSnap = await getDoc(doc(db, "purchaseRequests", requestId));
    if (!requestSnap.exists()) throw new Error("La solicitud ya no existe.");
    const lines = await fetchLines(requestId);
    renderMassLines(lines);

    const detailModal = getDetailModal();
    const show = () => bootstrap.Modal.getOrCreateInstance(modal).show();
    if (detailModal?.classList.contains("show")) {
      reopenDetailId = requestId;
      detailModal.addEventListener("hidden.bs.modal", show, { once: true });
      bootstrap.Modal.getOrCreateInstance(detailModal).hide();
    } else {
      reopenDetailId = "";
      show();
    }
  } catch (error) {
    console.error("No se pudo abrir el deshacer masivo:", error);
    alert(`No se pudieron cargar las requisiciones: ${error.message}`);
  }
}

async function undoSelected() {
  if (busy || !modalRequestId) return;
  const modal = ensureModal();
  const selection = [...modal.querySelectorAll(".request-undo-check:checked")].map(input => input.value);
  if (!selection.length) return;
  if (!confirm(`¿Deshacer ${selection.length} requisición${selection.length === 1 ? "" : "es"}?\n\nLos SKU seleccionados regresarán a «En compras»; no se alterarán inventario, cantidades solicitadas ni precios.`)) return;

  busy = true;
  const save = modal.querySelector("#requestUndoSave");
  const closeButtons = modal.querySelectorAll('[data-bs-dismiss="modal"]');
  closeButtons.forEach(b => { b.disabled = true; });
  modal.querySelectorAll(".request-undo-check").forEach(c => { c.disabled = true; });
  save.disabled = true;
  const failures = [];
  let success = 0;
  try {
    for (const lineId of selection) {
      save.textContent = `Deshaciendo ${success + failures.length + 1} de ${selection.length}…`;
      try {
        await undoLine(modalRequestId, lineId);
        success++;
      } catch (error) {
        failures.push(`${lineId}: ${error.message}`);
      }
    }
    const lines = await fetchLines(modalRequestId);
    renderMassLines(lines, failures.length
      ? `${success} requisiciones deshechas. ${failures.length} errores:\n${failures.slice(0, 8).join("\n")}`
      : `${success} requisiciones deshechas correctamente.`);
    if (success && !failures.length) {
      bootstrap.Modal.getOrCreateInstance(modal).hide();
    } else if (success) {
      // Si hubo resultados parciales, el usuario puede revisar la lista y cerrar.
      alert(`${success} requisiciones deshechas; ${failures.length} no pudieron revertirse. Revisa el detalle de errores en el cuadro.`);
    } else if (failures.length) {
      alert(`No se pudo deshacer ninguna requisición. Revisa los errores en el cuadro.`);
    }
  } catch (error) {
    console.error("Error al actualizar la lista de requisiciones:", error);
    alert(`Se completaron ${success} cambios, pero no pudo actualizarse la lista: ${error.message}`);
  } finally {
    busy = false;
    save.textContent = "Deshacer seleccionadas";
    closeButtons.forEach(b => { b.disabled = false; });
    modal.querySelectorAll(".request-undo-check").forEach(c => { c.disabled = false; });
    selectionCount();
  }
}

document.addEventListener("purchase-request-detail-rendered", event => {
  updateDetail(String(event.detail?.requestId || currentDetailRequestId()));
});

document.addEventListener("shown.bs.modal", event => {
  if (event.target?.id === "purchaseRequestDetailModal") updateDetail(currentDetailRequestId());
});

document.addEventListener("click", event => {
  const individual = event.target.closest(".request-line-undo-requisition");
  if (individual) {
    event.preventDefault();
    undoIndividual(individual.dataset.requestId, individual.dataset.lineId, individual);
    return;
  }
  if (event.target.closest("#requestUndoSelectAll")) {
    document.querySelectorAll(`#${MODAL_ID} .request-undo-check:not(:disabled)`).forEach(input => { input.checked = true; });
    selectionCount();
  } else if (event.target.closest("#requestUndoClear")) {
    document.querySelectorAll(`#${MODAL_ID} .request-undo-check:not(:disabled)`).forEach(input => { input.checked = false; });
    selectionCount();
  } else if (event.target.closest("#requestUndoSave")) {
    undoSelected();
  } else if (event.target.closest(".request-view-mode")) {
    // El módulo agrupador reemplaza los elementos de la vista.
    queueMicrotask(renderDetailButtons);
  }
});

document.addEventListener("change", event => {
  if (event.target.matches(`#${MODAL_ID} .request-undo-check`)) selectionCount();
});
