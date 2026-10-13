/*
 * FabLab IBERO · Seguimiento de recepciones por solicitud de compra (SC).
 * Reporte de SOLO LECTURA. No altera inventario, líneas ni solicitudes.
 * Cada SKU se lista si quantityReceived > 0, incluso en recepciones parciales.
 * Los importes se agrupan por moneda y se distingue el dato real registrado
 * de estimaciones reconstruidas para líneas antiguas sin actualCostTotal.
 */
import { db } from "./firebase-app.js";
import { waitForUser, getUserProfile } from "./common.js";
import {
  collection, getDocs, getDocsFromServer,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const ALLOWED_ROLES = new Set(["admin", "supervisor"]);
const BUTTON_ID = "purchaseReceptionFollowupReport";
const MODAL_ID = "purchaseReceptionFollowupModal";
const STYLE_ID = "purchaseReceptionFollowupStyles";
const PREFIX = "receptionFollowup";
let bundles = [];
let modalInstance = null;
let loadPromise = null;
let attachTimer = null;
let selectedOnce = false;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function qty(value) { return Math.max(0, num(value)); }
function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function normalize(value) {
  return String(value ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-MX").replace(/\s+/g, " ").trim();
}
function stampDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function dateText(value, full = false) {
  const date = stampDate(value);
  if (!date) return "—";
  return date.toLocaleString("es-MX", full
    ? { dateStyle: "medium", timeStyle: "short" }
    : { year: "numeric", month: "short", day: "2-digit" });
}
function currencyText(value, currency = "MXN") {
  const code = String(currency || "MXN").toUpperCase();
  try {
    return `${new Intl.NumberFormat("es-MX", {
      style: "currency", currency: code,
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(num(value))} ${code}`;
  } catch (_) {
    return `${num(value).toFixed(2)} ${code}`;
  }
}
function percent(part, total) {
  return total > 0 ? Math.min(100, Math.max(0, qty(part) / qty(total) * 100)) : 0;
}
function percentText(value) {
  return `${num(value).toLocaleString("es-MX", {maximumFractionDigits: 1})}%`;
}
function areaText(line) {
  return [
    `${line.zoneId || ""}${line.zoneName ? ` · ${line.zoneName}` : ""}`,
    `${line.subzoneId || ""}${line.subzoneName ? ` · ${line.subzoneName}` : ""}`,
    `${line.locationCode || line.locationId || ""}${line.locationName ? ` · ${line.locationName}` : ""}`,
  ].filter(Boolean).join(" / ");
}
function receivedCost(line) {
  const pieces = qty(line.quantityReceived);
  if (Object.prototype.hasOwnProperty.call(line, "actualCostTotal")
      && Number.isFinite(Number(line.actualCostTotal))) {
    return { amount: Math.max(0, num(line.actualCostTotal)), estimated: false };
  }
  const lastCost = line.lastActualUnitCost != null
    ? qty(line.lastActualUnitCost) : qty(line.unitPrice);
  return { amount: pieces * lastCost, estimated: true };
}
function mergeAmount(map, currency, amount, estimated) {
  const code = String(currency || "MXN").toUpperCase();
  const previous = map.get(code) || { amount: 0, estimated: false };
  map.set(code, {
    amount: previous.amount + qty(amount),
    estimated: previous.estimated || Boolean(estimated),
  });
}
function moneyText(map) {
  if (!map.size) return "—";
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([code, entry]) => `${entry.estimated ? "≈ " : ""}${currencyText(entry.amount, code)}`)
    .join(" · ");
}
function requestSort(a, b) {
  const da = stampDate(a.request.sentAt || a.request.createdAt)?.getTime() || 0;
  const db = stampDate(b.request.sentAt || b.request.createdAt)?.getTime() || 0;
  return db - da || String(a.request.folio || a.request.id).localeCompare(
    String(b.request.folio || b.request.id), "es", { numeric: true });
}
function lineSort(a, b) {
  return String(a.sku || "").localeCompare(String(b.sku || ""), "es", {
    numeric: true, sensitivity: "base",
  }) || String(a.nombre || "").localeCompare(String(b.nombre || ""), "es");
}

function summarizeRequest(request, lines) {
  const receivedLines = lines.filter(line => qty(line.quantityReceived) > 0).sort(lineSort);
  const requestedLines = lines.filter(line => qty(line.quantityRequested) - qty(line.quantityCancelled) > 0);
  const totals = new Map();
  let activePieces = 0;
  let receivedPieces = 0;
  let pendingPieces = 0;
  let cancelledPieces = 0;
  let estimatedRows = 0;
  let latestReceipt = null;

  for (const line of lines) {
    const active = Math.max(qty(line.quantityRequested) - qty(line.quantityCancelled), 0);
    const received = qty(line.quantityReceived);
    activePieces += active;
    receivedPieces += received;
    pendingPieces += Math.max(active - received, 0);
    cancelledPieces += qty(line.quantityCancelled);
    if (received > 0) {
      const { amount, estimated } = receivedCost(line);
      if (estimated) estimatedRows += 1;
      mergeAmount(totals, line.currency || "MXN", amount, estimated);
      const date = stampDate(line.lastReceivedAt);
      if (date && (!latestReceipt || date > latestReceipt)) latestReceipt = date;
    }
  }

  const receivedProductCount = receivedLines.length;
  const activeProducts = requestedLines.length;
  const complete = receivedPieces > 0 && pendingPieces === 0;
  const label = receivedPieces === 0 ? "Sin recepción"
    : complete ? "Recibida" : "Recepción parcial";
  return {
    request, lines, receivedLines, receivedProductCount, activeProducts,
    activePieces, receivedPieces, pendingPieces, cancelledPieces,
    estimatedRows, latestReceipt, totals, complete, label,
    productProgress: percent(receivedProductCount, activeProducts),
    pieceProgress: percent(receivedPieces, activePieces),
  };
}

async function getFreshCollection(ref) {
  try { return await getDocsFromServer(ref); }
  catch (_) { return await getDocs(ref); }
}
async function mapLimited(rows, concurrency, worker) {
  let cursor = 0;
  const out = new Array(rows.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor++;
      out[index] = await worker(rows[index]);
    }
  }));
  return out;
}
async function loadBundles({ force = false } = {}) {
  if (loadPromise) return loadPromise;
  if (!force && bundles.length) return bundles;

  loadPromise = (async () => {
    const snap = await getFreshCollection(collection(db, "purchaseRequests"));
    // Se incluyen las SC canceladas: algunas conservan recepciones históricas.
    const requests = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(request => request.status !== "draft");
    const loaded = await mapLimited(requests, 6, async request => {
      const linesSnap = await getFreshCollection(
        collection(db, "purchaseRequests", request.id, "items")
      );
      return summarizeRequest(request, linesSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    bundles = loaded.filter(bundle => bundle.lines.length).sort(requestSort);
    return bundles;
  })();
  try { return await loadPromise; }
  finally { loadPromise = null; }
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${MODAL_ID} .modal-dialog { max-width: 1450px; }
    .reception-followup-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:.65rem; }
    .reception-followup-toolbar .search-field { flex:1 1 300px; min-width:220px; }
    .reception-followup-summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:.7rem; }
    .reception-followup-summary > div { border:1px solid #dee2e6; border-radius:.7rem; padding:.85rem; }
    .reception-followup-summary span { display:block; color:#6c757d; font-size:.75rem; font-weight:700; text-transform:uppercase; }
    .reception-followup-summary strong { display:block; margin-top:.15rem; font-size:1.25rem; }
    .reception-followup-sc-table th { white-space:nowrap; }
    .reception-followup-sc-table td { vertical-align:middle; }
    .reception-followup-has-receipt { background:#f2faf5; }
    .reception-followup-progress { min-width:132px; }
    .reception-followup-progress .progress { height:.45rem; }
    .reception-followup-help { font-size:.85rem; color:#6c757d; }
    @media(max-width:991.98px){ .reception-followup-summary { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media(max-width:575.98px){ .reception-followup-summary { grid-template-columns:1fr; } }
  `;
  document.head.appendChild(style);
}
function ensureModal() {
  let modal = document.getElementById(MODAL_ID);
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = MODAL_ID;
  modal.className = "modal fade";
  modal.tabIndex = -1;
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `
    <div class="modal-dialog modal-xl modal-dialog-scrollable">
      <div class="modal-content">
        <div class="modal-header">
          <div>
            <h5 class="modal-title mb-1">Seguimiento de recepciones por SC</h5>
            <div class="small text-muted">Consulta qué artículos ya llegaron en una o varias solicitudes de compra.</div>
          </div>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button>
        </div>
        <div class="modal-body" id="${PREFIX}Body"></div>
        <div class="modal-footer d-flex flex-wrap justify-content-between gap-2">
          <div class="small text-muted" id="${PREFIX}SelectionMeta"></div>
          <div class="d-flex flex-wrap gap-2">
            <button type="button" class="btn btn-outline-secondary" id="${PREFIX}Refresh">Actualizar datos</button>
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cerrar</button>
            <button type="button" class="btn btn-danger" id="${PREFIX}GeneratePdf">Generar PDF</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modalInstance = bootstrap.Modal.getOrCreateInstance(modal);
  return modal;
}
function attachButton() {
  if (document.getElementById(BUTTON_ID)) return true;
  const requisitionButton = document.getElementById("purchaseRequisitionFollowupReport");
  const refresh = document.getElementById("refreshPurchaseRequests");
  const global = document.getElementById("purchaseGlobalProgressReport");
  const container = requisitionButton?.parentElement || refresh?.parentElement || global?.parentElement;
  if (!container) return false;
  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.className = "btn btn-outline-success btn-sm";
  button.textContent = "Seguimiento recepciones";
  button.title = "Reporte por SC: lista de SKU y cantidades que ya llegaron";
  if (requisitionButton?.parentElement === container) {
    requisitionButton.insertAdjacentElement("afterend", button);
  } else if (refresh?.parentElement === container) {
    container.insertBefore(button, refresh);
  } else {
    container.appendChild(button);
  }
  return true;
}
function startAttach() {
  if (attachButton() || attachTimer) return;
  let attempts = 0;
  attachTimer = window.setInterval(() => {
    attempts += 1;
    if (attachButton() || attempts >= 120) {
      window.clearInterval(attachTimer);
      attachTimer = null;
    }
  }, 250);
}
function requestRows() {
  return [...document.querySelectorAll(`#${MODAL_ID} .reception-followup-row`)];
}
function selectedIds() {
  return new Set([...document.querySelectorAll(`#${MODAL_ID} .reception-followup-select:checked`)]
    .map(input => String(input.value || "")));
}
function selectedBundles() {
  const ids = selectedIds();
  return bundles.filter(bundle => ids.has(String(bundle.request.id)));
}
function updateSelectionMeta() {
  const selected = selectedBundles();
  const receipts = selected.reduce((sum, row) => sum + row.receivedPieces, 0);
  const products = selected.reduce((sum, row) => sum + row.receivedProductCount, 0);
  const meta = document.getElementById(`${PREFIX}SelectionMeta`);
  const generate = document.getElementById(`${PREFIX}GeneratePdf`);
  if (meta) meta.textContent = `${selected.length} SC seleccionadas · ${products} SKU recibidos · ${receipts} piezas recibidas`;
  if (generate) generate.disabled = selected.length === 0;
  const all = document.getElementById(`${PREFIX}SelectAll`);
  if (all) {
    const visible = requestRows().filter(row => !row.classList.contains("d-none"));
    const enabled = visible.map(row => row.querySelector(".reception-followup-select")).filter(Boolean);
    const checked = enabled.filter(input => input.checked).length;
    all.checked = enabled.length > 0 && checked === enabled.length;
    all.indeterminate = checked > 0 && checked < enabled.length;
  }
}
function selectRows(mode) {
  const rows = requestRows();
  if (mode === "only-received") {
    for (const row of rows) {
      row.querySelector(".reception-followup-select").checked =
        !row.classList.contains("d-none") && row.dataset.hasReceipt === "1";
    }
  } else {
    for (const row of rows) {
      if (mode === "all-clear" || !row.classList.contains("d-none")) {
        row.querySelector(".reception-followup-select").checked = mode === "visible-check";
      }
    }
  }
  updateSelectionMeta();
}
function applySearch(value) {
  const terms = normalize(value).split(" ").filter(Boolean);
  for (const row of requestRows()) {
    const haystack = row.dataset.search || "";
    row.classList.toggle("d-none", !terms.every(term => haystack.includes(term)));
  }
  const visible = requestRows().filter(row => !row.classList.contains("d-none")).length;
  const counter = document.getElementById(`${PREFIX}VisibleCount`);
  if (counter) counter.textContent = `${visible} de ${bundles.length} SC visibles`;
  updateSelectionMeta();
}
function progressHtml(value) {
  const v = Math.max(0, Math.min(100, num(value)));
  const tone = v >= 100 ? "success" : v > 0 ? "warning" : "secondary";
  return `<div class="reception-followup-progress">
    <strong class="small">${percentText(v)}</strong>
    <div class="progress" role="progressbar" aria-valuenow="${v}" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-bar bg-${tone}" style="width:${v}%"></div>
    </div></div>`;
}
function selectorRow(bundle, preserved) {
  const request = bundle.request;
  const folio = request.folio || request.id;
  const alias = String(request.alias || "").trim();
  const indexed = [folio, alias, ...bundle.lines.flatMap(line => [line.nombre, line.sku])];
  const checked = preserved === null || preserved.has(String(request.id));
  return `<tr class="reception-followup-row ${bundle.receivedPieces ? "reception-followup-has-receipt" : ""}"
      data-search="${esc(normalize(indexed.join(" ")))}" data-has-receipt="${bundle.receivedPieces > 0 ? "1" : "0"}">
    <td><input class="form-check-input reception-followup-select" type="checkbox" value="${esc(request.id)}" ${checked ? "checked" : ""} aria-label="Seleccionar ${esc(folio)}"></td>
    <td><strong>${esc(folio)}</strong><div class="small ${alias ? "fw-semibold text-primary" : "text-muted"}">${alias ? esc(alias) : "Sin alias"}</div></td>
    <td>${esc(dateText(request.sentAt || request.createdAt))}</td>
    <td class="text-end">${bundle.receivedProductCount} / ${bundle.activeProducts}</td>
    <td class="text-end"><strong>${bundle.receivedPieces}</strong> / ${bundle.activePieces}</td>
    <td class="text-end">${bundle.pendingPieces}</td>
    <td>${progressHtml(bundle.pieceProgress)}</td>
    <td><span class="badge ${bundle.complete ? "text-bg-success" : bundle.receivedPieces ? "text-bg-warning text-dark" : "text-bg-secondary"}">${esc(bundle.label)}</span></td>
  </tr>`;
}
function renderSelector(rows, preserved = null, previousSearch = "") {
  const root = document.getElementById(`${PREFIX}Body`);
  if (!root) return;
  const totalReceived = rows.reduce((sum, row) => sum + row.receivedPieces, 0);
  const totalPending = rows.reduce((sum, row) => sum + row.pendingPieces, 0);
  const withReceipt = rows.filter(row => row.receivedPieces > 0).length;
  root.innerHTML = `
    <div class="reception-followup-summary mb-3">
      <div><span>SC registradas</span><strong>${rows.length}</strong></div>
      <div><span>SC con recepciones</span><strong class="text-success">${withReceipt}</strong></div>
      <div><span>Piezas recibidas</span><strong>${totalReceived}</strong></div>
      <div><span>Piezas pendientes</span><strong>${totalPending}</strong></div>
    </div>
    <div class="reception-followup-toolbar">
      <input class="form-control search-field" type="search" id="${PREFIX}Search"
        value="${esc(previousSearch)}" placeholder="Buscar SC, alias, nombre o SKU" autocomplete="off">
      <button type="button" class="btn btn-outline-dark btn-sm" id="${PREFIX}SelectVisible">Seleccionar visibles</button>
      <button type="button" class="btn btn-outline-success btn-sm" id="${PREFIX}SelectReceived">Sólo SC con recepciones</button>
      <button type="button" class="btn btn-outline-secondary btn-sm" id="${PREFIX}SelectNone">Deseleccionar todo</button>
    </div>
    <div class="reception-followup-help mt-2">
      El PDF detalla únicamente los SKU con piezas recibidas, incluso si aún falta parte del pedido.
      Las cantidades canceladas se excluyen de la base del porcentaje de avance.
      <span id="${PREFIX}VisibleCount"></span>
    </div>
    ${rows.length ? `<div class="table-responsive mt-3">
      <table class="table table-sm align-middle reception-followup-sc-table">
        <thead><tr>
          <th><input class="form-check-input" type="checkbox" id="${PREFIX}SelectAll" aria-label="Seleccionar todas las SC visibles"></th>
          <th>SC</th><th>Fecha</th><th class="text-end">SKU recibidos</th>
          <th class="text-end">Piezas recibidas</th><th class="text-end">Pendientes</th>
          <th>Avance piezas</th><th>Estado</th>
        </tr></thead>
        <tbody>${rows.map(row => selectorRow(row, preserved)).join("")}</tbody>
      </table>
    </div>` : `<div class="alert alert-light border mt-3">Aún no hay solicitudes enviadas para consultar.</div>`}`;
  applySearch(previousSearch);
}
async function openSelector({ force = true, preserve = false } = {}) {
  const modal = ensureModal();
  const prior = preserve && selectedOnce ? selectedIds() : null;
  const priorSearch = preserve ? String(document.getElementById(`${PREFIX}Search`)?.value || "") : "";
  const root = document.getElementById(`${PREFIX}Body`);
  root.innerHTML = `<div class="d-flex align-items-center justify-content-center gap-2 py-5 text-muted">
    <div class="spinner-border spinner-border-sm" role="status"></div>
    Calculando recepciones por SC…</div>`;
  modalInstance.show();
  try {
    const rows = await loadBundles({ force });
    renderSelector(rows, prior, priorSearch);
    selectedOnce = true;
  } catch (error) {
    console.error("Error al cargar seguimiento de recepciones:", error);
    root.innerHTML = `<div class="alert alert-danger">No se pudo cargar el reporte: ${esc(error.message)}</div>`;
  }
}
function overall(rows) {
  const sums = {
    sc: rows.length, scWithReceipt: 0, receivedProducts: 0, activeProducts: 0,
    receivedPieces: 0, activePieces: 0, pendingPieces: 0, estimatedRows: 0,
    totals: new Map(),
  };
  for (const row of rows) {
    if (row.receivedPieces > 0) sums.scWithReceipt += 1;
    sums.receivedProducts += row.receivedProductCount;
    sums.activeProducts += row.activeProducts;
    sums.receivedPieces += row.receivedPieces;
    sums.activePieces += row.activePieces;
    sums.pendingPieces += row.pendingPieces;
    sums.estimatedRows += row.estimatedRows;
    for (const [currency, entry] of row.totals) {
      mergeAmount(sums.totals, currency, entry.amount, entry.estimated);
    }
  }
  sums.progress = percent(sums.receivedPieces, sums.activePieces);
  return sums;
}
function pdfSummaryTable(rows) {
  return rows.map(row => {
    const request = row.request;
    const folio = request.folio || request.id;
    const alias = String(request.alias || "").trim();
    return `<tr>
      <td><strong>${esc(folio)}</strong>${alias ? `<div class="muted">${esc(alias)}</div>` : ""}</td>
      <td>${esc(dateText(request.sentAt || request.createdAt))}</td>
      <td class="num">${row.receivedProductCount} / ${row.activeProducts}</td>
      <td class="num">${row.receivedPieces} / ${row.activePieces}</td>
      <td class="num">${row.pendingPieces}</td>
      <td class="num">${percentText(row.pieceProgress)}</td>
      <td class="num">${esc(moneyText(row.totals))}</td>
      <td>${esc(row.label)}</td>
    </tr>`;
  }).join("");
}
function pdfDetailTable(row) {
  return row.receivedLines.map(line => {
    const requested = qty(line.quantityRequested);
    const received = qty(line.quantityReceived);
    const cancelled = qty(line.quantityCancelled);
    const pending = Math.max(requested - received - cancelled, 0);
    const cost = receivedCost(line);
    const average = received ? cost.amount / received : 0;
    const currency = String(line.currency || "MXN").toUpperCase();
    const approx = cost.estimated ? "≈ " : "";
    return `<tr>
      <td><strong>${esc(line.sku || "")}</strong></td>
      <td>${esc(line.nombre || "Item")}</td>
      <td>${esc(areaText(line) || "—")}</td>
      <td class="num">${requested}</td>
      <td class="num received"><strong>${received}</strong></td>
      <td class="num">${pending}</td>
      <td class="num">${esc(approx + currencyText(average, currency))}</td>
      <td class="num">${esc(approx + currencyText(cost.amount, currency))}</td>
      <td>${esc(dateText(line.lastReceivedAt, true))}</td>
    </tr>`;
  }).join("");
}
function pdfReceivedSections(rows) {
  const withReceipts = rows.filter(row => row.receivedLines.length);
  if (!withReceipts.length) return `<div class="empty-note">Ninguna de las SC seleccionadas tiene recepciones registradas.</div>`;
  return withReceipts.map(row => {
    const request = row.request;
    const folio = request.folio || request.id;
    const alias = String(request.alias || "").trim();
    return `<section class="sc-detail">
      <div class="detail-header">
        <div><div class="kicker">ARTÍCULOS RECIBIDOS</div>
          <h2>${esc(folio)}${alias ? ` · ${esc(alias)}` : ""}</h2>
          <div class="muted">${row.receivedProductCount} SKU · ${row.receivedPieces} piezas recibidas · ${row.pendingPieces} pendientes</div>
        </div>
        <div class="detail-total"><span>Importe de recepciones</span><strong>${esc(moneyText(row.totals))}</strong></div>
      </div>
      <table class="detail-table">
        <thead><tr>
          <th>SKU</th><th>Producto</th><th>Zona / subzona / área</th>
          <th class="num">Solicitado</th><th class="num">Recibido</th>
          <th class="num">Pendiente</th><th class="num">Costo real medio / pza.</th>
          <th class="num">Importe recibido</th><th>Última recepción</th>
        </tr></thead>
        <tbody>${pdfDetailTable(row)}</tbody>
      </table>
    </section>`;
  }).join("");
}
function generatePdf(rows) {
  // Se abre inmediatamente por la interacción del usuario para evitar bloqueos.
  const popup = window.open("", "_blank");
  if (!popup) {
    alert("El navegador bloqueó el reporte. Permite ventanas emergentes e inténtalo de nuevo.");
    return;
  }
  const all = overall(rows);
  const generated = new Date().toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
  popup.document.open();
  popup.document.write(`<!doctype html><html lang="es"><head>
<meta charset="utf-8">
<title>Seguimiento de recepciones por SC</title>
<style>
@page{size:A4 landscape;margin:9mm}
*{box-sizing:border-box;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
body{font-family:Arial,sans-serif;color:#1a1a1a;background:#fff;margin:0;font-size:8pt}
.toolbar{display:flex;gap:8px;justify-content:flex-end;padding:10px;border-bottom:1px solid #ddd}
.toolbar button{border:1px solid #aaa;padding:7px 12px;background:#fff;border-radius:4px;cursor:pointer}
header{border-bottom:3px solid #c8102e;padding-bottom:3mm;margin-bottom:4mm}
.kicker{font-weight:700;font-size:8pt;letter-spacing:.04em;color:#c8102e;text-transform:uppercase}
h1{font-size:21pt;margin:1mm 0}h2{font-size:13pt;margin:0 0 1mm}
.muted{color:#666;font-size:7.6pt}.note{padding:2.5mm 3mm;background:#f4f7fa;border-left:1.5mm solid #198754;margin:4mm 0}
.summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:2mm;margin:4mm 0}
.summary>div{border:1px solid #ddd;border-radius:2mm;padding:2.5mm}
.summary span{display:block;text-transform:uppercase;color:#666;font-size:7pt;font-weight:700}
.summary strong{display:block;font-size:14pt;margin-top:1mm}.summary .good{background:#f0fff6;border-color:#a3cfbb}
.value-list{border:1px solid #a3cfbb;background:#f6fffa;border-radius:2mm;padding:2mm 3mm;margin-bottom:5mm}
.value-list strong{font-size:11pt}
table{border-collapse:collapse;width:100%;font-size:7.2pt}
th,td{border:1px solid #d9d9d9;padding:1.3mm 1.5mm;vertical-align:top}
th{background:#f2f2f2;text-align:left}thead{display:table-header-group}tr{break-inside:avoid}
.num{text-align:right;white-space:nowrap}.received{color:#176b3a;background:#f0fff6}
.summary-table{margin-bottom:6mm}.sc-detail{margin:0 0 6mm}
.detail-header{display:flex;justify-content:space-between;gap:5mm;align-items:flex-start;padding:2.5mm 3mm;margin:3mm 0 2mm;background:#f0fff6;border-left:2mm solid #198754;break-after:avoid}
.detail-total{text-align:right;max-width:48%;min-width:35mm}.detail-total span{display:block;color:#666;font-size:7pt}.detail-total strong{display:block;font-size:10pt}
.detail-table{font-size:6.9pt}.detail-table td:nth-child(2){max-width:46mm}.detail-table td:nth-child(3){max-width:48mm}
.empty-note{padding:5mm;background:#f7f7f7;border:1px solid #ddd}.top-heading{font-size:13pt;margin:0 0 2mm}
@media print{.toolbar{display:none!important}}
</style></head><body>
<div class="toolbar"><button onclick="window.print()">Imprimir / Guardar PDF</button><button onclick="window.close()">Cerrar</button></div>
<main>
  <header>
    <div class="kicker">Universidad Iberoamericana Ciudad de México · FabLab</div>
    <h1>Seguimiento de recepciones por SC</h1>
    <div class="muted">Generado: ${esc(generated)} · ${all.sc} SC seleccionadas</div>
  </header>
  <div class="note"><strong>Criterio:</strong> el detalle incluye solamente artículos con al menos una pieza recibida.
    Se muestran cantidades acumuladas por SKU/SC, incluyendo recepciones parciales; "Última recepción" no representa el historial de entregas individuales.
    El avance de piezas excluye las canceladas.
    ${all.estimatedRows ? `<strong>≈</strong> indica importes reconstruidos en ${all.estimatedRows} SKU antiguos sin costo real acumulado registrado.` : ""}
  </div>
  <div class="summary">
    <div><span>SC seleccionadas</span><strong>${all.sc}</strong></div>
    <div class="good"><span>SC con recepciones</span><strong>${all.scWithReceipt}</strong></div>
    <div><span>SKU recibidos</span><strong>${all.receivedProducts}</strong></div>
    <div class="good"><span>Piezas recibidas</span><strong>${all.receivedPieces}</strong></div>
    <div><span>Piezas pendientes</span><strong>${all.pendingPieces}</strong></div>
  </div>
  <div class="value-list"><span>Importe de artículos recibidos:</span> <strong>${esc(moneyText(all.totals))}</strong></div>
  <h2 class="top-heading">Resumen por SC</h2>
  <table class="summary-table">
    <thead><tr><th>SC</th><th>Fecha</th><th class="num">SKU recibidos</th>
      <th class="num">Piezas recibidas</th><th class="num">Piezas pendientes</th>
      <th class="num">Avance</th><th class="num">Importe recibido</th><th>Estado</th></tr></thead>
    <tbody>${pdfSummaryTable(rows)}</tbody>
  </table>
  <h2 class="top-heading">Detalle de lo que ya llegó</h2>
  ${pdfReceivedSections(rows)}
</main>
<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),300));<\/script>
</body></html>`);
  popup.document.close();
}
function bindEvents() {
  document.addEventListener("click", event => {
    const target = event.target;
    if (!target?.closest) return;
    if (target.closest(`#${BUTTON_ID}`)) { void openSelector({ force: true }); return; }
    if (target.closest(`#${PREFIX}Refresh`)) { void openSelector({ force: true, preserve: true }); return; }
    if (target.closest(`#${PREFIX}SelectVisible`)) { selectRows("visible-check"); return; }
    if (target.closest(`#${PREFIX}SelectReceived`)) { selectRows("only-received"); return; }
    if (target.closest(`#${PREFIX}SelectNone`)) { selectRows("all-clear"); return; }
    if (target.closest(`#${PREFIX}GeneratePdf`)) {
      const rows = selectedBundles();
      if (!rows.length) { alert("Selecciona al menos una SC."); return; }
      generatePdf(rows);
    }
  });
  document.addEventListener("input", event => {
    if (event.target?.id === `${PREFIX}Search`) applySearch(event.target.value);
  });
  document.addEventListener("change", event => {
    if (event.target?.classList?.contains("reception-followup-select")) {
      updateSelectionMeta();
    } else if (event.target?.id === `${PREFIX}SelectAll`) {
      selectRows(event.target.checked ? "visible-check" : "visible-clear");
    }
  });
  document.addEventListener("shown.bs.offcanvas", event => {
    if (event.target?.id === "purchaseRequestsPanel") attachButton();
  });
}
async function init() {
  const user = await waitForUser();
  if (!user) return;
  const profile = await getUserProfile(user.uid);
  const role = profile?.appRole || profile?.role || "";
  if (!ALLOWED_ROLES.has(role)) return;
  injectStyles();
  ensureModal();
  bindEvents();
  startAttach();
}
init().catch(error => console.error("No se pudo iniciar seguimiento de recepciones:", error));
