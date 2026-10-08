import { db } from "./firebase-app.js";
import { waitForUser, getUserProfile } from "./common.js";
import {
  collection,
  getDocs,
  getDocsFromServer,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/*
 * ==========================================================================
 * COMPRAS · REPORTE DE SEGUIMIENTO DE REQUISICIONES POR SC
 * ==========================================================================
 *
 * Objetivo:
 * - seleccionar una o varias SC como lote;
 * - medir qué porcentaje ya está cubierto por requisición/recepción;
 * - identificar qué productos siguen pendientes de requisición;
 * - generar un documento imprimible / guardable como PDF.
 *
 * No modifica Firestore. Admin y Supervisor pueden consultar el reporte.
 * ==========================================================================
 */

const ALLOWED_ROLES = new Set(["admin", "supervisor"]);
const BUTTON_ID = "purchaseRequisitionFollowupReport";
const MODAL_ID = "purchaseRequisitionFollowupModal";
const STYLE_ID = "purchaseRequisitionFollowupStyles";

let currentRole = "";
let bundles = [];
let loadBusy = false;
let attachTimer = null;
let modalInstance = null;

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

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function pct(part, total) {
  const denominator = num(total);
  if (denominator <= 0) return 100;
  return clampPercent((num(part) / denominator) * 100);
}

function pctText(value) {
  return `${clampPercent(value).toLocaleString("es-MX", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })}%`;
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
    ? date.toLocaleDateString("es-MX", {
        year: "numeric",
        month: "short",
        day: "2-digit",
      })
    : "";
}

function formatCurrency(value, currency = "MXN") {
  const code = String(currency || "MXN").toUpperCase();
  try {
    return `${new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num(value))} ${code}`;
  } catch (_) {
    return `$${num(value).toFixed(2)} ${code}`;
  }
}

function linePendingQty(line) {
  return Math.max(
    num(line?.quantityRequested)
      - num(line?.quantityReceived)
      - num(line?.quantityCancelled),
    0
  );
}

function lineActiveQty(line) {
  return Math.max(
    num(line?.quantityRequested) - num(line?.quantityCancelled),
    0
  );
}

function lineNeedsRequisition(line) {
  return (
    lineActiveQty(line) > 0
    && linePendingQty(line) > 0
    && line?.requisitionStatus !== "requisitioned"
  );
}

function lineStage(line) {
  const active = lineActiveQty(line);
  const pending = linePendingQty(line);
  const received = Math.max(num(line?.quantityReceived), 0);

  if (active <= 0) return "cancelled";
  if (pending > 0 && line?.requisitionStatus === "requisitioned") return "requisition";
  if (pending > 0) return "missing";
  if (received > 0) return "received";
  return "covered";
}


function areaText(line) {
  const zone = `${line?.zoneId || ""}${line?.zoneName ? ` · ${line.zoneName}` : ""}`;
  const subzone = `${line?.subzoneId || ""}${line?.subzoneName ? ` · ${line.subzoneName}` : ""}`;
  const area = `${line?.locationCode || line?.locationId || ""}${line?.locationName ? ` · ${line.locationName}` : ""}`;
  return [zone, subzone, area].filter(Boolean).join(" / ");
}

function summarizeRequest(request, lines) {
  const activeLines = lines.filter(line => lineActiveQty(line) > 0);
  const missingLines = activeLines.filter(lineNeedsRequisition);

  const activeProducts = activeLines.length;
  const missingProducts = missingLines.length;
  const coveredProducts = Math.max(activeProducts - missingProducts, 0);

  let activePieces = 0;
  let missingPieces = 0;
  let requisitionProducts = 0;
  let receivedProducts = 0;

  activeLines.forEach(line => {
    activePieces += lineActiveQty(line);
    if (lineNeedsRequisition(line)) missingPieces += linePendingQty(line);

    const stage = lineStage(line);
    if (stage === "requisition") requisitionProducts += 1;
    if (stage === "received") receivedProducts += 1;
  });

  const coveredPieces = Math.max(activePieces - missingPieces, 0);
  const productProgress = pct(coveredProducts, activeProducts);
  const pieceProgress = pct(coveredPieces, activePieces);
  const productMissingPct = activeProducts > 0 ? 100 - productProgress : 0;
  const pieceMissingPct = activePieces > 0 ? 100 - pieceProgress : 0;

  return {
    request,
    lines,
    activeLines,
    missingLines,
    activeProducts,
    coveredProducts,
    missingProducts,
    activePieces,
    coveredPieces,
    missingPieces,
    requisitionProducts,
    receivedProducts,
    productProgress,
    pieceProgress,
    productMissingPct,
    pieceMissingPct,
    complete: missingProducts === 0,
  };
}

async function mapLimit(rows, limit, worker) {
  const result = new Array(rows.length);
  let cursor = 0;

  async function run() {
    while (cursor < rows.length) {
      const index = cursor++;
      result[index] = await worker(rows[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, rows.length || 1) }, () => run())
  );

  return result;
}

async function getSnapshot(ref) {
  try {
    return await getDocsFromServer(ref);
  } catch (_) {
    return getDocs(ref);
  }
}

async function loadBundles({ force = false } = {}) {
  if (loadBusy) return bundles;
  if (bundles.length && !force) return bundles;

  loadBusy = true;
  try {
    const requestSnap = await getSnapshot(collection(db, "purchaseRequests"));

    const requests = requestSnap.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .filter(request => request.status !== "draft" && request.status !== "cancelled")
      .sort((a, b) => {
        const da = timestampToDate(a.sentAt || a.createdAt)?.getTime() || 0;
        const dbv = timestampToDate(b.sentAt || b.createdAt)?.getTime() || 0;
        return dbv - da;
      });

    const loaded = await mapLimit(requests, 6, async request => {
      const lineSnap = await getSnapshot(
        collection(db, "purchaseRequests", request.id, "items")
      );
      const lines = lineSnap.docs.map(lineDoc => ({ id: lineDoc.id, ...lineDoc.data() }));
      return summarizeRequest(request, lines);
    });

    bundles = loaded.filter(bundle => bundle.activeProducts > 0 || bundle.lines.length > 0);
    return bundles;
  } finally {
    loadBusy = false;
  }
}

function injectStyles() {
  if (document.querySelector(`#${STYLE_ID}`)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${MODAL_ID} .modal-dialog { max-width: 1450px; }
    .req-followup-toolbar { display:flex; flex-wrap:wrap; gap:.65rem; align-items:center; }
    .req-followup-search { flex:1 1 320px; min-width:260px; }
    .req-followup-table th { white-space:nowrap; vertical-align:middle; }
    .req-followup-table td { vertical-align:middle; }
    .req-followup-row-complete { background:#f3fbf6; }
    .req-followup-row-missing { background:#fff7f7; }
    .req-followup-progress { min-width:135px; }
    .req-followup-progress .progress { height:.45rem; }
    .req-followup-progress small { display:block; color:#6c757d; margin-top:.2rem; }
    .req-followup-summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:.65rem; }
    .req-followup-summary-card { border:1px solid #dee2e6; border-radius:.7rem; padding:.75rem .85rem; background:#fff; }
    .req-followup-summary-card span { display:block; color:#6c757d; font-size:.72rem; text-transform:uppercase; font-weight:700; }
    .req-followup-summary-card strong { display:block; font-size:1.15rem; margin-top:.15rem; }
    @media (max-width: 991.98px) {
      .req-followup-summary { grid-template-columns:repeat(2,minmax(0,1fr)); }
    }
    @media (max-width: 575.98px) {
      .req-followup-summary { grid-template-columns:1fr; }
      .req-followup-toolbar .btn { flex:1 1 auto; }
    }
  `;
  document.head.appendChild(style);
}

function ensureModal() {
  let modal = document.querySelector(`#${MODAL_ID}`);
  if (modal) return modal;

  modal = document.createElement("div");
  modal.className = "modal fade";
  modal.id = MODAL_ID;
  modal.tabIndex = -1;
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `
    <div class="modal-dialog modal-xl modal-dialog-scrollable">
      <div class="modal-content">
        <div class="modal-header">
          <div>
            <h5 class="modal-title mb-1">Seguimiento de requisiciones por SC</h5>
            <div class="small text-muted">Selecciona una SC o varias como lote y genera el PDF de seguimiento.</div>
          </div>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button>
        </div>
        <div class="modal-body">
          <div id="reqFollowupBody"></div>
        </div>
        <div class="modal-footer d-flex flex-wrap justify-content-between gap-2">
          <div class="small text-muted" id="reqFollowupSelectionMeta"></div>
          <div class="d-flex flex-wrap gap-2">
            <button type="button" class="btn btn-outline-secondary" id="reqFollowupRefresh">Actualizar datos</button>
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cerrar</button>
            <button type="button" class="btn btn-danger" id="reqFollowupGeneratePdf">Generar PDF</button>
          </div>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modalInstance = bootstrap.Modal.getOrCreateInstance(modal);
  return modal;
}

function attachButton() {
  if (document.querySelector(`#${BUTTON_ID}`)) return true;

  const refresh = document.querySelector("#refreshPurchaseRequests");
  const global = document.querySelector("#purchaseGlobalProgressReport");
  const container = refresh?.parentElement || global?.parentElement;
  if (!container) return false;

  const button = document.createElement("button");
  button.type = "button";
  button.id = BUTTON_ID;
  button.className = "btn btn-outline-danger btn-sm";
  button.textContent = "Seguimiento requisiciones";
  button.title = "Generar reporte por SC con porcentaje requisicionado y productos pendientes de requisición";

  if (global?.parentElement === container) {
    global.insertAdjacentElement("afterend", button);
  } else if (refresh) {
    container.insertBefore(button, refresh);
  } else {
    container.appendChild(button);
  }

  return true;
}

function startAttach() {
  if (attachButton()) return;
  if (attachTimer) return;

  let attempts = 0;
  attachTimer = window.setInterval(() => {
    attempts += 1;
    if (attachButton() || attempts >= 80) {
      clearInterval(attachTimer);
      attachTimer = null;
    }
  }, 250);
}

function selectedRequestIds() {
  return [...document.querySelectorAll(".req-followup-select:checked")]
    .map(input => String(input.value || ""))
    .filter(Boolean);
}

function updateSelectionMeta() {
  const meta = document.querySelector("#reqFollowupSelectionMeta");
  const button = document.querySelector("#reqFollowupGeneratePdf");
  const count = selectedRequestIds().length;
  if (meta) meta.textContent = `${count} SC seleccionada${count === 1 ? "" : "s"}`;
  if (button) button.disabled = count === 0;
}

function progressCellHtml(value, missingPct) {
  const complete = value >= 99.999;
  const tone = complete ? "success" : "danger";
  return `
    <div class="req-followup-progress">
      <div class="d-flex justify-content-between gap-2 small">
        <strong>${pctText(value)}</strong>
        <span class="text-${tone}">falta ${pctText(missingPct)}</span>
      </div>
      <div class="progress" role="progressbar" aria-valuenow="${value}" aria-valuemin="0" aria-valuemax="100">
        <div class="progress-bar bg-${tone}" style="width:${value}%"></div>
      </div>
    </div>`;
}

function modalTableHtml(rows) {
  return `
    <div class="table-responsive mt-3">
      <table class="table table-sm req-followup-table align-middle">
        <thead>
          <tr>
            <th style="width:42px"><input class="form-check-input" type="checkbox" id="reqFollowupSelectAll" checked aria-label="Seleccionar todas"></th>
            <th>SC</th>
            <th>Fecha</th>
            <th>Productos</th>
            <th>Falta requisición</th>
            <th>Avance productos</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(bundle => {
            const request = bundle.request;
            const folio = request.folio || request.id;
            const alias = String(request.alias || "").trim();
            const search = `${folio} ${alias}`.toLocaleLowerCase("es-MX");
            return `
              <tr class="req-followup-request-row ${bundle.complete ? "req-followup-row-complete" : "req-followup-row-missing"}" data-search="${esc(search)}">
                <td><input class="form-check-input req-followup-select" type="checkbox" value="${esc(request.id)}" checked></td>
                <td>
                  <strong>${esc(folio)}</strong>
                  <div class="small ${alias ? "fw-semibold text-primary" : "text-muted"}">${alias ? esc(alias) : "Sin alias"}</div>
                </td>
                <td>${esc(dateText(request.sentAt || request.createdAt))}</td>
                <td>${bundle.coveredProducts} / ${bundle.activeProducts}</td>
                <td><strong class="${bundle.missingProducts ? "text-danger" : "text-success"}">${bundle.missingProducts}</strong></td>
                <td>${progressCellHtml(bundle.productProgress, bundle.productMissingPct)}</td>
                <td>${bundle.complete
                  ? '<span class="badge text-bg-success">Completa</span>'
                  : `<span class="badge text-bg-danger">Falta requisición ${pctText(bundle.productMissingPct)}</span>`}</td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

function renderSelector(rows) {
  const body = document.querySelector("#reqFollowupBody");
  if (!body) return;

  const complete = rows.filter(row => row.complete).length;
  const incomplete = rows.length - complete;
  const missingProducts = rows.reduce((sum, row) => sum + row.missingProducts, 0);
  body.innerHTML = `
    <div class="req-followup-summary mb-3">
      <div class="req-followup-summary-card"><span>SC activas</span><strong>${rows.length}</strong></div>
      <div class="req-followup-summary-card"><span>SC completas</span><strong class="text-success">${complete}</strong></div>
      <div class="req-followup-summary-card"><span>SC con faltantes</span><strong class="text-danger">${incomplete}</strong></div>
      <div class="req-followup-summary-card"><span>Productos sin requisición</span><strong>${missingProducts}</strong></div>
    </div>

    <div class="req-followup-toolbar">
      <input type="search" class="form-control req-followup-search" id="reqFollowupSearch" placeholder="Buscar por SC o alias" autocomplete="off">
      <button type="button" class="btn btn-outline-dark btn-sm" id="reqFollowupSelectAllButton">Seleccionar todas</button>
      <button type="button" class="btn btn-outline-danger btn-sm" id="reqFollowupSelectIncomplete">Sólo incompletas</button>
      <button type="button" class="btn btn-outline-secondary btn-sm" id="reqFollowupSelectNone">Ninguna</button>
    </div>

    <div class="small text-muted mt-2">
      Avance de productos: una línea se considera cubierta cuando ya tiene requisición registrada o ya terminó por recepción. Las cantidades canceladas se excluyen de la base vigente.
    </div>

    ${modalTableHtml(rows)}`;

  updateSelectionMeta();
}

async function openReportSelector({ force = true } = {}) {
  const modal = ensureModal();
  const body = modal.querySelector("#reqFollowupBody");
  body.innerHTML = `
    <div class="d-flex align-items-center justify-content-center gap-2 py-5 text-muted">
      <div class="spinner-border spinner-border-sm" role="status"></div>
      Calculando seguimiento de requisiciones…
    </div>`;

  modalInstance?.show();

  try {
    const rows = await loadBundles({ force });
    renderSelector(rows);
  } catch (error) {
    console.error("No se pudo generar el seguimiento de requisiciones:", error);
    body.innerHTML = `<div class="alert alert-danger">No se pudo cargar el reporte: ${esc(error.message)}</div>`;
  }
}

function toggleVisibleSelection(checked, onlyIncomplete = false) {
  document.querySelectorAll(".req-followup-request-row").forEach(row => {
    if (row.classList.contains("d-none")) return;
    const check = row.querySelector(".req-followup-select");
    if (!check) return;
    if (onlyIncomplete && !row.classList.contains("req-followup-row-missing")) {
      check.checked = false;
      return;
    }
    check.checked = checked;
  });
  updateSelectionMeta();
}

function filterSelector(value) {
  const query = String(value || "").trim().toLocaleLowerCase("es-MX");
  document.querySelectorAll(".req-followup-request-row").forEach(row => {
    const haystack = String(row.dataset.search || "");
    row.classList.toggle("d-none", Boolean(query) && !haystack.includes(query));
  });
}

function compareFolio(a, b) {
  return String(a?.request?.folio || a?.request?.id || "").localeCompare(
    String(b?.request?.folio || b?.request?.id || ""),
    "es",
    { numeric: true, sensitivity: "base" }
  );
}

function batchSummary(rows) {
  const summary = {
    sc: rows.length,
    completeSc: 0,
    incompleteSc: 0,
    activeProducts: 0,
    coveredProducts: 0,
    missingProducts: 0,
  };

  rows.forEach(row => {
    if (row.complete) summary.completeSc += 1;
    else summary.incompleteSc += 1;
    summary.activeProducts += row.activeProducts;
    summary.coveredProducts += row.coveredProducts;
    summary.missingProducts += row.missingProducts;
  });

  summary.productProgress = pct(summary.coveredProducts, summary.activeProducts);
  summary.productMissingPct = summary.activeProducts > 0 ? 100 - summary.productProgress : 0;
  return summary;
}

function pdfProgressHtml(value, missingPct) {
  const complete = value >= 99.999;
  const toneClass = complete ? "complete" : "incomplete";
  return `
    <div class="pdf-progress ${toneClass}">
      <div class="pdf-progress-head">
        <strong>${pctText(value)}</strong>
        <span>Falta ${pctText(missingPct)}</span>
      </div>
      <div class="pdf-progress-track">
        <div class="pdf-progress-fill" style="width:${clampPercent(value)}%"></div>
      </div>
    </div>`;
}

function pdfSummaryRows(rows) {
  const sorted = [...rows].sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? 1 : -1;
    return compareFolio(a, b);
  });

  return sorted.map(row => {
    const request = row.request;
    const folio = request.folio || request.id;
    const alias = String(request.alias || "").trim();
    return `
      <tr class="${row.complete ? "row-complete" : "row-incomplete"}">
        <td><strong>${esc(folio)}</strong>${alias ? `<div class="alias">${esc(alias)}</div>` : ""}</td>
        <td>${esc(dateText(request.sentAt || request.createdAt))}</td>
        <td class="num">${row.activeProducts}</td>
        <td class="num">${row.requisitionProducts}</td>
        <td class="num">${row.receivedProducts}</td>
        <td class="num missing">${row.missingProducts}</td>
        <td>${pdfProgressHtml(row.productProgress, row.productMissingPct)}</td>
        <td>${row.complete
          ? '<span class="pill complete">COMPLETA</span>'
          : `<span class="pill missing">FALTA REQUISICIÓN ${pctText(row.productMissingPct)}</span>`}</td>
      </tr>`;
  }).join("");
}

function missingLineRows(row) {
  const lines = [...row.missingLines].sort((a, b) =>
    String(a.sku || "").localeCompare(String(b.sku || ""), "es", { numeric: true, sensitivity: "base" })
    || String(a.nombre || "").localeCompare(String(b.nombre || ""), "es", { sensitivity: "base" })
  );

  return lines.map(line => `
    <tr>
      <td><strong>${esc(line.sku || "")}</strong></td>
      <td>${esc(line.nombre || "Item")}${line.descripcion ? `<div class="line-desc">${esc(line.descripcion)}</div>` : ""}</td>
      <td class="num">${num(line.quantityRequested)}</td>
      <td>${esc(areaText(line) || "—")}</td>
      <td class="num">${esc(formatCurrency(line.unitPrice, line.currency || "MXN"))}</td>
    </tr>`).join("");
}

function incompleteSections(rows) {
  return [...rows]
    .filter(row => !row.complete)
    .sort(compareFolio)
    .map(row => {
      const request = row.request;
      const folio = request.folio || request.id;
      const alias = String(request.alias || "").trim();
      return `
        <section class="sc-detail">
          <div class="sc-detail-head">
            <div>
              <div class="sc-kicker">SC INCOMPLETA</div>
              <h2>${esc(folio)}${alias ? ` · ${esc(alias)}` : ""}</h2>
              <div class="detail-meta">${row.missingProducts} producto${row.missingProducts === 1 ? "" : "s"} todavía sin requisición</div>
            </div>
            <div class="missing-box">
              <span>Falta requisición</span>
              <strong>${pctText(row.productMissingPct)}</strong>
              <small>Avance: ${pctText(row.productProgress)}</small>
            </div>
          </div>

          <table class="detail-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Producto</th>
                <th class="num">Solicitado</th>
                <th>Zona / subzona / área</th>
                <th class="num">Precio unit.</th>
              </tr>
            </thead>
            <tbody>${missingLineRows(row)}</tbody>
          </table>
        </section>`;
    }).join("");
}

function completeScList(rows) {
  const completed = [...rows].filter(row => row.complete).sort(compareFolio);
  if (!completed.length) return "";
  return `
    <section class="complete-section">
      <h2>SC completas</h2>
      <p>Estas SC no tienen productos pendientes de requisición.</p>
      <div class="complete-list">
        ${completed.map(row => {
          const folio = row.request.folio || row.request.id;
          const alias = String(row.request.alias || "").trim();
          return `<span>${esc(folio)}${alias ? ` · ${esc(alias)}` : ""}</span>`;
        }).join("")}
      </div>
    </section>`;
}

function generatePdf(rows) {
  const popup = window.open("", "_blank");
  if (!popup) {
    alert("El navegador bloqueó la ventana del reporte. Permite ventanas emergentes e inténtalo nuevamente.");
    return;
  }

  const summary = batchSummary(rows);
  const generated = new Date().toLocaleString("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  popup.document.write(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<base href="${esc(document.baseURI)}">
<title>Seguimiento de requisiciones por SC</title>
<style>
@page{size:A4 landscape;margin:9mm}
*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;box-sizing:border-box}
body{font-family:Arial,sans-serif;color:#171717;margin:0;background:#fff;font-size:9pt}
.toolbar{display:flex;justify-content:flex-end;gap:8px;padding:10px;border-bottom:1px solid #ddd}
.toolbar button{padding:7px 12px;border:1px solid #aaa;background:#fff;border-radius:5px;cursor:pointer}
.page{padding:0}
header{border-bottom:3px solid #c8102e;padding-bottom:4mm;margin-bottom:5mm}
.kicker{font-size:8.5pt;font-weight:700;color:#c8102e;text-transform:uppercase;letter-spacing:.03em}
h1{font-size:22pt;margin:1mm 0}
.meta{color:#666;font-size:8.5pt}
.note{border-left:1.5mm solid #6c757d;background:#f8f9fa;padding:2.5mm 3mm;margin:4mm 0;font-size:8.5pt}
.summary-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:2.5mm;margin:4mm 0 4mm}
.summary-card{border:1px solid #ddd;border-radius:2mm;padding:2.8mm}
.summary-card span{display:block;color:#666;font-size:7pt;text-transform:uppercase;font-weight:700}
.summary-card strong{display:block;font-size:15pt;margin-top:1mm}
.summary-card.good{border-color:#a3cfbb;background:#f0fff6}
.summary-card.bad{border-color:#f1aeb5;background:#fff5f5}
h2{font-size:14pt;margin:0 0 2mm}
.summary-table,.detail-table{width:100%;border-collapse:collapse}
.summary-table{font-size:8pt;margin-bottom:6mm}
.summary-table th,.summary-table td,.detail-table th,.detail-table td{border:1px solid #d8d8d8;padding:1.6mm;vertical-align:top}
.summary-table th,.detail-table th{background:#f2f2f2;text-align:left}
.num{text-align:right!important;white-space:nowrap}
.alias{font-size:7pt;color:#555;margin-top:.5mm}
.row-complete{background:#f0fff6}
.row-incomplete{background:#fff7f7}
.missing{color:#b02a37}
.pill{display:inline-block;border-radius:99px;padding:1mm 2mm;font-size:7pt;font-weight:700;white-space:nowrap}
.pill.complete{background:#198754;color:#fff}
.pill.missing{background:#dc3545;color:#fff}
.pdf-batch-progress{border:1px solid #ddd;border-radius:2mm;padding:2.5mm 3mm;margin:0 0 6mm;background:#fff}
.pdf-batch-progress-head{display:flex;justify-content:space-between;gap:4mm;align-items:center;margin-bottom:1.5mm}
.pdf-batch-progress-head strong{font-size:11pt}
.pdf-batch-progress-head span{font-size:8pt;color:#b02a37;font-weight:700}
.pdf-progress{min-width:34mm}
.pdf-progress-head{display:flex;justify-content:space-between;gap:2mm;font-size:7pt;margin-bottom:.8mm}
.pdf-progress.incomplete .pdf-progress-head span{color:#b02a37;font-weight:700}
.pdf-progress.complete .pdf-progress-head span{color:#198754;font-weight:700}
.pdf-progress-track{height:3mm;border-radius:99px;background:#e9ecef;overflow:hidden}
.pdf-progress-fill{height:100%;background:#dc3545;border-radius:99px}
.pdf-progress.complete .pdf-progress-fill{background:#198754}
.pdf-batch-progress .pdf-progress-track{height:4mm}
.sc-detail{margin:0 0 6mm;break-inside:avoid-page}
.sc-detail-head{display:flex;justify-content:space-between;gap:5mm;align-items:flex-start;border-left:2mm solid #dc3545;background:#fff5f5;padding:2.5mm 3mm;margin-bottom:2mm}
.sc-kicker{font-size:7pt;color:#b02a37;font-weight:700;letter-spacing:.04em}
.detail-meta{font-size:8pt;color:#666}
.missing-box{border:1px solid #f1aeb5;background:#fff;text-align:right;padding:2mm 3mm;border-radius:2mm;min-width:32mm}
.missing-box span,.missing-box small{display:block;font-size:7pt;color:#666}
.missing-box strong{display:block;font-size:17pt;color:#b02a37}
.detail-table{font-size:7.3pt}
.line-desc{color:#666;font-size:6.8pt;margin-top:.5mm}
a{color:#176b3a;text-decoration:none;font-weight:700}
.complete-section{border-left:2mm solid #198754;background:#f0fff6;padding:3mm;margin-top:5mm;break-inside:avoid}
.complete-section p{margin:0 0 2mm;color:#555}
.complete-list{display:flex;flex-wrap:wrap;gap:1.5mm}
.complete-list span{border:1px solid #a3cfbb;background:#fff;padding:1.2mm 2mm;border-radius:99px;font-size:7.5pt}
@media print{.toolbar{display:none!important}}
</style>
</head>
<body>
<div class="toolbar"><button onclick="window.print()">Imprimir / Guardar PDF</button><button onclick="window.close()">Cerrar</button></div>
<main class="page">
<header>
  <div class="kicker">Universidad Iberoamericana Ciudad de México · FabLab</div>
  <h1>Seguimiento de requisiciones por SC</h1>
  <div class="meta">Generado: ${esc(generated)} · ${summary.sc} SC seleccionada${summary.sc === 1 ? "" : "s"}</div>
</header>

<div class="note">
  <strong>Criterio del reporte.</strong> Avance por productos = líneas vigentes que ya tienen requisición registrada o que ya terminaron por recepción. Las cantidades canceladas se excluyen de la base. El detalle muestra únicamente productos que aún no tienen requisición registrada.
</div>

<section class="summary-grid">
  <div class="summary-card"><span>SC seleccionadas</span><strong>${summary.sc}</strong></div>
  <div class="summary-card good"><span>SC completas</span><strong>${summary.completeSc}</strong></div>
  <div class="summary-card bad"><span>SC con faltantes</span><strong>${summary.incompleteSc}</strong></div>
  <div class="summary-card"><span>Avance productos</span><strong>${pctText(summary.productProgress)}</strong></div>
  <div class="summary-card bad"><span>Falta requisición</span><strong>${summary.missingProducts} prod.</strong></div>
</section>

<div class="pdf-batch-progress">
  <div class="pdf-batch-progress-head">
    <strong>Avance global de productos · ${pctText(summary.productProgress)}</strong>
    <span>Falta requisición · ${pctText(summary.productMissingPct)}</span>
  </div>
  <div class="pdf-progress-track"><div class="pdf-progress-fill" style="width:${clampPercent(summary.productProgress)}%"></div></div>
</div>

<h2>Resumen por SC</h2>
<table class="summary-table">
  <thead>
    <tr>
      <th>SC</th><th>Fecha</th><th class="num">Productos</th><th class="num">En requisición</th><th class="num">Recibidos</th><th class="num">Falta requisición</th><th>Avance productos</th><th>Estado</th>
    </tr>
  </thead>
  <tbody>${pdfSummaryRows(rows)}</tbody>
</table>

${incompleteSections(rows)}
${completeScList(rows)}
</main>
<script>
window.addEventListener("load",()=>setTimeout(()=>window.print(),300));
<\/script>
</body>
</html>`);
  popup.document.close();
}

function selectedBundles() {
  const ids = new Set(selectedRequestIds());
  return bundles.filter(bundle => ids.has(String(bundle.request.id)));
}

function bindEvents() {
  document.addEventListener("click", event => {
    if (event.target.closest?.(`#${BUTTON_ID}`)) {
      void openReportSelector({ force: true });
      return;
    }

    if (event.target.closest?.("#reqFollowupRefresh")) {
      void openReportSelector({ force: true });
      return;
    }

    if (event.target.closest?.("#reqFollowupSelectAllButton")) {
      toggleVisibleSelection(true, false);
      return;
    }

    if (event.target.closest?.("#reqFollowupSelectIncomplete")) {
      toggleVisibleSelection(true, true);
      return;
    }

    if (event.target.closest?.("#reqFollowupSelectNone")) {
      toggleVisibleSelection(false, false);
      return;
    }

    if (event.target.closest?.("#reqFollowupGeneratePdf")) {
      const rows = selectedBundles();
      if (!rows.length) {
        alert("Selecciona al menos una SC para generar el reporte.");
        return;
      }
      generatePdf(rows);
      return;
    }
  });

  document.addEventListener("input", event => {
    if (event.target?.id === "reqFollowupSearch") {
      filterSelector(event.target.value);
    }
  });

  document.addEventListener("change", event => {
    if (event.target?.matches?.(".req-followup-select")) {
      updateSelectionMeta();
      const all = document.querySelector("#reqFollowupSelectAll");
      if (all) {
        const checks = [...document.querySelectorAll(".req-followup-select")];
        const selected = checks.filter(check => check.checked).length;
        all.checked = checks.length > 0 && selected === checks.length;
        all.indeterminate = selected > 0 && selected < checks.length;
      }
      return;
    }

    if (event.target?.id === "reqFollowupSelectAll") {
      document.querySelectorAll(".req-followup-select").forEach(check => {
        check.checked = event.target.checked;
      });
      updateSelectionMeta();
    }
  });
}

async function init() {
  const user = await waitForUser();
  if (!user) return;

  const profile = await getUserProfile(user.uid);
  currentRole = profile?.appRole || profile?.role || "";
  if (!ALLOWED_ROLES.has(currentRole)) return;

  injectStyles();
  ensureModal();
  bindEvents();
  startAttach();
}

init().catch(error => {
  console.error("No se pudo iniciar el reporte de seguimiento de requisiciones:", error);
});
