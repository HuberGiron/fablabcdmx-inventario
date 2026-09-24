import { auth, db } from "./firebase-app.js";
import { getUserProfile } from "./common.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const MODAL_ID = "purchaseGroupBatchModal";
const STYLE_ID = "purchaseGroupBatchStyles";

let currentRole = "";
let currentProfile = null;
let activeRequestId = "";
let reopenDetailAfterBatch = false;
let reopenRequestId = "";
let reopenDelayTimer = null;
let decorationSequence = 0;
const requestLinesCache = new Map();

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("es-MX");
}

function linePendingQty(line) {
  return Math.max(
    num(line?.quantityRequested)
      - num(line?.quantityReceived)
      - num(line?.quantityCancelled),
    0
  );
}

function currentInventory(item) {
  return num(item?.stockAlmacen) + num(item?.stockPrestadoTemporal);
}

function normalizePendingRefs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(ref => ({
      requestId: String(ref?.requestId || ""),
      lineId: String(ref?.lineId || ""),
      folio: String(ref?.folio || ""),
      pendingQty: Math.max(num(ref?.pendingQty), 0),
    }))
    .filter(ref => ref.requestId && ref.lineId && ref.pendingQty > 0);
}

function normalizeRequisitionRefs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(ref => ({
      requestId: String(ref?.requestId || ""),
      lineId: String(ref?.lineId || ""),
      folio: String(ref?.folio || ""),
      requisitionQty: Math.max(num(ref?.requisitionQty), 0),
    }))
    .filter(ref => ref.requestId && ref.lineId && ref.requisitionQty > 0);
}

function pendingPurchaseQty(item) {
  return Math.max(num(item?.purchasePendingQty), 0);
}

