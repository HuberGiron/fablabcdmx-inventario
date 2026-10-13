/*
 * FabLab CDMX / Compras
 * Recepción masiva por solicitud y política de acciones por etapa.
 * Instalar DESPUÉS de compras-status, grouping, batch, wide-requisition y undo.
 * No modifica las solicitudes o los precios hasta confirmar una recepción.
 * Reglas de Firestore: únicamente el Administrador puede modificar items/solicitudes.
 */
import { auth, db } from "./firebase-app.js";
import { getUserProfile, waitForUser } from "./common.js";
import {
  collection, doc, getDoc, getDocs, runTransaction, serverTimestamp, updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const MODAL_ID = "purchaseMassReceiptModal";
const LAUNCHER_ID = "purchaseMassReceiptLauncher";
const linesById = new Map();
let activeRequestId = "";
let activeRole = "";
let currentProfile = null;
let rolePromise = null;
let sequence = 0;
let busy = false;
let groupBusy = false;
let modalRequestId = "";
let reopenDetailId = "";
let detailBody = null;
let detailObserver = null;
let groupModalObserver = null;

const n = value => { const v = Number(value); return Number.isFinite(v) ? v : 0; };
const esc = value => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const qtyPending = line => Math.max(n(line?.quantityRequested) - n(line?.quantityReceived) - n(line?.quantityCancelled), 0);
const isInRequisition = line => line?.requisitionStatus === "requisitioned" && qtyPending(line) > 0;
const canReceive = line => Boolean(line && isInRequisition(line));
const canCancel = line => Boolean(line && !isInRequisition(line) && qtyPending(line) > 0 && n(line.quantityReceived) === 0);
const canRequisition = line => Boolean(line && !isInRequisition(line) && qtyPending(line) > 0 && n(line.quantityReceived) === 0 && n(line.quantityCancelled) === 0);
const isFinished = line => Boolean(line && qtyPending(line) === 0);
const currentId = () => String(document.querySelector("#purchaseRequestDetailPdf")?.dataset.requestId || "");

async function isAdmin() {
  if (!rolePromise) {
    rolePromise = (async () => {
      const user = auth.currentUser || await waitForUser();
      if (!user) return;
      currentProfile = await getUserProfile(user.uid);
      activeRole = String(currentProfile?.appRole || currentProfile?.role || "");
    })().catch(error => { rolePromise = null; throw error; });
  }
  await rolePromise;
  return activeRole === "admin";
}

async function fetchLines(requestId) {
  const snap = await getDocs(collection(db, "purchaseRequests", requestId, "items"));
  return snap.docs.map(x => ({ id: x.id, ...x.data() }));
}

function policyButton(button, allowed, reason) {
  if (!button || activeRole !== "admin") return;
  if (button.disabled !== !allowed) button.disabled = !allowed;
  if (!allowed) {
    if (button.title !== reason) button.title = reason;
    button.setAttribute("aria-disabled", "true");
    button.classList.add("opacity-50");
  } else {
    if (button.getAttribute("aria-disabled") === "true") button.removeAttribute("aria-disabled");
    if (button.classList.contains("opacity-50")) button.classList.remove("opacity-50");
    if (button.dataset.stageReason === "1") button.title = "";
  }
  button.dataset.stageReason = allowed ? "" : "1";
}

function applyIndividualPolicy(body) {
  body.querySelectorAll(".request-line-receive[data-line-id], .request-line-requisition[data-line-id], .request-line-cancel[data-line-id]")
    .forEach(button => {
      if (button.dataset.requestId !== activeRequestId) return;
      const line = linesById.get(button.dataset.lineId);
      if (!line) return;
      if (button.matches(".request-line-receive")) {
        policyButton(button, canReceive(line), "Primero se debe registrar la requisición de este SKU.");
      } else if (button.matches(".request-line-cancel")) {
        policyButton(button, canCancel(line), "Sólo se pueden cancelar piezas que todavía están en Compras.");
      } else {
        policyButton(button, canRequisition(line), "Este SKU ya no está disponible para requisición.");
      }
    });
  body.querySelectorAll(".request-price-action[data-line-id]").forEach(button => {
    const line = linesById.get(button.dataset.lineId);
    if (!line || activeRole !== "admin") return;
    // El precio sigue siendo editable también cuando ya se recibió todo.
    const label = isInRequisition(line) ? "Cambiar costo" : "Cambiar precio";
    if (button.textContent !== label) button.textContent = label;
  });
}

function groupSkuRows(card) {
  return [...card.querySelectorAll(".grouped-breakdown-table tbody tr")].map(tr =>
    String(tr.querySelector("td:first-child strong")?.textContent || "").trim()
  ).filter(Boolean);
}

function applyGroupedPolicy(body) {
  // Los botones agrupados los dibuja el módulo original, que originalmente
  // consideraba recibibles todas las líneas pendientes, incluso sin requisición.
  body.querySelectorAll(".grouped-request-card").forEach(card => {
    const skus = new Set(groupSkuRows(card));
    const groupLines = [...linesById.values()].filter(line => skus.has(String(line.sku || "").trim()));
    if (!groupLines.length) return;
    const requisitionCount = groupLines.filter(canRequisition).length;
    const receiveCount = groupLines.filter(canReceive).length;
    const requisition = card.querySelector(".group-batch-requisition");
    const receive = card.querySelector(".group-batch-receive");
    if (requisition) {
      policyButton(requisition, requisitionCount > 0, "No hay SKU disponibles para pasar a requisición en este grupo.");
      if (requisition.textContent.trim() !== `Registrar requisición (${requisitionCount})`) requisition.textContent = `Registrar requisición (${requisitionCount})`;
    }
    if (receive) {
      policyButton(receive, receiveCount > 0, "Primero debe registrarse la requisición de los SKU.");
      if (receive.textContent.trim() !== `Registrar recepción (${receiveCount})`) receive.textContent = `Registrar recepción (${receiveCount})`;
    }
  });
}

function launcherContainer(body) {
  const toolbar = body?.querySelector("#requestGroupingToolbar");
  return toolbar?.querySelector(":scope > .d-flex.flex-wrap.justify-content-between") || toolbar;
}

function attachLauncher(body) {
  if (activeRole !== "admin") return;
  const container = launcherContainer(body);
  if (!container) return;
  let button = container.querySelector(`#${LAUNCHER_ID}`);
  if (!button) {
    button = document.createElement("button");
    button.id = LAUNCHER_ID;
    button.type = "button";
    button.className = "btn btn-success btn-sm";
    container.appendChild(button);
  }
  // No recolocar junto a #requestWideRequisitionButton: el módulo de
  // "Deshacer requisición" también ordena su botón allí y ambos observers
  // entrarían en un ciclo de movimientos del DOM.
  button.dataset.requestId = activeRequestId;
  const count = [...linesById.values()].filter(canReceive).length;
  const title = `Registrar recepción masiva (${count})`;
  if (button.textContent !== title) button.textContent = title;
  policyButton(button, count > 0, "No hay SKU pendientes con requisición registrada.");
}

function updateCancelButtons() {
  if (activeRole !== "admin" || !activeRequestId) return;
  const lines = [...linesById.values()];
  const hasReq = lines.some(isInRequisition);
  const hasUnrequisitionedPending = lines.some(canCancel);
  const detailCancel = document.querySelector("#purchaseRequestCancelAll");
  if (detailCancel?.dataset.requestId === activeRequestId) {
    policyButton(detailCancel, !hasReq && hasUnrequisitionedPending,
      "Deshaz las requisiciones antes de cancelar la solicitud; sólo se cancelan artículos en Compras.");
  }
  const historyCancel = [...document.querySelectorAll(".request-history-cancel")]
    .find(button => button.dataset.requestId === activeRequestId);
  if (historyCancel) {
    policyButton(historyCancel, !hasReq && hasUnrequisitionedPending,
      "No se puede cancelar toda la solicitud mientras existan SKU en requisición.");
  }
}

function decorate() {
  if (activeRole !== "admin" || !activeRequestId || currentId() !== activeRequestId) return;
  const body = document.querySelector("#purchaseRequestDetailBody");
  if (!body) return;
  applyIndividualPolicy(body);
  applyGroupedPolicy(body);
  attachLauncher(body);
  updateCancelButtons();
}

function observeDetailBody() {
  const body = document.querySelector("#purchaseRequestDetailBody");
  if (!body || detailBody === body) return;
  detailObserver?.disconnect();
  detailBody = body;
  // No observar atributos: los cambios de disabled/texto de nuestros botones no
  // generan una cadena infinita de decoraciones.
  detailObserver = new MutationObserver(mutations => {
    if (mutations.some(m => m.type === "childList" && (m.addedNodes.length || m.removedNodes.length))) {
      decorate();
    }
  });
  detailObserver.observe(body, { childList: true, subtree: true });
}

async function reloadDetail(requestId) {
  if (!requestId) return;
  const token = ++sequence;
  try {
    if (!await isAdmin()) return;
    const lines = await fetchLines(requestId);
    if (token !== sequence || currentId() !== requestId) return;
    activeRequestId = requestId;
    linesById.clear();
    lines.forEach(line => linesById.set(line.id, line));
    observeDetailBody();
    decorate();
  } catch (error) { console.error("No se pudieron preparar acciones por etapa:", error); }
}

const normalizeRefs = (raw, quantityKey) => Array.isArray(raw) ? raw
  .map(ref => ({ ...ref,
    requestId: String(ref?.requestId || ""),
    lineId: String(ref?.lineId || ref?.itemId || ""),
    [quantityKey]: Math.max(n(ref?.[quantityKey]), 0),
  }))
  .filter(ref => ref.requestId && ref.lineId && ref[quantityKey] > 0) : [];

function subtractReference(refs, requestId, itemId, quantityKey, quantity, expected) {
  const matches = refs.filter(ref => ref.requestId === requestId && ref.lineId === itemId);
  const matchedQty = matches.reduce((sum, ref) => sum + ref[quantityKey], 0);
  if (matches.length !== 1 || Math.abs(matchedQty - expected) > 0.000001) {
    throw new Error("Las cantidades registradas en el artículo no coinciden con la solicitud. No se ha modificado nada.");
  }
  return refs.map(ref => {
    if (ref.requestId !== requestId || ref.lineId !== itemId) return ref;
    return { ...ref, [quantityKey]: Math.max(ref[quantityKey] - quantity, 0) };
  }).filter(ref => ref[quantityKey] > 0);
}

/** Recepción de un SKU: actualización atómica del inventario, línea y referencias. */
async function receiveLine(requestId, lineId, quantity, unitCost) {
  const qty = Number(quantity);
  const cost = Number(unitCost);
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error("La cantidad debe ser un número entero positivo.");
  if (!Number.isFinite(cost) || cost < 0) throw new Error("El costo unitario debe ser válido y no negativo.");
  if (!auth.currentUser || !await isAdmin()) throw new Error("Sólo el Administrador puede registrar recepciones.");
  const lineRef = doc(db, "purchaseRequests", requestId, "items", lineId);
  const requestRef = doc(db, "purchaseRequests", requestId);
  await runTransaction(db, async transaction => {
    const lineSnap = await transaction.get(lineRef);
    if (!lineSnap.exists()) throw new Error("La línea de solicitud ya no existe.");
    const line = lineSnap.data();
    const pending = qtyPending(line);
    if (!canReceive(line) || pending < qty) {
      throw new Error(`${line.sku || line.nombre || lineId}: sólo se pueden recibir piezas con requisición vigente y pendientes (máximo ${pending}).`);
    }
    const itemId = String(line.itemId || lineId);
    const itemRef = doc(db, "items", itemId);
    const [itemSnap, requestSnap] = await Promise.all([transaction.get(itemRef), transaction.get(requestRef)]);
    if (!itemSnap.exists()) throw new Error("El artículo asociado ya no existe.");
    if (!requestSnap.exists() || requestSnap.data().status === "draft") throw new Error("La solicitud no está enviada.");
    const item = itemSnap.data();
    const pendingRefs = subtractReference(
      normalizeRefs(item.purchasePendingRefs, "pendingQty"), requestId, itemId, "pendingQty", qty, pending
    );
    const requisitionRefs = subtractReference(
      normalizeRefs(item.purchaseRequisitionRefs, "requisitionQty"), requestId, itemId, "requisitionQty", qty, pending
    );
    const oldReceived = n(line.quantityReceived);
    const nextReceived = oldReceived + qty;
    const remaining = pending - qty;
    const previousActual = Object.hasOwn(line, "actualCostTotal")
      ? n(line.actualCostTotal) : oldReceived * n(line.unitPrice);
    transaction.update(itemRef, {
      purchasePendingQty: pendingRefs.reduce((total, ref) => total + ref.pendingQty, 0),
      purchasePendingRefs: pendingRefs,
      purchaseRequisitionQty: requisitionRefs.reduce((total, ref) => total + ref.requisitionQty, 0),
      purchaseRequisitionRefs: requisitionRefs,
      stockAlmacen: n(item.stockAlmacen) + qty,
      updatedAt: serverTimestamp(),
    });
    transaction.update(lineRef, {
      quantityReceived: nextReceived,
      quantityCancelled: n(line.quantityCancelled),
      status: remaining > 0 ? "partial" : "received",
      lastReceivedAt: serverTimestamp(),
      lastActualCostAt: serverTimestamp(),
      lastActualUnitCost: cost,
      actualCostTotal: previousActual + qty * cost,
      updatedAt: serverTimestamp(),
    });
    transaction.update(requestRef, { updatedAt: serverTimestamp() });
  });
}

async function recalculateRequest(requestId) {
  const lines = await fetchLines(requestId);
  let pending = 0, received = 0, cancelled = 0, totalQty = 0;
  const totalsByCurrency = {};
  for (const line of lines) {
    pending += qtyPending(line);
    received += n(line.quantityReceived);
    cancelled += n(line.quantityCancelled);
    const qty = Math.max(n(line.quantityRequested), 0);
    totalQty += qty;
    const currency = String(line.currency || "MXN").toUpperCase();
    totalsByCurrency[currency] = n(totalsByCurrency[currency]) + qty * Math.max(n(line.unitPrice), 0);
  }
  const status = pending > 0 ? ((received > 0 || cancelled > 0) ? "partial" : "sent")
    : received > 0 ? "completed" : "cancelled";
  await updateDoc(doc(db, "purchaseRequests", requestId), {
    status, itemCount: lines.length, totalQty, totalsByCurrency, updatedAt: serverTimestamp(),
  });
}

function refreshViews(requestId) {
  document.querySelector("#refreshPurchaseRequests")?.click();
  const detail = document.querySelector("#purchaseRequestDetailModal");
  if (detail?.classList.contains("show") && currentId() === requestId) {
    // Refrescar detalle pulsando el botón original de la solicitud.
    const button = [...document.querySelectorAll(".request-history-view")]
      .find(el => el.dataset.requestId === requestId);
    button?.click();
  }
}

function ensureModal() {
  let modal = document.getElementById(MODAL_ID);
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = MODAL_ID;
  modal.className = "modal fade";
  modal.tabIndex = -1;
  modal.innerHTML = `
    <div class="modal-dialog modal-xl modal-dialog-scrollable">
      <div class="modal-content">
        <div class="modal-header"><div>
          <h5 class="modal-title mb-0">Registrar recepción masiva</h5>
          <div class="small text-muted" id="massReceiptSubtitle"></div>
        </div><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button></div>
        <div class="modal-body">
          <p class="small text-muted">Selecciona uno o varios SKU <strong>en requisición</strong>. Puedes indicar cuántas piezas llegaron (parcial o total) y su costo unitario real. Las existencias y el gasto real se actualizarán por cada recepción.</p>
          <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
            <button type="button" id="massReceiptSelectAll" class="btn btn-outline-dark btn-sm">Seleccionar todos</button>
            <button type="button" id="massReceiptClear" class="btn btn-outline-secondary btn-sm">Quitar selección</button>
            <span id="massReceiptSummary" class="small text-muted"></span>
          </div>
          <div id="massReceiptErrors" class="small text-danger mb-2" style="white-space:pre-line" role="status" aria-live="polite"></div>
          <div class="table-responsive"><table class="table table-hover table-sm align-middle">
            <thead><tr><th></th><th>Producto / SKU</th><th>Zona / área</th><th class="text-end">Pendiente</th><th>Recibir</th><th>Costo unitario real</th></tr></thead>
            <tbody id="massReceiptRows"></tbody>
          </table></div>
        </div>
        <div class="modal-footer">
          <button type="button" data-bs-dismiss="modal" class="btn btn-secondary">Cerrar</button>
          <button type="button" id="massReceiptSave" class="btn btn-success">Registrar recepciones seleccionadas</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("hidden.bs.modal", () => {
    const id = reopenDetailId;
    reopenDetailId = "";
    if (id) {
      refreshViews(id);
      const viewButton = [...document.querySelectorAll(".request-history-view")]
        .find(button => button.dataset.requestId === id);
      if (viewButton) window.setTimeout(() => viewButton.click(), 120);
    }
  });
  return modal;
}

function renderMassRows(lines, message = "", preselect = false) {
  const modal = ensureModal();
  const eligible = lines.filter(canReceive)
    .sort((a, b) => String(a.nombre || "").localeCompare(String(b.nombre || ""), "es", { sensitivity: "base" })
      || String(a.sku || "").localeCompare(String(b.sku || ""), "es", { numeric: true }));
  modal.querySelector("#massReceiptSubtitle").textContent = `${eligible.length} SKU pendientes con requisición`;
  modal.querySelector("#massReceiptErrors").textContent = message;
  modal.querySelector("#massReceiptRows").innerHTML = eligible.length ? eligible.map(line => {
    const pending = qtyPending(line);
    const currency = esc(String(line.currency || "MXN").toUpperCase());
    const cost = Math.max(n(line.requisitionUnitCost ?? line.unitPrice), 0);
    return `<tr class="mass-receipt-row" data-line-id="${esc(line.id)}" data-pending="${pending}" data-currency="${currency}">
      <td><input class="form-check-input mass-receipt-check" type="checkbox" ${preselect ? "checked" : ""} aria-label="Seleccionar ${esc(line.sku || line.id)}"></td>
      <td><strong>${esc(line.nombre || "Producto")}</strong><div class="small text-muted">${esc(line.sku || "")}</div></td>
      <td class="small">${esc([line.zoneId, line.subzoneId, line.locationCode || line.locationName].filter(Boolean).join(" / "))}</td>
      <td class="text-end"><strong>${pending}</strong></td>
      <td style="min-width:105px"><input type="number" class="form-control form-control-sm mass-receipt-qty" min="1" max="${pending}" step="1" value="${pending}" aria-label="Cantidad recibida"></td>
      <td style="min-width:135px"><div class="input-group input-group-sm"><span class="input-group-text">${currency}</span><input type="number" class="form-control mass-receipt-cost" min="0" step="0.01" value="${cost}" aria-label="Costo unitario real"></div></td>
    </tr>`;
  }).join("") : `<tr><td colspan="6" class="text-center text-muted py-4">No hay SKU pendientes en requisición.</td></tr>`;
  updateSummary();
}

function selectedMassRows() {
  return [...ensureModal().querySelectorAll(".mass-receipt-row")]
    .filter(row => row.querySelector(".mass-receipt-check")?.checked);
}

function validateSelection() {
  return selectedMassRows().map(row => {
    const quantity = Number(row.querySelector(".mass-receipt-qty")?.value);
    const costText = String(row.querySelector(".mass-receipt-cost")?.value ?? "").trim();
    const cost = Number(costText);
    const pending = Number(row.dataset.pending);
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > pending)
      throw new Error(`Cantidad de recepción inválida. Debe ser un entero entre 1 y ${pending}.`);
    if (!costText || !Number.isFinite(cost) || cost < 0) throw new Error("Captura costos unitarios válidos, mayores o iguales a cero.");
    return { lineId: row.dataset.lineId, quantity, cost, currency: row.dataset.currency };
  });
}

function updateSummary() {
  const modal = ensureModal();
  const rows = selectedMassRows();
  const sums = new Map();
  let quantity = 0;
  let valid = true;
  try {
    for (const s of validateSelection()) {
      quantity += s.quantity;
      sums.set(s.currency, n(sums.get(s.currency)) + s.quantity * s.cost);
    }
  } catch { valid = false; }
  const money = [...sums.entries()]
    .map(([currency, amount]) => `${currency} ${amount.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`).join(" · ");
  modal.querySelector("#massReceiptSummary").textContent = !valid
    ? "Verifica cantidad y costo." : `${rows.length} SKU · ${quantity} piezas${money ? " · " + money : ""}`;
  modal.querySelector("#massReceiptSave").disabled = !rows.length || busy || !valid;
}

async function openMassModal(requestId, onlyLineId = "") {
  if (busy || !requestId) return;
  try {
    if (!await isAdmin()) { alert("Sólo el Administrador puede recibir artículos."); return; }
    const requestSnap = await getDoc(doc(db, "purchaseRequests", requestId));
    if (!requestSnap.exists() || requestSnap.data().status === "draft") throw new Error("La solicitud aún no se ha enviado.");
    modalRequestId = requestId;
    const lines = await fetchLines(requestId);
    const displayed = onlyLineId ? lines.filter(line => line.id === onlyLineId) : lines;
    if (onlyLineId && !displayed.some(canReceive)) throw new Error("Esta línea ya no está en requisición o no tiene piezas pendientes.");
    renderMassRows(displayed, "", Boolean(onlyLineId));
    const modal = ensureModal();
    modal.querySelector(".modal-title").textContent = onlyLineId ? "Registrar recepción individual" : "Registrar recepción masiva";
    const detail = document.querySelector("#purchaseRequestDetailModal");
    const show = () => bootstrap.Modal.getOrCreateInstance(modal).show();
    if (detail?.classList.contains("show")) {
      reopenDetailId = requestId;
      detail.addEventListener("hidden.bs.modal", show, { once: true });
      bootstrap.Modal.getOrCreateInstance(detail).hide();
    } else { reopenDetailId = ""; show(); }
  } catch (error) {
    console.error("No se pudo abrir recepción masiva:", error);
    alert(`No se pudo abrir recepción masiva: ${error.message}`);
  }
}

async function saveMassReceipt() {
  if (busy || !modalRequestId) return;
  let selections;
  try { selections = validateSelection(); }
  catch (error) { alert(error.message); return; }
  if (!selections.length) return;
  const pieces = selections.reduce((sum, s) => sum + s.quantity, 0);
  if (!confirm(`¿Registrar la recepción de ${pieces} piezas correspondientes a ${selections.length} SKU?\n\nSe actualizará el inventario y el gasto real. Las recepciones no se pueden deshacer desde esta función.`)) return;
  busy = true;
  const modal = ensureModal();
  const save = modal.querySelector("#massReceiptSave");
  const closeButtons = modal.querySelectorAll('[data-bs-dismiss="modal"]');
  closeButtons.forEach(x => { x.disabled = true; });
  modal.querySelectorAll("input").forEach(x => { x.disabled = true; });
  const failures = [];
  let successes = 0;
  try {
    for (const item of selections) {
      save.textContent = `Registrando ${successes + failures.length + 1}/${selections.length}…`;
      try { await receiveLine(modalRequestId, item.lineId, item.quantity, item.cost); successes++; }
      catch (error) { failures.push(`${item.lineId}: ${error.message}`); }
    }
    if (successes) await recalculateRequest(modalRequestId);
    const lines = await fetchLines(modalRequestId);
    renderMassRows(lines, failures.length
      ? `${successes} recepciones registradas. ${failures.length} errores:\n${failures.slice(0, 10).join("\n")}`
      : `${successes} recepciones registradas correctamente.`);
    if (successes && !failures.length) {
      bootstrap.Modal.getOrCreateInstance(modal).hide();
    } else if (successes) {
      alert(`${successes} recepciones guardadas; ${failures.length} no pudieron completarse. Consulta el detalle de errores.`);
    } else if (failures.length) {
      alert("Ninguna recepción se guardó. Revisa los errores indicados.");
    }
  } catch (error) {
    console.error("Error al finalizar la recepción masiva:", error);
    alert(`Se registraron ${successes} recepciones, pero hubo un problema actualizando el resumen: ${error.message}`);
  } finally {
    busy = false;
    save.textContent = "Registrar recepciones seleccionadas";
    closeButtons.forEach(x => { x.disabled = false; });
    modal.querySelectorAll("input").forEach(x => { x.disabled = false; });
    updateSummary();
    if (successes) refreshViews(modalRequestId);
  }
}

function restrictGroupModal() {
  const modal = document.querySelector("#purchaseGroupBatchModal");
  if (!modal || modal.dataset.mode !== "receive") return;
  const requestId = String(modal.dataset.requestId || "");
  if (!requestId || requestId !== activeRequestId || activeRole !== "admin") return;
  let changed = false;
  modal.querySelectorAll(".group-batch-row[data-line-id]").forEach(row => {
    const eligible = canReceive(linesById.get(row.dataset.lineId));
    const check = row.querySelector(".group-batch-select");
    const qtyInput = row.querySelector(".group-batch-quantity");
    const costInput = row.querySelector(".group-batch-unit-cost");
    if (!check) return;
    if (check.disabled !== !eligible) { check.disabled = !eligible; changed = true; }
    if (!eligible && check.checked) { check.checked = false; changed = true; }
    if (qtyInput && qtyInput.disabled !== !eligible) qtyInput.disabled = !eligible;
    if (costInput && costInput.disabled !== !eligible) costInput.disabled = !eligible;
    if (!eligible) {
      row.classList.add("opacity-50");
      row.title = "Este SKU aún no está en requisición; no puede recibirse.";
    }
  });
  if (changed) {
    // Actualiza el resumen sin volver a activar las casillas no elegibles.
    modal.querySelector(".group-batch-select")?.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function attachGroupObserver() {
  const modal = document.querySelector("#purchaseGroupBatchModal");
  const body = modal?.querySelector("#purchaseGroupBatchBody");
  if (!body || body.dataset.receiptPolicyObserved === "1") return;
  body.dataset.receiptPolicyObserved = "1";
  groupModalObserver?.disconnect();
  groupModalObserver = new MutationObserver(() => restrictGroupModal());
  groupModalObserver.observe(body, { childList: true, subtree: true });
}

const bypass = new WeakSet();
async function guardExistingAction(button, eligibility, message, shouldRefresh = false) {
  // Se valida de nuevo contra Firestore antes de delegar en los handlers originales.
  const requestId = String(button.dataset.requestId || currentId());
  const lineId = String(button.dataset.lineId || "");
  try {
    if (!await isAdmin()) throw new Error("Sólo el Administrador puede ejecutar esta acción.");
    if (lineId) {
      const snap = await getDoc(doc(db, "purchaseRequests", requestId, "items", lineId));
      if (!snap.exists() || !eligibility(snap.data())) throw new Error(message);
    } else if (shouldRefresh) {
      const lines = await fetchLines(requestId);
      if (!lines.some(canCancel) || lines.some(isInRequisition)) throw new Error(message);
    }
    bypass.add(button);
    button.click();
  } catch (error) {
    alert(error.message);
    if (requestId === activeRequestId) reloadDetail(requestId);
  }
}

// Los handlers originales se registran en fase bubble; capturamos antes que ellos.
// Así no existe una ruta desde el botón nativo que salte el estado de requisición.
document.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const launcher = target.closest(`#${LAUNCHER_ID}`);
  if (launcher) { event.preventDefault(); openMassModal(launcher.dataset.requestId); return; }
  const guarded = target.closest(".request-line-receive, .request-line-cancel, .request-line-requisition, #purchaseRequestCancelAll, .request-history-cancel");
  if (!guarded) return;
  if (bypass.has(guarded)) { bypass.delete(guarded); return; }
  event.preventDefault(); event.stopImmediatePropagation();
  const isReceipt = guarded.matches(".request-line-receive");
  const isRequisition = guarded.matches(".request-line-requisition");
  const isCancelLine = guarded.matches(".request-line-cancel");
  if (isReceipt) {
    // Reutilizamos el formulario individual y la transacción validada.
    // No se permite que el handler antiguo registre recepción sin requisición.
    openMassModal(String(guarded.dataset.requestId || currentId()), String(guarded.dataset.lineId || ""));
  }
  else if (isRequisition) guardExistingAction(guarded, canRequisition, "El SKU no está disponible para pasar a requisición.");
  else if (isCancelLine) guardExistingAction(guarded, canCancel, "Sólo se pueden cancelar artículos que permanecen en Compras.");
  else guardExistingAction(guarded, () => true,
    "La solicitud incluye requisiciones. Deshazlas antes de cancelar toda la solicitud.", true);
}, true);

// El formulario de recepción agrupada ya existía, pero su escritura original
// permitía recibir SKU sin requisición. Conservamos el formulario y delegamos
// cada recepción al mismo método transaccional que la recepción masiva.
async function saveGroupedReceipts(modal) {
  if (groupBusy || busy) return;
  const requestId = String(modal.dataset.requestId || "");
  const selected = [...modal.querySelectorAll(".group-batch-row")]
    .filter(row => row.querySelector(".group-batch-select")?.checked);
  if (!requestId || !selected.length) return;
  let selections;
  try {
    if (!await isAdmin()) throw new Error("Sólo el Administrador puede registrar recepciones.");
    selections = selected.map(row => {
      const lineId = String(row.dataset.lineId || "");
      const pending = n(row.dataset.pending);
      const qty = Number(row.querySelector(".group-batch-quantity")?.value);
      const rawCost = String(row.querySelector(".group-batch-unit-cost")?.value ?? "").trim();
      const cost = Number(rawCost);
      if (!canReceive(linesById.get(lineId))) throw new Error(`El SKU ${lineId} no está en requisición.`);
      if (!Number.isSafeInteger(qty) || qty < 1 || qty > pending) throw new Error(`Cantidad inválida para ${lineId}.`);
      if (!rawCost || !Number.isFinite(cost) || cost < 0) throw new Error(`Costo inválido para ${lineId}.`);
      return { lineId, quantity: qty, cost };
    });
  } catch (error) { alert(error.message); restrictGroupModal(); return; }
  if (!confirm(`¿Registrar la recepción de ${selections.reduce((sum, s) => sum + s.quantity, 0)} piezas en ${selections.length} SKU?`)) return;
  groupBusy = true;
  const save = modal.querySelector("#purchaseGroupBatchSave");
  if (save) { save.disabled = true; save.textContent = "Registrando recepciones…"; }
  modal.querySelectorAll(".group-batch-select").forEach(el => { el.disabled = true; });
  let successes = 0;
  const failures = [];
  try {
    for (const selection of selections) {
      try { await receiveLine(requestId, selection.lineId, selection.quantity, selection.cost); successes++; }
      catch (error) { failures.push(`${selection.lineId}: ${error.message}`); }
    }
    if (successes) await recalculateRequest(requestId);
    if (failures.length) {
      alert(`Se registraron ${successes} recepciones, con ${failures.length} errores:\n${failures.slice(0, 10).join("\n")}`);
    } else {
      alert(`${successes} recepciones registradas correctamente.`);
    }
    if (successes && !failures.length) bootstrap.Modal.getOrCreateInstance(modal).hide();
    else if (successes) refreshViews(requestId);
  } catch (error) {
    console.error("Error al concluir recepción agrupada:", error);
    alert(`La recepción agrupada tuvo un problema al actualizar la solicitud: ${error.message}`);
  } finally {
    groupBusy = false;
    if (save) { save.disabled = false; save.textContent = "Registrar recepciones seleccionadas"; }
    // Al existir fallas, el formulario puede seguir abierto para corregir.
    await reloadDetail(requestId);
    restrictGroupModal();
  }
}

document.addEventListener("click", event => {
  if (!event.target?.closest?.("#purchaseGroupBatchSave")) return;
  const modal = document.querySelector("#purchaseGroupBatchModal");
  if (modal?.dataset.mode !== "receive") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  saveGroupedReceipts(modal);
}, true);

document.addEventListener("purchase-request-detail-rendered", event => {
  reloadDetail(String(event.detail?.requestId || currentId()));
});
document.addEventListener("shown.bs.modal", event => {
  if (event.target?.id === "purchaseRequestDetailModal") reloadDetail(currentId());
  if (event.target?.id === "purchaseGroupBatchModal") {
    attachGroupObserver();
    restrictGroupModal();
  }
});
document.addEventListener("click", event => {
  if (event.target?.closest?.(".request-view-mode")) queueMicrotask(decorate);
  if (event.target?.closest?.("#massReceiptSelectAll")) {
    document.querySelectorAll(`#${MODAL_ID} .mass-receipt-check`).forEach(x => { x.checked = true; });
    updateSummary();
  } else if (event.target?.closest?.("#massReceiptClear")) {
    document.querySelectorAll(`#${MODAL_ID} .mass-receipt-check`).forEach(x => { x.checked = false; });
    updateSummary();
  } else if (event.target?.closest?.("#massReceiptSave")) saveMassReceipt();
  if (event.target?.closest?.("#refreshPurchaseRequests")) {
    if (activeRequestId) reloadDetail(activeRequestId);
  }
});
document.addEventListener("change", event => {
  if (event.target?.matches?.(`#${MODAL_ID} input`)) updateSummary();
});
document.addEventListener("input", event => {
  if (event.target?.matches?.(`#${MODAL_ID} .mass-receipt-qty, #${MODAL_ID} .mass-receipt-cost`)) updateSummary();
});

isAdmin().catch(error => console.warn("No se resolvió rol de recepción masiva:", error));
