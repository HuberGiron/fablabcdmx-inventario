import { db } from "./firebase-app.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const REQUEST_STATUS_DRAFT = "draft";
const REQUEST_STATUS_CANCELLED = "cancelled";
const REPORT_BUTTON_ID = "purchaseGlobalProgressReport";
const GLOBAL_MODAL_ID = "purchaseGlobalProgressModal";
const DETAIL_SUMMARY_ID = "purchaseRequestProgressSummary";

let globalReportBusy = false;
let managerAttachTimer = null;

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

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function percent(part, total) {
  const denominator = num(total);
  if (denominator <= 0) return 0;
  return clampPercent((num(part) / denominator) * 100);
}

function percentText(part, total) {
  return `${percent(part, total).toLocaleString("es-MX", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })}%`;
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

function timestampToDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateText(value) {
  const date = timestampToDate(value);
  return date
    ? date.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" })
    : "";
}

function requestStatusLabel(status) {
  const labels = {
    draft: "Borrador",
    sent: "Enviada",
    partial: "Parcial",
    completed: "Completa",
    cancelled: "Cancelada",
  };
  return labels[String(status || "")] || String(status || "Sin estado");
}

function linePendingQty(line) {
  return Math.max(
    num(line?.quantityRequested) -
      num(line?.quantityReceived) -
      num(line?.quantityCancelled),
    0
  );
}

function lineActiveQty(line) {
  return Math.max(num(line?.quantityRequested) - num(line?.quantityCancelled), 0);
}

function lineActualSpent(line) {
  if (Object.prototype.hasOwnProperty.call(line || {}, "actualCostTotal")) {
    return Math.max(num(line.actualCostTotal), 0);
  }
  return Math.max(num(line?.quantityReceived) * num(line?.unitPrice), 0);
}

function lineCurrentUnitCost(line) {
  if (line?.requisitionStatus === "requisitioned") {
    return Math.max(num(line?.requisitionUnitCost ?? line?.unitPrice), 0);
  }
  return Math.max(num(line?.unitPrice), 0);
}

function lineProjectedAmount(line) {
  return lineActualSpent(line) + linePendingQty(line) * lineCurrentUnitCost(line);
}

function lineRequisitionAmount(line) {
  if (line?.requisitionStatus !== "requisitioned") return 0;
  return linePendingQty(line) * lineCurrentUnitCost(line);
}

function createMoneyMap() {
  return new Map();
}

function addMoney(map, currency, amount) {
  const code = String(currency || "MXN").toUpperCase();
  map.set(code, num(map.get(code)) + num(amount));
}

function moneyMapEntries(map) {
  return [...map.entries()].filter(([, amount]) => Math.abs(num(amount)) > 0.0001);
}

function moneyMapText(map, fallbackCurrency = "MXN") {
  const entries = moneyMapEntries(map);
  if (!entries.length) return formatCurrencyWithCode(0, fallbackCurrency);
  return entries
    .map(([currency, amount]) => formatCurrencyWithCode(amount, currency))
    .join(" · ");
}

function singleCurrencyValue(map) {
  const entries = moneyMapEntries(map);
  if (entries.length !== 1) return null;
  return { currency: entries[0][0], amount: num(entries[0][1]) };
}

function moneyPercentText(partMap, totalMap) {
  const part = singleCurrencyValue(partMap);
  const total = singleCurrencyValue(totalMap);
  if (!part && !moneyMapEntries(partMap).length) {
    if (total) return "0%";
    return "—";
  }
  if (!part || !total || part.currency !== total.currency || total.amount <= 0) return "—";
  return percentText(part.amount, total.amount);
}

function mergeMoney(target, source) {
  for (const [currency, amount] of source.entries()) addMoney(target, currency, amount);
}

function summarizeLines(lines) {
  const summary = {
    totalProducts: 0,
    requisitionProducts: 0,
    receivedProducts: 0,
    partialReceivedProducts: 0,
    totalPieces: 0,
    requisitionPieces: 0,
    receivedPieces: 0,
    totalAmount: createMoneyMap(),
    requisitionAmount: createMoneyMap(),
    receivedAmount: createMoneyMap(),
    cancelledPieces: 0,
    cancelledProducts: 0,
  };

  for (const line of lines || []) {
    const requested = Math.max(num(line.quantityRequested), 0);
    const received = Math.max(num(line.quantityReceived), 0);
    const cancelled = Math.max(num(line.quantityCancelled), 0);
    const pending = linePendingQty(line);
    const activeQty = lineActiveQty(line);
    const currency = String(line.currency || "MXN").toUpperCase();
    const requisitionActive = line.requisitionStatus === "requisitioned" && pending > 0;

    summary.cancelledPieces += cancelled;
    if (requested > 0 && activeQty <= 0 && cancelled >= requested) summary.cancelledProducts += 1;

    // Base vigente: lo recibido + lo que sigue pendiente. Lo cancelado no forma parte del avance.
    if (activeQty > 0) {
      summary.totalProducts += 1;
      summary.totalPieces += activeQty;
      addMoney(summary.totalAmount, currency, lineProjectedAmount(line));
    }

    if (requisitionActive) {
      summary.requisitionProducts += 1;
      summary.requisitionPieces += pending;
      addMoney(summary.requisitionAmount, currency, lineRequisitionAmount(line));
    }

    if (received > 0) {
      // Para productos, "recibido" significa que el producto ya tiene al menos una recepción.
      summary.receivedProducts += 1;
      summary.receivedPieces += received;
      addMoney(summary.receivedAmount, currency, lineActualSpent(line));
      if (pending > 0) summary.partialReceivedProducts += 1;
    }
  }

  return summary;
}

function metricBar(value, total, tone = "primary") {
  const pct = percent(value, total);
  return `
    <div class="progress request-progress-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-bar bg-${tone}" style="width:${pct}%"></div>
    </div>`;
}

function amountMetricBar(partMap, totalMap, tone = "primary") {
  const part = singleCurrencyValue(partMap);
  const total = singleCurrencyValue(totalMap);
  if (!part || !total || part.currency !== total.currency || total.amount <= 0) {
    return `<div class="progress request-progress-bar"><div class="progress-bar bg-${tone}" style="width:0%"></div></div>`;
  }
  return metricBar(part.amount, total.amount, tone);
}

function summaryBlockHtml(summary, { compact = false } = {}) {
  const productReqPct = percentText(summary.requisitionProducts, summary.totalProducts);
  const productRecvPct = percentText(summary.receivedProducts, summary.totalProducts);
  const pieceReqPct = percentText(summary.requisitionPieces, summary.totalPieces);
  const pieceRecvPct = percentText(summary.receivedPieces, summary.totalPieces);
  const amountReqPct = moneyPercentText(summary.requisitionAmount, summary.totalAmount);
  const amountRecvPct = moneyPercentText(summary.receivedAmount, summary.totalAmount);

  return `
    <div class="request-progress-overview ${compact ? "is-compact" : ""}">
      <div class="request-progress-total-row">
        <div class="request-progress-total-card">
          <span>Monto vigente</span>
          <strong>${escapeHtml(moneyMapText(summary.totalAmount))}</strong>
          <small>Excluye cantidades canceladas</small>
        </div>
        <div class="request-progress-total-card">
          <span>Productos vigentes</span>
          <strong>${summary.totalProducts}</strong>
          <small>${summary.cancelledProducts ? `${summary.cancelledProducts} cancelado${summary.cancelledProducts === 1 ? "" : "s"}` : "Sin productos totalmente cancelados"}</small>
        </div>
        <div class="request-progress-total-card">
          <span>Piezas vigentes</span>
          <strong>${summary.totalPieces}</strong>
          <small>${summary.cancelledPieces ? `${summary.cancelledPieces} pieza${summary.cancelledPieces === 1 ? "" : "s"} cancelada${summary.cancelledPieces === 1 ? "" : "s"}` : "Sin piezas canceladas"}</small>
        </div>
      </div>

      <div class="request-progress-section">
        <div class="request-progress-section-title">Productos / artículos</div>
        <div class="request-progress-grid">
          <div class="request-progress-card requisition">
            <div class="request-progress-card-head">
              <span>En requisición</span>
              <strong>${summary.requisitionProducts} / ${summary.totalProducts}</strong>
            </div>
            <div class="request-progress-money">${escapeHtml(moneyMapText(summary.requisitionAmount))}</div>
            ${metricBar(summary.requisitionProducts, summary.totalProducts, "primary")}
            <div class="request-progress-percent">${productReqPct} de los productos · ${amountReqPct} del monto</div>
          </div>
          <div class="request-progress-card received">
            <div class="request-progress-card-head">
              <span>Con recepción</span>
              <strong>${summary.receivedProducts} / ${summary.totalProducts}</strong>
            </div>
            <div class="request-progress-money">${escapeHtml(moneyMapText(summary.receivedAmount))}</div>
            ${metricBar(summary.receivedProducts, summary.totalProducts, "success")}
            <div class="request-progress-percent">${productRecvPct} de los productos · ${amountRecvPct} del monto</div>
            ${summary.partialReceivedProducts ? `<div class="request-progress-note">${summary.partialReceivedProducts} producto${summary.partialReceivedProducts === 1 ? "" : "s"} con recepción parcial y piezas aún pendientes.</div>` : ""}
          </div>
        </div>
      </div>

      <div class="request-progress-section">
        <div class="request-progress-section-title">Piezas</div>
        <div class="request-progress-grid">
          <div class="request-progress-card requisition">
            <div class="request-progress-card-head">
              <span>En requisición</span>
              <strong>${summary.requisitionPieces} / ${summary.totalPieces}</strong>
            </div>
            <div class="request-progress-money">${escapeHtml(moneyMapText(summary.requisitionAmount))}</div>
            ${metricBar(summary.requisitionPieces, summary.totalPieces, "primary")}
            <div class="request-progress-percent">${pieceReqPct} de las piezas · ${amountReqPct} del monto</div>
          </div>
          <div class="request-progress-card received">
            <div class="request-progress-card-head">
              <span>Recibidas</span>
              <strong>${summary.receivedPieces} / ${summary.totalPieces}</strong>
            </div>
            <div class="request-progress-money">${escapeHtml(moneyMapText(summary.receivedAmount))}</div>
            ${metricBar(summary.receivedPieces, summary.totalPieces, "success")}
            <div class="request-progress-percent">${pieceRecvPct} de las piezas · ${amountRecvPct} del monto</div>
          </div>
        </div>
      </div>
    </div>`;
}

function injectStyles() {
  if (document.querySelector("#purchaseRequestProgressStyles")) return;
  const style = document.createElement("style");
  style.id = "purchaseRequestProgressStyles";
  style.textContent = `
    #${DETAIL_SUMMARY_ID} { padding: 1rem 1rem 0; border-bottom: 1px solid #eef0f2; }
    .request-progress-shell { border:1px solid #dfe3e8; border-radius:.85rem; background:#f8f9fa; padding:1rem; margin-bottom:1rem; }
    .request-progress-heading { display:flex; flex-wrap:wrap; justify-content:space-between; gap:.5rem 1rem; align-items:center; margin-bottom:.8rem; }
    .request-progress-heading h6 { margin:0; font-weight:700; }
    .request-progress-heading .small { color:#6c757d; }
    .request-progress-total-row { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.65rem; margin-bottom:.9rem; }
    .request-progress-total-card { background:#fff; border:1px solid #dee2e6; border-radius:.65rem; padding:.7rem .8rem; }
    .request-progress-total-card span { display:block; color:#6c757d; font-size:.75rem; font-weight:700; text-transform:uppercase; }
    .request-progress-total-card strong { display:block; font-size:1.12rem; margin-top:.15rem; }
    .request-progress-total-card small { display:block; color:#6c757d; margin-top:.15rem; }
    .request-progress-section + .request-progress-section { margin-top:.8rem; }
    .request-progress-section-title { font-weight:700; margin-bottom:.45rem; }
    .request-progress-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.65rem; }
    .request-progress-card { background:#fff; border:1px solid #dee2e6; border-radius:.65rem; padding:.7rem .8rem; }
    .request-progress-card.requisition { border-left:5px solid #0d6efd; }
    .request-progress-card.received { border-left:5px solid #198754; }
    .request-progress-card-head { display:flex; justify-content:space-between; gap:.75rem; align-items:baseline; }
    .request-progress-card-head span { font-weight:700; }
    .request-progress-money { font-size:.9rem; margin:.25rem 0 .35rem; }
    .request-progress-percent { color:#6c757d; font-size:.78rem; margin-top:.3rem; }
    .request-progress-note { color:#6c757d; font-size:.75rem; margin-top:.3rem; }
    .request-progress-bar { height:.42rem; background:#e9ecef; }
    .global-request-share { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.35rem; min-width:260px; }
    .global-request-share > div { border:1px solid #e5e7ea; border-radius:.5rem; padding:.35rem .45rem; background:#fff; }
    .global-request-share span { display:block; color:#6c757d; font-size:.68rem; text-transform:uppercase; font-weight:700; }
    .global-request-share strong { font-size:.84rem; }
    .global-progress-table th { white-space:nowrap; vertical-align:middle; }
    .global-progress-table td { vertical-align:middle; }
    .global-progress-stage { min-width:190px; }
    .global-progress-stage .stage-title { font-weight:700; }
    .global-progress-stage .stage-meta { font-size:.78rem; color:#6c757d; }
    .global-report-intro { color:#6c757d; font-size:.88rem; }
    #${GLOBAL_MODAL_ID} .modal-dialog { max-width: 1500px; }
    @media (max-width: 991.98px) {
      .request-progress-total-row, .request-progress-grid { grid-template-columns:1fr; }
      .global-request-share { grid-template-columns:1fr; min-width:180px; }
    }
    @media print {
      body.purchase-global-report-print > *:not(#${GLOBAL_MODAL_ID}) { display:none!important; }
      body.purchase-global-report-print #${GLOBAL_MODAL_ID} { position:static!important; display:block!important; background:#fff!important; }
      body.purchase-global-report-print #${GLOBAL_MODAL_ID} .modal-dialog { max-width:none!important; margin:0!important; }
      body.purchase-global-report-print #${GLOBAL_MODAL_ID} .modal-content { border:0!important; }
      body.purchase-global-report-print #${GLOBAL_MODAL_ID} .modal-footer, body.purchase-global-report-print #${GLOBAL_MODAL_ID} .btn-close { display:none!important; }
    }
  `;
  document.head.appendChild(style);
}

async function fetchRequestLines(requestId) {
  const snapshot = await getDocs(collection(db, "purchaseRequests", requestId, "items"));
  return snapshot.docs.map(lineDoc => ({ id: lineDoc.id, ...lineDoc.data() }));
}

async function fetchRequest(requestId) {
  const snapshot = await getDoc(doc(db, "purchaseRequests", requestId));
  if (!snapshot.exists()) throw new Error("La solicitud ya no existe.");
  return { id: snapshot.id, ...snapshot.data() };
}

function ensureDetailSummarySlot() {
  const modal = document.querySelector("#purchaseRequestDetailModal");
  const body = modal?.querySelector("#purchaseRequestDetailBody");
  if (!modal || !body) return null;

  let slot = modal.querySelector(`#${DETAIL_SUMMARY_ID}`);
  if (!slot) {
    slot = document.createElement("div");
    slot.id = DETAIL_SUMMARY_ID;
    body.parentNode.insertBefore(slot, body);
  }
  return slot;
}

async function renderDetailSummary(requestId) {
  if (!requestId) return;
  const slot = ensureDetailSummarySlot();
  if (!slot) return;

  slot.dataset.requestId = requestId;
  slot.innerHTML = `
    <div class="request-progress-shell text-muted small">
      Calculando avance de la solicitud…
    </div>`;

  try {
    const [request, lines] = await Promise.all([
      fetchRequest(requestId),
      fetchRequestLines(requestId),
    ]);
    if (slot.dataset.requestId !== requestId) return;

    const summary = summarizeLines(lines);
    slot.innerHTML = `
      <div class="request-progress-shell">
        <div class="request-progress-heading">
          <div>
            <h6>Avance de la solicitud</h6>
            <div class="small">${escapeHtml(request.folio || request.id)} · ${escapeHtml(requestStatusLabel(request.status))}</div>
          </div>
          <div class="small">Los porcentajes usan la base vigente: solicitado menos cancelado.</div>
        </div>
        ${summaryBlockHtml(summary)}
      </div>`;
  } catch (error) {
    console.error("No se pudo calcular el avance de la solicitud:", error);
    if (slot.dataset.requestId === requestId) {
      slot.innerHTML = `<div class="alert alert-danger py-2">No se pudo calcular el avance: ${escapeHtml(error.message)}</div>`;
    }
  }
}

function currentDetailRequestId() {
  return String(document.querySelector("#purchaseRequestDetailPdf")?.dataset?.requestId || "");
}

function ensureGlobalModal() {
  let modal = document.querySelector(`#${GLOBAL_MODAL_ID}`);
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = GLOBAL_MODAL_ID;
  modal.className = "modal fade";
  modal.tabIndex = -1;
  modal.innerHTML = `
    <div class="modal-dialog modal-xl modal-dialog-scrollable">
      <div class="modal-content">
        <div class="modal-header">
          <div>
            <h5 class="modal-title mb-0">Reporte global de solicitudes de compra</h5>
            <div class="small text-muted">Requisiciones, recepciones y participación de cada solicitud.</div>
          </div>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button>
        </div>
        <div class="modal-body" id="purchaseGlobalProgressBody"></div>
        <div class="modal-footer">
          <button type="button" class="btn btn-outline-dark" id="refreshPurchaseGlobalProgress">Actualizar</button>
          <button type="button" class="btn btn-outline-danger" id="printPurchaseGlobalProgress">Imprimir / PDF</button>
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cerrar</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

function attachGlobalReportButton() {
  if (document.querySelector(`#${REPORT_BUTTON_ID}`)) return true;
  const refresh = document.querySelector("#refreshPurchaseRequests");
  const container = refresh?.parentElement;
  if (!refresh || !container) return false;

  const button = document.createElement("button");
  button.type = "button";
  button.id = REPORT_BUTTON_ID;
  button.className = "btn btn-outline-primary btn-sm";
  button.textContent = "Reporte global";
  container.insertBefore(button, refresh);
  return true;
}

function startManagerAttach() {
  if (attachGlobalReportButton()) return;
  let attempts = 0;
  managerAttachTimer = window.setInterval(() => {
    attempts += 1;
    if (attachGlobalReportButton() || attempts >= 80) {
      clearInterval(managerAttachTimer);
      managerAttachTimer = null;
    }
  }, 250);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) break;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function loadGlobalRequestBundles() {
  const snapshot = await getDocs(collection(db, "purchaseRequests"));
  const requests = snapshot.docs
    .map(requestDoc => ({ id: requestDoc.id, ...requestDoc.data() }))
    .filter(request => request.status !== REQUEST_STATUS_DRAFT)
    .sort((a, b) => {
      const da = timestampToDate(a.sentAt || a.createdAt)?.getTime() || 0;
      const dbv = timestampToDate(b.sentAt || b.createdAt)?.getTime() || 0;
      return dbv - da;
    });

  return mapLimit(requests, 6, async request => ({
    request,
    lines: await fetchRequestLines(request.id),
  }));
}

function aggregateGlobal(bundles) {
  const total = {
    totalProducts: 0,
    requisitionProducts: 0,
    receivedProducts: 0,
    partialReceivedProducts: 0,
    totalPieces: 0,
    requisitionPieces: 0,
    receivedPieces: 0,
    totalAmount: createMoneyMap(),
    requisitionAmount: createMoneyMap(),
    receivedAmount: createMoneyMap(),
    cancelledPieces: 0,
    cancelledProducts: 0,
  };

  const rows = bundles.map(({ request, lines }) => {
    const summary = summarizeLines(lines);
    total.totalProducts += summary.totalProducts;
    total.requisitionProducts += summary.requisitionProducts;
    total.receivedProducts += summary.receivedProducts;
    total.partialReceivedProducts += summary.partialReceivedProducts;
    total.totalPieces += summary.totalPieces;
    total.requisitionPieces += summary.requisitionPieces;
    total.receivedPieces += summary.receivedPieces;
    total.cancelledPieces += summary.cancelledPieces;
    total.cancelledProducts += summary.cancelledProducts;
    mergeMoney(total.totalAmount, summary.totalAmount);
    mergeMoney(total.requisitionAmount, summary.requisitionAmount);
    mergeMoney(total.receivedAmount, summary.receivedAmount);
    return { request, summary };
  });

  return { total, rows };
}

function requestGlobalAmountShare(summary, globalSummary) {
  const requestAmount = singleCurrencyValue(summary.totalAmount);
  const globalAmount = singleCurrencyValue(globalSummary.totalAmount);
  if (!requestAmount || !globalAmount || requestAmount.currency !== globalAmount.currency || globalAmount.amount <= 0) return "—";
  return percentText(requestAmount.amount, globalAmount.amount);
}

function requestStageHtml(summary, stage) {
  const requisition = stage === "requisition";
  const products = requisition ? summary.requisitionProducts : summary.receivedProducts;
  const pieces = requisition ? summary.requisitionPieces : summary.receivedPieces;
  const money = requisition ? summary.requisitionAmount : summary.receivedAmount;
  const tone = requisition ? "primary" : "success";

  return `
    <div class="global-progress-stage">
      <div class="stage-title text-${tone}">${requisition ? "Requisición" : "Recepción"}</div>
      <div class="stage-meta">Productos: <strong>${products}</strong> (${percentText(products, summary.totalProducts)})</div>
      <div class="stage-meta">Piezas: <strong>${pieces}</strong> (${percentText(pieces, summary.totalPieces)})</div>
      <div class="stage-meta">Monto: <strong>${escapeHtml(moneyMapText(money))}</strong> (${moneyPercentText(money, summary.totalAmount)})</div>
    </div>`;
}

function globalTableHtml(rows, globalSummary) {
  if (!rows.length) return `<div class="text-muted">No hay solicitudes enviadas para reportar.</div>`;

  return `
    <div class="table-responsive mt-4">
      <table class="table table-sm global-progress-table align-middle">
        <thead>
          <tr>
            <th>Solicitud</th>
            <th>Participación del total global</th>
            <th>Base vigente</th>
            <th>En requisición</th>
            <th>Recepción</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(({ request, summary }) => {
            const name = request.nombre || request.name || request.folio || request.id;
            return `
              <tr>
                <td>
                  <strong>${escapeHtml(name)}</strong>
                  <div class="small text-muted">${escapeHtml(requestStatusLabel(request.status))}${dateText(request.sentAt || request.createdAt) ? ` · ${escapeHtml(dateText(request.sentAt || request.createdAt))}` : ""}</div>
                </td>
                <td>
                  <div class="global-request-share">
                    <div><span>Monto</span><strong>${requestGlobalAmountShare(summary, globalSummary)}</strong></div>
                    <div><span>Productos</span><strong>${percentText(summary.totalProducts, globalSummary.totalProducts)}</strong></div>
                    <div><span>Piezas</span><strong>${percentText(summary.totalPieces, globalSummary.totalPieces)}</strong></div>
                  </div>
                </td>
                <td>
                  <div><strong>${summary.totalProducts}</strong> productos</div>
                  <div><strong>${summary.totalPieces}</strong> piezas</div>
                  <div class="small">${escapeHtml(moneyMapText(summary.totalAmount))}</div>
                </td>
                <td>${requestStageHtml(summary, "requisition")}</td>
                <td>${requestStageHtml(summary, "received")}</td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

async function renderGlobalReport() {
  if (globalReportBusy) return;
  globalReportBusy = true;

  const modalEl = ensureGlobalModal();
  const body = modalEl.querySelector("#purchaseGlobalProgressBody");
  body.innerHTML = `
    <div class="d-flex align-items-center gap-2 text-muted py-4 justify-content-center">
      <div class="spinner-border spinner-border-sm" role="status"></div>
      Calculando todas las solicitudes…
    </div>`;
  bootstrap.Modal.getOrCreateInstance(modalEl).show();

  try {
    const bundles = await loadGlobalRequestBundles();
    const { total, rows } = aggregateGlobal(bundles);
    const activeRows = rows.filter(({ request, summary }) =>
      request.status !== REQUEST_STATUS_CANCELLED || summary.totalProducts > 0 || summary.totalPieces > 0
    );

    body.innerHTML = `
      <div class="global-report-intro mb-3">
        El reporte usa como base vigente lo solicitado menos lo cancelado. Las solicitudes canceladas se muestran sólo si todavía conservan una base vigente; las eliminadas ya no existen en Firestore y, por definición, no forman parte del reporte.
      </div>
      ${summaryBlockHtml(total, { compact: true })}
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mt-4">
        <h6 class="mb-0">Participación y avance por solicitud</h6>
        <div class="small text-muted">${activeRows.length} solicitud${activeRows.length === 1 ? "" : "es"} con base vigente</div>
      </div>
      ${globalTableHtml(activeRows, total)}`;
  } catch (error) {
    console.error("No se pudo generar el reporte global de solicitudes:", error);
    body.innerHTML = `<div class="alert alert-danger">No se pudo generar el reporte global: ${escapeHtml(error.message)}</div>`;
  } finally {
    globalReportBusy = false;
  }
}

function printGlobalReport() {
  const modalEl = document.querySelector(`#${GLOBAL_MODAL_ID}`);
  if (!modalEl) return;
  document.body.classList.add("purchase-global-report-print");
  const cleanup = () => {
    document.body.classList.remove("purchase-global-report-print");
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
  window.setTimeout(cleanup, 1500);
}

function bindEvents() {
  document.addEventListener("purchase-request-detail-rendered", event => {
    const requestId = String(event.detail?.requestId || currentDetailRequestId());
    if (requestId) renderDetailSummary(requestId);
  });

  document.addEventListener("shown.bs.modal", event => {
    if (event.target?.id !== "purchaseRequestDetailModal") return;
    const requestId = currentDetailRequestId();
    if (requestId) renderDetailSummary(requestId);
  });

  document.addEventListener("shown.bs.offcanvas", event => {
    if (event.target?.id === "purchaseRequestsPanel") attachGlobalReportButton();
  });

  document.addEventListener("click", event => {
    if (event.target.closest(`#${REPORT_BUTTON_ID}`)) {
      renderGlobalReport();
      return;
    }
    if (event.target.closest("#refreshPurchaseGlobalProgress")) {
      renderGlobalReport();
      return;
    }
    if (event.target.closest("#printPurchaseGlobalProgress")) {
      printGlobalReport();
    }
  });
}

injectStyles();
ensureGlobalModal();
bindEvents();
startManagerAttach();