function requisitionPurchaseQty(item) {
  return Math.max(num(item?.purchaseRequisitionQty), 0);
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

function areaText(line) {
  const zone = `${line.zoneId || ""}${line.zoneName ? ` · ${line.zoneName}` : ""}`;
  const subzone = `${line.subzoneId || ""}${line.subzoneName ? ` · ${line.subzoneName}` : ""}`;
  const area = `${line.locationCode || line.locationId || ""}${line.locationName ? ` · ${line.locationName}` : ""}`;
  return [zone, subzone, area].filter(Boolean).join(" / ");
}

function canRequisitionLine(line) {
  return (
    linePendingQty(line) > 0
    && line.requisitionStatus !== "requisitioned"
    && num(line.quantityReceived) === 0
    && num(line.quantityCancelled) === 0
  );
}

function canReceiveLine(line) {
  return linePendingQty(line) > 0;
}

async function loadRole() {
  const user = auth.currentUser;
  if (!user) return;
  try {
    currentProfile = await getUserProfile(user.uid);
    currentRole = currentProfile?.appRole || currentProfile?.role || "";
  } catch (error) {
    console.warn("No se pudo resolver el rol para las acciones agrupadas:", error);
  }
}

async function fetchRequestLines(requestId, { force = false } = {}) {
  if (!force && requestLinesCache.has(requestId)) {
    return requestLinesCache.get(requestId);
  }

  const snapshot = await getDocs(
    collection(db, "purchaseRequests", requestId, "items")
  );

  const lines = snapshot.docs.map(lineDoc => ({
    id: lineDoc.id,
    ...lineDoc.data(),
  }));

  requestLinesCache.set(requestId, lines);
  return lines;
}

function requestIdFromDetail() {
  return String(
    document.querySelector("#purchaseRequestDetailPdf")?.dataset?.requestId || ""
  );
}

function groupNameFromCard(card) {
  return String(
    card?.querySelector(".request-line-title")?.textContent || ""
  ).trim();
}

function linesForGroup(lines, name) {
  const key = normalizeName(name);
  return lines.filter(line => normalizeName(line.nombre || line.sku || "") === key);
}

function injectStyles() {
  if (document.querySelector(`#${STYLE_ID}`)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .purchase-group-batch-actions {
      display:flex;
      flex-wrap:wrap;
      align-items:center;
      gap:.55rem;
      margin-top:.85rem;
      padding:.7rem .8rem;
      border:1px solid #dfe3e8;
      border-radius:.65rem;
      background:#f8f9fa;
    }
    .purchase-group-batch-actions .batch-label {
      margin-right:auto;
      color:#6c757d;
      font-size:.82rem;
    }
    #${MODAL_ID} .modal-dialog {
      max-width:1450px;
    }
    .group-batch-table th {
      white-space:nowrap;
      vertical-align:middle;
    }
    .group-batch-table td {
      vertical-align:middle;
    }
    .group-batch-table .group-batch-area {
      min-width:300px;
      max-width:430px;
      white-space:normal;
      line-height:1.25;
    }
    .group-batch-table .group-batch-cost {
      min-width:145px;
    }
    .group-batch-table .group-batch-qty {
      min-width:110px;
    }
    .group-batch-table tr.is-disabled {
      opacity:.52;
    }
    .group-batch-summary {
      display:flex;
      flex-wrap:wrap;
      gap:.6rem 1rem;
      align-items:center;
      padding:.7rem .85rem;
      margin-bottom:.75rem;
      border:1px solid #dee2e6;
      border-radius:.65rem;
      background:#f8f9fa;
    }
    .group-batch-summary strong {
      font-size:1.02rem;
    }
    .group-batch-current-stage {
      display:inline-block;
      padding:.25rem .45rem;
      border-radius:999px;
      font-size:.75rem;
      font-weight:700;
    }
    .group-batch-current-stage.is-requisition {
      background:#cfe2ff;
      color:#084298;
    }
    .group-batch-current-stage.is-purchase {
      background:#fff3cd;
      color:#664d03;
    }
    @media (max-width: 767.98px) {
      .purchase-group-batch-actions .btn {
        flex:1 1 100%;
      }
    }
  `;
  document.head.appendChild(style);
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
          <div>
            <h5 class="modal-title mb-0" id="purchaseGroupBatchTitle">Acción agrupada</h5>
            <div class="small text-muted" id="purchaseGroupBatchSubtitle"></div>
          </div>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button>
        </div>
        <div class="modal-body" id="purchaseGroupBatchBody"></div>
        <div class="modal-footer">
          <div class="me-auto small text-muted" id="purchaseGroupBatchFooterInfo"></div>
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancelar</button>
          <button type="button" class="btn btn-primary" id="purchaseGroupBatchSave">Guardar selección</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);

  modal.addEventListener("hidden.bs.modal", async () => {
    if (!reopenDetailAfterBatch || !reopenRequestId) return;

    const requestId = reopenRequestId;
    reopenDetailAfterBatch = false;
    reopenRequestId = "";

    // Reabrimos "Ver" para que el usuario continúe trabajando en el mismo
    // producto agrupado. El modo agrupado queda guardado por el módulo base.
    const viewButton = document.querySelector(
      `.request-history-view[data-request-id="${CSS.escape(requestId)}"]`
    );

    if (viewButton) {
      viewButton.click();
    }

    // Actualizamos el historial en segundo plano; no bloquea la reapertura.
    window.clearTimeout(reopenDelayTimer);
    reopenDelayTimer = window.setTimeout(() => {
      document.querySelector("#refreshPurchaseRequests")?.click();
    }, 800);
  });

  return modal;
}

function batchRowHtml(line, mode) {
  const pending = linePendingQty(line);
  const eligible = mode === "requisition"
    ? canRequisitionLine(line)
    : canReceiveLine(line);

  const currency = String(line.currency || "MXN").toUpperCase();
  const currentUnitCost = Math.max(
    num(
      line.requisitionStatus === "requisitioned"
        ? (line.requisitionUnitCost ?? line.unitPrice)
        : line.unitPrice
    ),
    0
  );

  const stage = line.requisitionStatus === "requisitioned"
    ? `<span class="group-batch-current-stage is-requisition">En requisición</span>`
    : `<span class="group-batch-current-stage is-purchase">En compras</span>`;

  const reason = !eligible
    ? (
        mode === "requisition"
          ? (line.requisitionStatus === "requisitioned"
              ? "Ya tiene requisición"
              : (num(line.quantityReceived) > 0 || num(line.quantityCancelled) > 0
                  ? "Ya tiene movimientos parciales"
                  : "Sin pendiente"))
          : "Sin pendiente"
      )
    : "";

  return `
    <tr class="group-batch-row ${eligible ? "" : "is-disabled"}"
        data-line-id="${escapeHtml(line.id)}"
        data-pending="${pending}"
        data-currency="${escapeHtml(currency)}">
      <td>
        <input class="form-check-input group-batch-select"
               type="checkbox"
               ${eligible ? "" : "disabled"}
               aria-label="Seleccionar ${escapeHtml(line.sku || line.nombre || line.id)}">
      </td>
      <td>
        <strong>${escapeHtml(line.sku || "")}</strong>
        <div class="small text-muted">${stage}</div>
      </td>
      <td class="group-batch-area">
        ${escapeHtml(areaText(line))}
      </td>
      <td class="text-end">${num(line.quantityRequested)}</td>
      <td class="text-end">${num(line.quantityReceived)}</td>
      <td class="text-end"><strong>${pending}</strong></td>
      ${
        mode === "receive"
          ? `<td class="group-batch-qty">
              <input class="form-control form-control-sm group-batch-quantity"
                     type="number"
                     min="1"
                     max="${pending}"
                     step="1"
                     value="${pending}"
                     ${eligible ? "" : "disabled"}>
            </td>`
          : `<td class="text-end"><strong>${pending}</strong></td>`
      }
      <td class="group-batch-cost">
        <div class="input-group input-group-sm">
          <span class="input-group-text">$</span>
          <input class="form-control group-batch-unit-cost"
                 type="number"
                 min="0"
                 step="0.01"
                 value="${currentUnitCost}"
                 ${eligible && currentRole === "admin" ? "" : "disabled"}>
        </div>
        <div class="small text-muted mt-1">${escapeHtml(currency)}${currentRole !== "admin" ? " · sólo Admin ajusta costo" : ""}</div>
      </td>
      <td>
        ${
          reason
            ? `<span class="small text-muted">${escapeHtml(reason)}</span>`
            : `<span class="small text-muted">${mode === "requisition" ? "Se registra completa" : "Puedes recibir parcial o total"}</span>`
        }
      </td>
    </tr>`;
}

function modalBodyHtml(groupName, lines, mode) {
  const eligible = lines.filter(line =>
    mode === "requisition"
      ? canRequisitionLine(line)
      : canReceiveLine(line)
  );

  return `
    <div class="group-batch-summary">
      <span><strong>${escapeHtml(groupName)}</strong></span>
      <span>${lines.length} SKU / áreas en el grupo</span>
      <span>${eligible.length} disponibles para esta operación</span>
      <button type="button" class="btn btn-outline-dark btn-sm ms-auto" id="purchaseGroupBatchSelectAll">
        Seleccionar disponibles
      </button>
      <button type="button" class="btn btn-outline-secondary btn-sm" id="purchaseGroupBatchClear">
        Limpiar selección
      </button>
    </div>

    <div class="alert alert-light border py-2 small">
      ${
        mode === "requisition"
          ? "Marca los SKU que quieres enviar completos a requisición. La cantidad de cada SKU es fija; sólo el Administrador puede ajustar el costo unitario oficial."
          : "Marca los SKU que llegaron. Para cada uno puedes indicar una recepción parcial o total; el Administrador puede capturar el costo unitario final."
      }
    </div>

    <div class="table-responsive">
      <table class="table table-sm group-batch-table align-middle">
        <thead>
          <tr>
            <th></th>
            <th>SKU</th>
            <th>Zona / Subzona / Área</th>
            <th class="text-end">Solicitado</th>
            <th class="text-end">Recibido</th>
            <th class="text-end">Pendiente</th>
            <th>${mode === "requisition" ? "A requisición" : "Llegaron"}</th>
            <th>Costo unitario ${mode === "requisition" ? "oficial" : "final"}</th>
            <th>Observación</th>
          </tr>
        </thead>
        <tbody>
          ${lines.map(line => batchRowHtml(line, mode)).join("")}
        </tbody>
      </table>
    </div>`;
}

function selectedRows(modalEl) {
  return [...modalEl.querySelectorAll(".group-batch-row")]
    .filter(row => row.querySelector(".group-batch-select")?.checked);
}

function updateModalSelectionSummary() {
  const modalEl = document.querySelector(`#${MODAL_ID}`);
  if (!modalEl) return;

  const mode = modalEl.dataset.mode;
  const rows = selectedRows(modalEl);
  let pieces = 0;
  const totals = new Map();

  rows.forEach(row => {
    const currency = row.dataset.currency || "MXN";
    const qty = mode === "receive"
      ? num(row.querySelector(".group-batch-quantity")?.value)
      : num(row.dataset.pending);
    const cost = num(row.querySelector(".group-batch-unit-cost")?.value);

    pieces += qty;
    totals.set(currency, num(totals.get(currency)) + qty * cost);
  });

  const money = [...totals.entries()]
    .map(([currency, amount]) => formatCurrencyWithCode(amount, currency))
    .join(" · ");

  const footer = modalEl.querySelector("#purchaseGroupBatchFooterInfo");
  if (footer) {
    footer.textContent = rows.length
      ? `${rows.length} SKU seleccionados · ${pieces} piezas${money ? ` · ${money}` : ""}`
      : "No hay SKU seleccionados.";
  }

  modalEl.querySelector("#purchaseGroupBatchSave").disabled = rows.length === 0;
}

async function openBatchModal(requestId, groupName, mode) {
  await loadRole();

  const lines = linesForGroup(
    await fetchRequestLines(requestId, { force: true }),
    groupName
  );

  if (!lines.length) {
    alert("No se encontraron líneas para este producto agrupado.");
    return;
  }

  const eligible = lines.filter(line =>
    mode === "requisition"
      ? canRequisitionLine(line)
      : canReceiveLine(line)
  );

  if (!eligible.length) {
    alert(
      mode === "requisition"
        ? "Ningún SKU de este grupo está disponible para registrar requisición."
        : "Ningún SKU de este grupo tiene piezas pendientes por recibir."
    );
    return;
  }

  const modalEl = ensureModal();
  modalEl.dataset.requestId = requestId;
  modalEl.dataset.groupName = groupName;
  modalEl.dataset.mode = mode;

  modalEl.querySelector("#purchaseGroupBatchTitle").textContent =
    mode === "requisition"
      ? "Registrar requisiciones del producto agrupado"
      : "Registrar recepciones del producto agrupado";

  modalEl.querySelector("#purchaseGroupBatchSubtitle").textContent =
    groupName;

  modalEl.querySelector("#purchaseGroupBatchBody").innerHTML =
    modalBodyHtml(groupName, lines, mode);

  const save = modalEl.querySelector("#purchaseGroupBatchSave");
  save.textContent =
    mode === "requisition"
      ? "Registrar requisiciones seleccionadas"
      : "Registrar recepciones seleccionadas";
  save.className =
    mode === "requisition"
      ? "btn btn-primary"
      : "btn btn-success";

  updateModalSelectionSummary();

  // Bootstrap no maneja bien dos modales activos. Cerramos temporalmente
  // "Ver solicitud" y lo restauramos al terminar/cancelar esta captura.
  const detailModal = document.querySelector("#purchaseRequestDetailModal");
  const showBatch = () => {
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
  };

  if (detailModal?.classList.contains("show")) {
    reopenDetailAfterBatch = true;
    reopenRequestId = requestId;

    const detailInstance = bootstrap.Modal.getOrCreateInstance(detailModal);
    const onHidden = () => {
      detailModal.removeEventListener("hidden.bs.modal", onHidden);
      showBatch();
    };
    detailModal.addEventListener("hidden.bs.modal", onHidden);
    detailInstance.hide();
  } else {
    reopenDetailAfterBatch = false;
    reopenRequestId = "";
    showBatch();
  }
}

async function applyRequisitionLine(requestId, lineId, officialUnitCost) {
  const lineRef = doc(db, "purchaseRequests", requestId, "items", lineId);
  const requestRef = doc(db, "purchaseRequests", requestId);

  await runTransaction(db, async transaction => {
    const lineSnap = await transaction.get(lineRef);
    if (!lineSnap.exists()) throw new Error("La línea ya no existe.");

    const line = { id: lineSnap.id, ...lineSnap.data() };

    if (!canRequisitionLine(line)) {
      throw new Error(`${line.sku || line.nombre}: ya no está disponible para requisición completa.`);
    }

    const itemRef = doc(db, "items", String(line.itemId || lineId));
    const itemSnap = await transaction.get(itemRef);
    if (!itemSnap.exists()) throw new Error(`${line.sku || line.nombre}: el item asociado ya no existe.`);

    const requestSnap = await transaction.get(requestRef);
    if (!requestSnap.exists()) throw new Error("La solicitud ya no existe.");

    const item = { id: itemSnap.id, ...itemSnap.data() };
    const request = requestSnap.data();
    const qty = linePendingQty(line);
    const expectedUnitCost = Math.max(num(line.unitPrice), 0);
    const unitCost = currentRole === "admin"
      ? Math.max(num(officialUnitCost), 0)
      : expectedUnitCost;

    const refs = normalizeRequisitionRefs(item.purchaseRequisitionRefs)
      .filter(ref => !(
        ref.requestId === requestId
        && ref.lineId === String(line.itemId || lineId)
      ));

    refs.push({
      requestId,
      lineId: String(line.itemId || lineId),
      folio: String(request.folio || requestId),
      requisitionQty: qty,
    });

    transaction.update(itemRef, {
      purchaseRequisitionQty: requisitionPurchaseQty(item) + qty,
      purchaseRequisitionRefs: refs,
      updatedAt: serverTimestamp(),
    });

    const lineUpdate = {
      requisitionStatus: "requisitioned",
      requisitionedAt: serverTimestamp(),
      requisitionedBy: auth.currentUser?.uid || "",
      requisitionedByName:
        currentProfile?.nombre
        || auth.currentUser?.email
        || "",
      requisitionUnitCost: unitCost,
      updatedAt: serverTimestamp(),
    };

    if (
      currentRole === "admin"
      && Math.abs(unitCost - expectedUnitCost) > 0.005
    ) {
      lineUpdate.originalUnitPrice =
        Object.prototype.hasOwnProperty.call(line, "originalUnitPrice")
          ? num(line.originalUnitPrice)
          : expectedUnitCost;
      lineUpdate.unitPrice = unitCost;
    }

    transaction.update(lineRef, lineUpdate);
    transaction.update(requestRef, {
      updatedAt: serverTimestamp(),
    });
  });
}

async function applyReceiptLine(requestId, lineId, quantity, finalUnitCost) {
  const qty = Math.max(num(quantity), 0);
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error("La cantidad recibida debe ser un entero mayor a cero.");
  }

  const lineRef = doc(db, "purchaseRequests", requestId, "items", lineId);
  const requestRef = doc(db, "purchaseRequests", requestId);

  await runTransaction(db, async transaction => {
    const lineSnap = await transaction.get(lineRef);
    if (!lineSnap.exists()) throw new Error("La línea ya no existe.");

    const line = { id: lineSnap.id, ...lineSnap.data() };
    const remaining = linePendingQty(line);

    if (qty > remaining) {
      throw new Error(`${line.sku || line.nombre}: sólo quedan ${remaining} piezas pendientes.`);
    }

    const itemRef = doc(db, "items", String(line.itemId || lineId));
    const itemSnap = await transaction.get(itemRef);
    if (!itemSnap.exists()) throw new Error(`${line.sku || line.nombre}: el item asociado ya no existe.`);

    const item = { id: itemSnap.id, ...itemSnap.data() };
    const expectedUnitCost = Math.max(num(line.unitPrice), 0);
    const actualUnitCost = currentRole === "admin"
      ? Math.max(num(finalUnitCost), 0)
      : expectedUnitCost;

    const oldReceived = num(line.quantityReceived);
    const oldCancelled = num(line.quantityCancelled);
    const previousActualTotal =
      Object.prototype.hasOwnProperty.call(line, "actualCostTotal")
        ? num(line.actualCostTotal)
        : oldReceived * expectedUnitCost;

    const newReceived = oldReceived + qty;
    const newRemaining = Math.max(
      num(line.quantityRequested) - newReceived - oldCancelled,
      0
    );

    const newLineStatus = newRemaining > 0
      ? "partial"
      : (newReceived > 0 ? "received" : "cancelled");

    const pendingRefs = normalizePendingRefs(item.purchasePendingRefs)
      .map(ref => {
        if (
          ref.requestId !== requestId
          || ref.lineId !== String(line.itemId || lineId)
        ) {
          return ref;
        }

        return {
          ...ref,
          pendingQty: Math.max(ref.pendingQty - qty, 0),
        };
      })
      .filter(ref => ref.pendingQty > 0);

    const itemUpdate = {
      purchasePendingQty: Math.max(pendingPurchaseQty(item) - qty, 0),
      purchasePendingRefs: pendingRefs,
      stockAlmacen: num(item.stockAlmacen) + qty,
      updatedAt: serverTimestamp(),
    };

    if (line.requisitionStatus === "requisitioned") {
      const requisitionRefs = normalizeRequisitionRefs(item.purchaseRequisitionRefs)
        .map(ref => {
          if (
            ref.requestId !== requestId
            || ref.lineId !== String(line.itemId || lineId)
          ) {
            return ref;
          }

          return {
            ...ref,
            requisitionQty: Math.max(ref.requisitionQty - qty, 0),
          };
        })
        .filter(ref => ref.requisitionQty > 0);

      itemUpdate.purchaseRequisitionQty =
        Math.max(requisitionPurchaseQty(item) - qty, 0);

      itemUpdate.purchaseRequisitionRefs =
        requisitionRefs;
    }

    transaction.update(itemRef, itemUpdate);

    transaction.update(lineRef, {
      quantityReceived: newReceived,
      quantityCancelled: oldCancelled,
      status: newLineStatus,
      updatedAt: serverTimestamp(),
      lastReceivedAt: serverTimestamp(),
      lastActualCostAt: serverTimestamp(),
      lastActualUnitCost: actualUnitCost,
      actualCostTotal: previousActualTotal + qty * actualUnitCost,
    });

    transaction.update(requestRef, {
      updatedAt: serverTimestamp(),
    });
  });
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

  if (pending > 0 && (received > 0 || cancelled > 0)) return "partial";
  if (pending > 0) return "sent";
  if (received > 0) return "completed";
  return "cancelled";
}

function totalsForLines(lines) {
  const totals = {};
  let quantity = 0;

  for (const line of lines) {
    const currency = String(line.currency || "MXN").toUpperCase();
    const qty = Math.max(num(line.quantityRequested), 0);
    quantity += qty;
    totals[currency] = num(totals[currency]) + qty * Math.max(num(line.unitPrice), 0);
  }

  return { totals, quantity };
}

async function refreshRequestAggregate(requestId) {
  const lines = await fetchRequestLines(requestId, { force: true });
  const status = calculateRequestStatus(lines);
  const { totals, quantity } = totalsForLines(lines);

  await updateDoc(doc(db, "purchaseRequests", requestId), {
    status,
    itemCount: lines.length,
    totalQty: quantity,
    totalsByCurrency: totals,
    updatedAt: serverTimestamp(),
  });

  requestLinesCache.set(requestId, lines);
}

async function saveBatchSelection() {
  const modalEl = document.querySelector(`#${MODAL_ID}`);
  if (!modalEl) return;

  const requestId = String(modalEl.dataset.requestId || "");
  const mode = String(modalEl.dataset.mode || "");
  const rows = selectedRows(modalEl);

  if (!requestId || !["requisition", "receive"].includes(mode)) return;
  if (!rows.length) {
    alert("Selecciona al menos un SKU.");
    return;
  }

  const save = modalEl.querySelector("#purchaseGroupBatchSave");
  const cancel = modalEl.querySelector('[data-bs-dismiss="modal"]');

  save.disabled = true;
  if (cancel) cancel.disabled = true;

  const selections = [];

  try {
    rows.forEach(row => {
      const lineId = String(row.dataset.lineId || "");
      const pending = num(row.dataset.pending);
      const unitCost = num(row.querySelector(".group-batch-unit-cost")?.value);

      if (!lineId) throw new Error("Hay una línea sin identificador.");

      if (!Number.isFinite(unitCost) || unitCost < 0) {
        throw new Error("Todos los costos deben ser mayores o iguales a cero.");
      }

      if (mode === "requisition") {
        selections.push({
          lineId,
          quantity: pending,
          unitCost,
        });
      } else {
        const quantity = Number(
          row.querySelector(".group-batch-quantity")?.value
        );

        if (
          !Number.isFinite(quantity)
          || !Number.isInteger(quantity)
          || quantity < 1
          || quantity > pending
        ) {
          throw new Error(
            `La cantidad recibida debe ser un entero entre 1 y ${pending}.`
          );
        }

        selections.push({
          lineId,
          quantity,
          unitCost,
        });
      }
    });

    const question = mode === "requisition"
      ? `¿Registrar requisición para ${selections.length} SKU seleccionados?`
      : `¿Registrar la recepción de ${selections.length} SKU seleccionados?`;

    if (!confirm(question)) {
      save.disabled = false;
      if (cancel) cancel.disabled = false;
      return;
    }

    let completed = 0;

    for (const selection of selections) {
      if (mode === "requisition") {
        await applyRequisitionLine(
          requestId,
          selection.lineId,
          selection.unitCost
        );
      } else {
        await applyReceiptLine(
          requestId,
          selection.lineId,
          selection.quantity,
          selection.unitCost
        );
      }
      completed += 1;
    }

    await refreshRequestAggregate(requestId);
    requestLinesCache.delete(requestId);

    alert(
      mode === "requisition"
        ? `${completed} requisición${completed === 1 ? "" : "es"} registrada${completed === 1 ? "" : "s"} correctamente.`
        : `${completed} recepción${completed === 1 ? "" : "es"} registrada${completed === 1 ? "" : "s"} correctamente.`
    );

    bootstrap.Modal.getOrCreateInstance(modalEl).hide();
  } catch (error) {
    console.error("Error en la operación agrupada:", error);
    alert(`No se pudo completar la operación: ${error.message}`);
    save.disabled = false;
    if (cancel) cancel.disabled = false;
  }
}

async function decorateGroupedCards() {
  const requestId = requestIdFromDetail();
  const content = document.querySelector("#requestGroupingContent");

  if (!requestId || !content) return;

  const groupedCards = [...content.querySelectorAll(".grouped-request-card")];
  if (!groupedCards.length) return;

  const sequence = ++decorationSequence;
  const lines = await fetchRequestLines(requestId, { force: true });
  if (sequence !== decorationSequence) return;

  for (const card of groupedCards) {
    if (card.querySelector(".purchase-group-batch-actions")) continue;

    const groupName = groupNameFromCard(card);
    if (!groupName) continue;

    const groupLines = linesForGroup(lines, groupName);
    if (!groupLines.length) continue;

    const requisitionCount =
      groupLines.filter(canRequisitionLine).length;

    const receiveCount =
      groupLines.filter(canReceiveLine).length;

    if (!requisitionCount && !receiveCount) continue;

    const actions = document.createElement("div");
    actions.className = "purchase-group-batch-actions";

    actions.innerHTML = `
      <span class="batch-label">
        Acciones rápidas para todos los SKU de este producto:
      </span>

      ${
        requisitionCount
          ? `<button type="button"
                     class="btn btn-primary btn-sm group-batch-requisition"
                     data-request-id="${escapeHtml(requestId)}"
                     data-group-name="${escapeHtml(groupName)}">
               Registrar requisición (${requisitionCount})
             </button>`
          : ""
      }

      ${
        receiveCount
          ? `<button type="button"
                     class="btn btn-success btn-sm group-batch-receive"
                     data-request-id="${escapeHtml(requestId)}"
                     data-group-name="${escapeHtml(groupName)}">
               Registrar recepción (${receiveCount})
             </button>`
          : ""
      }`;

    const breakdown =
      [...card.querySelectorAll(".mt-3")]
        .find(node =>
          node.textContent.includes("Desglose por SKU")
        );

    if (breakdown) {
      card.insertBefore(actions, breakdown);
    } else {
      card.appendChild(actions);
    }
  }
}

function scheduleDecoration() {
  window.setTimeout(() => {
    decorateGroupedCards().catch(error => {
      console.error("No se pudieron agregar acciones agrupadas:", error);
    });
  }, 0);
}

function observeGroupedContent() {
  const content = document.querySelector("#requestGroupingContent");
  if (!content || content.dataset.batchObserver === "1") return;

  content.dataset.batchObserver = "1";

  const observer = new MutationObserver(mutations => {
    const directChange = mutations.some(
      mutation =>
        mutation.type === "childList"
        && (
          mutation.addedNodes.length > 0
          || mutation.removedNodes.length > 0
        )
    );

    if (directChange) scheduleDecoration();
  });

  // Sólo hijos directos: insertar nuestra barra dentro de una tarjeta
  // NO vuelve a disparar este observer.
  observer.observe(content, {
    childList: true,
    subtree: false,
  });

  scheduleDecoration();
}

function bindEvents() {
  document.addEventListener("purchase-request-detail-rendered", () => {
    activeRequestId = requestIdFromDetail();
    window.setTimeout(() => {
      observeGroupedContent();
      scheduleDecoration();
    }, 0);
  });

  document.addEventListener("shown.bs.modal", event => {
    if (event.target?.id !== "purchaseRequestDetailModal") return;
    activeRequestId = requestIdFromDetail();
    observeGroupedContent();
    scheduleDecoration();
  });

  document.addEventListener("click", async event => {
    const viewMode = event.target.closest(".request-view-mode");
    if (viewMode) {
      window.setTimeout(() => {
        observeGroupedContent();
        scheduleDecoration();
      }, 0);
      return;
    }

    const requisition = event.target.closest(".group-batch-requisition");
    if (requisition) {
      await openBatchModal(
        requisition.dataset.requestId,
        requisition.dataset.groupName,
        "requisition"
      );
      return;
    }

    const receive = event.target.closest(".group-batch-receive");
    if (receive) {
      await openBatchModal(
        receive.dataset.requestId,
        receive.dataset.groupName,
        "receive"
      );
      return;
    }

    if (event.target.closest("#purchaseGroupBatchSelectAll")) {
      document
        .querySelectorAll(`#${MODAL_ID} .group-batch-select:not(:disabled)`)
        .forEach(check => {
          check.checked = true;
        });
      updateModalSelectionSummary();
      return;
    }

    if (event.target.closest("#purchaseGroupBatchClear")) {
      document
        .querySelectorAll(`#${MODAL_ID} .group-batch-select`)
        .forEach(check => {
          check.checked = false;
        });
      updateModalSelectionSummary();
      return;
    }

    if (event.target.closest("#purchaseGroupBatchSave")) {
      await saveBatchSelection();
    }
  });

  document.addEventListener("change", event => {
    if (
      event.target.matches(`#${MODAL_ID} .group-batch-select`)
      || event.target.matches(`#${MODAL_ID} .group-batch-quantity`)
      || event.target.matches(`#${MODAL_ID} .group-batch-unit-cost`)
    ) {
      updateModalSelectionSummary();
    }
  });

  document.addEventListener("input", event => {
    if (
      event.target.matches(`#${MODAL_ID} .group-batch-quantity`)
      || event.target.matches(`#${MODAL_ID} .group-batch-unit-cost`)
    ) {
      updateModalSelectionSummary();
    }
  });
}

injectStyles();
ensureModal();
loadRole();
bindEvents();
