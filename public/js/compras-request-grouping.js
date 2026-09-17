import { db } from "./firebase-app.js";
import { fileViewUrl } from "./common.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const detailState = new WeakMap();
const requestCache = new Map();
let historyObserver = null;
let historyWaitTimer = null;

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
    num(line?.quantityRequested) -
      num(line?.quantityReceived) -
      num(line?.quantityCancelled),
    0
  );
}

function lineActualSpent(line) {
  if (Object.prototype.hasOwnProperty.call(line || {}, "actualCostTotal")) {
    return Math.max(num(line.actualCostTotal), 0);
  }
  return Math.max(num(line?.quantityReceived) * num(line?.unitPrice), 0);
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
    return `${code} ${num(value).toFixed(2)}`;
  }
}

function formatCurrencyWithCode(value, currency = "MXN") {
  const code = String(currency || "MXN").toUpperCase();
  return `${formatCurrency(value, code)} ${code}`;
}

function priorityLabel(priority) {
  const p = Number(priority);
  if (p === 1) return "Prioridad 1 · Alta";
  if (p === 2) return "Prioridad 2 · Media";
  return "Prioridad 3 · Normal";
}

function requestDateValue(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function requestDateText(value) {
  const date = requestDateValue(value);
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
  return labels[status] || status || "Sin estado";
}

function requestSortModeFromRequest(request) {
  const snapshot = Array.isArray(request?.filtersSnapshot)
    ? request.filtersSnapshot
    : [];
  const saved = snapshot.find(
    filter =>
      String(filter?.label || "").trim().toLocaleLowerCase("es-MX") ===
      "orden de solicitud"
  );
  const label = String(saved?.value || "").toLocaleLowerCase("es-MX");

  if (label.includes("nombre")) return "nombre";
  if (label.includes("sku")) return "sku";
  if (label.includes("tipo")) return "tipo";
  if (label.includes("precio") && label.includes("alto")) return "precio_desc";
  if (label.includes("precio") && label.includes("bajo")) return "precio_asc";
  if (label.includes("prioridad")) return "priority";
  return "zone";
}

function compareRequestLines(a, b, mode = "zone") {
  const text = value => String(value || "");
  const locale = (left, right, numeric = false) =>
    text(left).localeCompare(text(right), "es", {
      numeric,
      sensitivity: "base",
    });
  const fallback = () =>
    locale(a.sku, b.sku, true) || locale(a.nombre, b.nombre);

  if (mode === "nombre") return locale(a.nombre, b.nombre) || fallback();
  if (mode === "sku")
    return locale(a.sku, b.sku, true) || locale(a.nombre, b.nombre);
  if (mode === "tipo")
    return locale(a.tipo, b.tipo) || locale(a.nombre, b.nombre) || fallback();
  if (mode === "precio_desc")
    return num(b.unitPrice) - num(a.unitPrice) || fallback();
  if (mode === "precio_asc")
    return num(a.unitPrice) - num(b.unitPrice) || fallback();
  if (mode === "priority")
    return (
      (num(a.priority) || 3) - (num(b.priority) || 3) ||
      locale(a.nombre, b.nombre) ||
      fallback()
    );

  return (
    locale(a.zoneId, b.zoneId, true) ||
    locale(a.subzoneId, b.subzoneId, true) ||
    locale(
      a.locationCode || a.locationId,
      b.locationCode || b.locationId,
      true
    ) ||
    fallback()
  );
}

function sortRequestLines(lines, request) {
  const mode = requestSortModeFromRequest(request);
  return [...lines].sort((a, b) => compareRequestLines(a, b, mode));
}

async function fetchRequestBundle(requestId, { force = false } = {}) {
  if (!force && requestCache.has(requestId)) return requestCache.get(requestId);

  const requestRef = doc(db, "purchaseRequests", requestId);
  const linesRef = collection(db, "purchaseRequests", requestId, "items");

  const [requestSnap, linesSnap] = await Promise.all([
    getDoc(requestRef),
    getDocs(linesRef),
  ]);

  if (!requestSnap.exists()) {
    throw new Error("La solicitud ya no existe.");
  }

  const request = { id: requestSnap.id, ...requestSnap.data() };
  const lines = sortRequestLines(
    linesSnap.docs.map(lineDoc => ({ id: lineDoc.id, ...lineDoc.data() })),
    request
  );

  const bundle = { request, lines };
  requestCache.set(requestId, bundle);
  return bundle;
}

function groupRequestLines(lines) {
  const groups = new Map();

  lines.forEach((line, index) => {
    const name = String(line.nombre || "").trim();
    const key =
      normalizeName(name) ||
      `__sin_nombre__${String(line.sku || line.id || index)}`;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        nombre: name || line.sku || "Item",
        representative: line,
        lines: [],
        quantityRequested: 0,
        quantityReceived: 0,
        quantityCancelled: 0,
        pending: 0,
        expectedTotal: 0,
        actualSpent: 0,
        priorities: new Set(),
        currencies: new Set(),
        unitPrices: new Set(),
        descriptions: new Set(),
        infoUrls: new Set(),
        purchaseUrls: new Set(),
      });
    }

    const group = groups.get(key);
    group.lines.push(line);
    group.quantityRequested += num(line.quantityRequested);
    group.quantityReceived += num(line.quantityReceived);
    group.quantityCancelled += num(line.quantityCancelled);
    group.pending += linePendingQty(line);
    group.expectedTotal += num(line.quantityRequested) * num(line.unitPrice);
    group.actualSpent += lineActualSpent(line);
    group.priorities.add(num(line.priority) || 3);
    group.currencies.add(String(line.currency || "MXN").toUpperCase());
    group.unitPrices.add(
      `${String(line.currency || "MXN").toUpperCase()}|${num(line.unitPrice)}`
    );
    if (String(line.descripcion || "").trim())
      group.descriptions.add(String(line.descripcion).trim());
    if (String(line.infoUrl || "").trim())
      group.infoUrls.add(String(line.infoUrl).trim());
    if (String(line.purchaseUrl || "").trim())
      group.purchaseUrls.add(String(line.purchaseUrl).trim());
  });

  return [...groups.values()];
}

function uniqueLinksHtml(urlSet, baseLabel) {
  const urls = [...urlSet];
  if (!urls.length) return "";
  return urls
    .map(
      (url, index) =>
        `<a class="btn btn-outline-success btn-sm" href="${escapeHtml(
          url
        )}" target="_blank" rel="noopener">${
          urls.length === 1
            ? escapeHtml(baseLabel)
            : `${escapeHtml(baseLabel)} ${index + 1}`
        }</a>`
    )
    .join("");
}

function groupUnitPriceText(group) {
  if (group.unitPrices.size !== 1) return "Precios unitarios distintos";
  const [entry] = [...group.unitPrices];
  const [currency, value] = entry.split("|");
  return formatCurrencyWithCode(Number(value), currency);
}

function groupPriorityText(group) {
  const priorities = [...group.priorities].sort((a, b) => a - b);
  if (priorities.length === 1) return priorityLabel(priorities[0]);
  return `Prioridades ${priorities.join(", ")}`;
}

function groupDescriptionHtml(group) {
  const descriptions = [...group.descriptions];
  if (!descriptions.length) return "";
  if (descriptions.length === 1) {
    return `<p class="mb-3">${escapeHtml(descriptions[0])}</p>`;
  }
  return `
    <p class="mb-2">${escapeHtml(descriptions[0])}</p>
    <div class="small text-muted mb-3">Hay ${descriptions.length} descripciones distintas entre los registros agrupados.</div>`;
}

function breakdownTableHtml(group, { pdf = false } = {}) {
  return `
    <div class="table-responsive mt-3">
      <table class="table table-sm align-middle grouped-breakdown-table ${pdf ? "pdf-breakdown-table" : ""}">
        <thead>
          <tr>
            <th>SKU</th>
            <th>Zona</th>
            <th>Subzona</th>
            <th>Área solicitante</th>
            <th class="text-end">Solicitado</th>
            <th class="text-end">Recibido</th>
            <th class="text-end">Cancelado</th>
            <th class="text-end">Pendiente</th>
          </tr>
        </thead>
        <tbody>
          ${group.lines
            .map(
              line => `
            <tr>
              <td><strong>${escapeHtml(line.sku || "")}</strong></td>
              <td>${escapeHtml(
                `${line.zoneId || ""}${line.zoneName ? ` · ${line.zoneName}` : ""}`
              )}</td>
              <td>${escapeHtml(
                `${line.subzoneId || ""}${
                  line.subzoneName ? ` · ${line.subzoneName}` : ""
                }`
              )}</td>
              <td>${escapeHtml(
                `${line.locationCode || line.locationId || ""}${
                  line.locationName ? ` · ${line.locationName}` : ""
                }`
              )}</td>
              <td class="text-end">${num(line.quantityRequested)}</td>
              <td class="text-end">${num(line.quantityReceived)}</td>
              <td class="text-end">${num(line.quantityCancelled)}</td>
              <td class="text-end"><strong>${linePendingQty(line)}</strong></td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function groupedDetailHtml(request, lines) {
  const groups = groupRequestLines(lines);
  return `
    <div class="alert alert-light border py-2 small">
      <strong>Vista agrupada por nombre.</strong>
      ${groups.length} producto${groups.length === 1 ? "" : "s"} agrupado${
        groups.length === 1 ? "" : "s"
      } a partir de ${lines.length} línea${lines.length === 1 ? "" : "s"} / SKU.
      Para registrar recepciones o cancelaciones individuales usa <strong>Vista extendida</strong>.
    </div>

    ${groups
      .map(group => {
        const rep = group.representative;
        const currencies = [...group.currencies];
        const currencyText =
          currencies.length === 1 ? currencies[0] : "varias monedas";
        return `
          <article class="request-line-row grouped-request-card">
            <div class="d-flex flex-wrap justify-content-between gap-3 align-items-start">
              <div class="flex-grow-1">
                <div class="request-line-title fs-5">${escapeHtml(group.nombre)}</div>
                <div class="request-line-meta mt-1">
                  ${group.lines.length} registro${group.lines.length === 1 ? "" : "s"} ·
                  ${escapeHtml(groupPriorityText(group))}
                </div>
              </div>
              <div class="text-end">
                <div><strong>Total solicitado:</strong> ${group.quantityRequested}</div>
                <div><strong>Recibido:</strong> ${group.quantityReceived}</div>
                <div><strong>Cancelado:</strong> ${group.quantityCancelled}</div>
                <div><strong>Pendiente:</strong> ${group.pending}</div>
              </div>
            </div>

            <div class="row g-2 mt-2">
              <div class="col-lg-4">
                <div class="border rounded p-2 h-100">
                  <div class="small text-muted">Precio unitario</div>
                  <strong>${escapeHtml(groupUnitPriceText(group))}</strong>
                </div>
              </div>
              <div class="col-lg-4">
                <div class="border rounded p-2 h-100">
                  <div class="small text-muted">Importe esperado agrupado</div>
                  <strong>${
                    currencies.length === 1
                      ? escapeHtml(
                          formatCurrencyWithCode(group.expectedTotal, currencies[0])
                        )
                      : escapeHtml(`${group.expectedTotal.toFixed(2)} · ${currencyText}`)
                  }</strong>
                </div>
              </div>
              <div class="col-lg-4">
                <div class="border rounded p-2 h-100">
                  <div class="small text-muted">Gasto real recibido</div>
                  <strong>${
                    currencies.length === 1
                      ? escapeHtml(
                          formatCurrencyWithCode(group.actualSpent, currencies[0])
                        )
                      : escapeHtml(`${group.actualSpent.toFixed(2)} · ${currencyText}`)
                  }</strong>
                </div>
              </div>
            </div>

            <div class="mt-3">
              ${groupDescriptionHtml(group)}
              <div class="d-flex flex-wrap gap-2">
                ${uniqueLinksHtml(group.infoUrls, "Más info")}
                ${uniqueLinksHtml(group.purchaseUrls, "Info Compra")}
              </div>
            </div>

            <div class="mt-3">
              <div class="fw-semibold">Desglose por SKU y área solicitante</div>
              ${breakdownTableHtml(group)}
            </div>
          </article>`;
      })
      .join("")}`;
}

function requestViewToolbarHtml(mode) {
  return `
    <div id="requestGroupingToolbar" class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
      <div>
        <div class="fw-semibold">Visualización de la solicitud</div>
        <div class="small text-muted">La vista agrupada consolida registros con el mismo nombre.</div>
      </div>
      <div class="btn-group" role="group" aria-label="Vista de solicitud">
        <button type="button" class="btn btn-sm ${
          mode === "extended" ? "btn-dark" : "btn-outline-dark"
        } request-view-mode" data-mode="extended">Vista extendida</button>
        <button type="button" class="btn btn-sm ${
          mode === "grouped" ? "btn-dark" : "btn-outline-dark"
        } request-view-mode" data-mode="grouped">Vista agrupada</button>
      </div>
    </div>`;
}

function renderDetailMode(body, mode) {
  const state = detailState.get(body);
  if (!state) return;

  state.mode = mode;
  localStorage.setItem("purchaseRequestViewMode", mode);

  const toolbar = body.querySelector("#requestGroupingToolbar");
  if (toolbar) toolbar.outerHTML = requestViewToolbarHtml(mode);

  const content = body.querySelector("#requestGroupingContent");
  if (!content) return;

  if (mode === "grouped") {
    content.innerHTML = groupedDetailHtml(state.request, state.lines);
  } else {
    content.innerHTML = state.extendedHtml;
  }
}

async function enhanceRequestDetailModal(modalEl) {
  const body = modalEl.querySelector("#purchaseRequestDetailBody");
  const pdfButton = modalEl.querySelector("#purchaseRequestDetailPdf");
  const requestId = String(pdfButton?.dataset?.requestId || "");
  if (!body || !requestId) return;

  // Si el modal sólo vuelve a mostrarse después de cerrar el cuadro de
  // recepción/cancelación, no volvemos a envolver la vista sobre sí misma.
  if (body.querySelector("#requestGroupingToolbar") && body.querySelector("#requestGroupingContent")) {
    return;
  }

  let bundle;
  try {
    bundle = await fetchRequestBundle(requestId, { force: true });
  } catch (error) {
    console.error("No se pudo preparar la vista agrupada:", error);
    return;
  }

  // openRequestDetail() acaba de generar el HTML extendido. Lo conservamos
  // íntegro para que sus botones operativos sigan funcionando al volver.
  const extendedHtml = body.innerHTML;
  const savedMode =
    localStorage.getItem("purchaseRequestViewMode") === "grouped"
      ? "grouped"
      : "extended";

  detailState.set(body, {
    requestId,
    request: bundle.request,
    lines: bundle.lines,
    extendedHtml,
    mode: savedMode,
  });

  body.innerHTML = `
    ${requestViewToolbarHtml(savedMode)}
    <div id="requestGroupingContent"></div>`;

  renderDetailMode(body, savedMode);

  pdfButton.textContent = "PDF extendido";

  const footer = modalEl.querySelector(".modal-footer");
  if (footer && !footer.querySelector("#purchaseRequestDetailPdfGrouped")) {
    const groupedPdf = document.createElement("button");
    groupedPdf.type = "button";
    groupedPdf.id = "purchaseRequestDetailPdfGrouped";
    groupedPdf.className = "btn btn-outline-danger";
    groupedPdf.textContent = "PDF agrupado";
    groupedPdf.dataset.requestId = requestId;
    footer.insertBefore(groupedPdf, pdfButton.nextSibling);
  } else {
    const groupedPdf = footer?.querySelector("#purchaseRequestDetailPdfGrouped");
    if (groupedPdf) groupedPdf.dataset.requestId = requestId;
  }
}

function decorateHistoryPdfButtons() {
  const history = document.querySelector("#purchaseRequestHistory");
  if (!history) return;

  history.querySelectorAll(".request-history-pdf").forEach(button => {
    const requestId = String(button.dataset.requestId || "");
    if (!requestId) return;

    // Importante: no tocar repetidamente textContent. Cada asignación crea
    // mutaciones DOM y, si el MutationObserver las vuelve a observar, puede
    // generarse un ciclo infinito que congela compras.html.
    if (button.dataset.groupingDecorated === "1") return;
    button.dataset.groupingDecorated = "1";

    if (button.textContent !== "PDF extendido") {
      button.textContent = "PDF extendido";
    }

    const actions = button.parentElement;
    if (!actions) return;

    const existing = actions.querySelector(
      `.request-history-pdf-grouped[data-request-id="${CSS.escape(requestId)}"]`
    );
    if (existing) return;

    const grouped = document.createElement("button");
    grouped.type = "button";
    grouped.className = "btn btn-outline-danger btn-sm request-history-pdf-grouped";
    grouped.dataset.requestId = requestId;
    grouped.textContent = "PDF agrupado";
    button.insertAdjacentElement("afterend", grouped);
  });
}

function mutationContainsPurchasePdf(mutation) {
  return [...mutation.addedNodes].some(node => {
    if (!(node instanceof Element)) return false;
    return node.matches?.(".request-history-pdf") || Boolean(node.querySelector?.(".request-history-pdf"));
  });
}

function startHistoryDecoration() {
  const attach = () => {
    const history = document.querySelector("#purchaseRequestHistory");
    if (!history) return false;

    decorateHistoryPdfButtons();

    if (!historyObserver) {
      historyObserver = new MutationObserver(mutations => {
        // Sólo reaccionamos cuando el render base agrega nuevos botones PDF.
        // La inserción de nuestro propio botón "PDF agrupado" se ignora.
        if (mutations.some(mutationContainsPurchasePdf)) {
          decorateHistoryPdfButtons();
        }
      });
      historyObserver.observe(history, { childList: true, subtree: true });
    }
    return true;
  };

  if (attach()) return;

  let attempts = 0;
  historyWaitTimer = window.setInterval(() => {
    attempts += 1;
    if (attach() || attempts >= 60) {
      clearInterval(historyWaitTimer);
      historyWaitTimer = null;
    }
  }, 250);
}

function pdfGroupCardHtml(group) {
  const rep = group.representative;
  const imageSrc = rep.imageFileId
    ? fileViewUrl(rep.imageFileId)
    : "assets/placeholder.svg";
  const currencies = [...group.currencies];
  const singleCurrency = currencies.length === 1 ? currencies[0] : null;

  return `
    <article class="group-card">
      <div class="group-image">
        <img src="${escapeHtml(imageSrc)}" alt="${escapeHtml(group.nombre)}">
      </div>
      <div class="group-content">
        <div class="group-head">
          <div>
            <h2>${escapeHtml(group.nombre)}</h2>
            <div class="muted">${group.lines.length} registro${
              group.lines.length === 1 ? "" : "s"
            } / SKU · ${escapeHtml(groupPriorityText(group))}</div>
          </div>
          <div class="qty-box">
            <span>Total solicitado</span>
            <strong>${group.quantityRequested}</strong>
          </div>
        </div>

        <div class="summary-row">
          <div><span>Precio unitario</span><strong>${escapeHtml(
            groupUnitPriceText(group)
          )}</strong></div>
          <div><span>Importe esperado</span><strong>${
            singleCurrency
              ? escapeHtml(
                  formatCurrencyWithCode(group.expectedTotal, singleCurrency)
                )
              : escapeHtml(`${group.expectedTotal.toFixed(2)} · varias monedas`)
          }</strong></div>
          <div><span>Gasto real recibido</span><strong>${
            singleCurrency
              ? escapeHtml(formatCurrencyWithCode(group.actualSpent, singleCurrency))
              : escapeHtml(`${group.actualSpent.toFixed(2)} · varias monedas`)
          }</strong></div>
          <div><span>Pendiente</span><strong>${group.pending}</strong></div>
        </div>

        ${groupDescriptionHtml(group)}

        <div class="links">
          ${uniqueLinksHtml(group.infoUrls, "Más info")}
          ${uniqueLinksHtml(group.purchaseUrls, "Info Compra")}
        </div>

        <h3>Desglose por SKU y área solicitante</h3>
        ${breakdownTableHtml(group, { pdf: true })}
      </div>
    </article>`;
}

async function exportGroupedPdf(requestId) {
  // Abrimos la ventana inmediatamente para no perder el gesto del usuario
  // mientras se consulta Firestore.
  const popup = window.open("", "_blank");
  if (!popup) {
    alert(
      "El navegador bloqueó la ventana del reporte. Permite ventanas emergentes e inténtalo nuevamente."
    );
    return;
  }

  popup.document.write(
    `<!doctype html><html><body style="font-family:Arial;padding:24px">Preparando PDF agrupado…</body></html>`
  );
  popup.document.close();

  try {
    const { request, lines } = await fetchRequestBundle(requestId, {
      force: true,
    });
    if (!lines.length) throw new Error("La solicitud no contiene líneas.");

    const groups = groupRequestLines(lines);
    const totalQty = groups.reduce(
      (sum, group) => sum + group.quantityRequested,
      0
    );
    const totalExpectedByCurrency = new Map();
    const actualByCurrency = new Map();

    groups.forEach(group => {
      group.lines.forEach(line => {
        const currency = String(line.currency || "MXN").toUpperCase();
        totalExpectedByCurrency.set(
          currency,
          num(totalExpectedByCurrency.get(currency)) +
            num(line.quantityRequested) * num(line.unitPrice)
        );
        actualByCurrency.set(
          currency,
          num(actualByCurrency.get(currency)) + lineActualSpent(line)
        );
      });
    });

    const moneyMapText = map =>
      [...map.entries()]
        .map(([currency, amount]) => formatCurrencyWithCode(amount, currency))
        .join(" · ") || formatCurrencyWithCode(0, "MXN");

    const filters = Array.isArray(request.filtersSnapshot)
      ? request.filtersSnapshot
      : [];
    const created = requestDateText(request.sentAt || request.createdAt);
    const folio = request.folio || request.id;

    popup.document.open();
    popup.document.write(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<base href="${escapeHtml(document.baseURI)}">
<title>${escapeHtml(folio)} · Solicitud agrupada</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
<style>
@page{size:A4 landscape;margin:9mm}
*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;box-sizing:border-box}
body{font-family:Arial,sans-serif;color:#171717;margin:0;background:#fff}
.toolbar{display:flex;justify-content:flex-end;gap:8px;padding:10px;border-bottom:1px solid #ddd}
.page{padding:0}
header{border-bottom:3px solid #c8102e;padding-bottom:4mm;margin-bottom:5mm}
.kicker{font-size:9pt;font-weight:700;color:#c8102e;text-transform:uppercase}
h1{font-size:22pt;margin:1mm 0}
.meta{display:flex;gap:8mm;flex-wrap:wrap;font-size:9pt;color:#555}
.top-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm;margin:4mm 0}
.top-summary>div{border:1px solid #ddd;border-radius:2mm;padding:3mm}
.top-summary span,.summary-row span{display:block;color:#666;font-size:7.5pt;text-transform:uppercase;font-weight:700}
.top-summary strong{display:block;margin-top:1mm;font-size:12pt}
.filters{display:flex;flex-wrap:wrap;gap:2mm;margin-bottom:5mm}
.filter{border:1px solid #ddd;border-radius:99px;padding:1.5mm 2.5mm;font-size:8pt}
.group-card{display:grid;grid-template-columns:40mm 1fr;border:1.5px solid #d9dde3;border-left:2mm solid #212529;border-radius:2mm;margin-bottom:5mm;break-inside:avoid;overflow:hidden}
.group-image{display:flex;align-items:flex-start;justify-content:center;border-right:1px solid #eee;padding:3mm}
.group-image img{max-width:100%;max-height:48mm;object-fit:contain}
.group-content{padding:3.5mm}
.group-head{display:flex;justify-content:space-between;gap:4mm;align-items:flex-start}
.group-head h2{font-size:15pt;margin:0 0 1mm}
.muted{color:#666;font-size:8.5pt}
.qty-box{border:1px solid #ddd;border-radius:2mm;padding:2mm 3mm;text-align:right;min-width:29mm}
.qty-box span{display:block;color:#666;font-size:7pt;text-transform:uppercase}
.qty-box strong{font-size:18pt}
.summary-row{display:grid;grid-template-columns:repeat(4,1fr);gap:2mm;margin:3mm 0}
.summary-row>div{border:1px solid #eee;background:#fafafa;border-radius:1.5mm;padding:2mm}
.summary-row strong{display:block;margin-top:.8mm;font-size:8.5pt}
.group-content p{font-size:9pt;margin:2mm 0}
.links{display:flex;gap:2mm;flex-wrap:wrap;margin:2mm 0}
.links a{border:1px solid #198754;border-radius:99px;padding:1.4mm 2.5mm;text-decoration:none;color:#176b3a;font-size:8pt}
h3{font-size:9.5pt;margin:3mm 0 1mm}
.pdf-breakdown-table{width:100%;border-collapse:collapse;font-size:7.5pt}
.pdf-breakdown-table th,.pdf-breakdown-table td{border:1px solid #ddd;padding:1.4mm;vertical-align:top}
.pdf-breakdown-table th{background:#f6f6f6}
.text-end{text-align:right}
@media print{.toolbar{display:none!important}}
</style>
</head>
<body>
<div class="toolbar">
  <button onclick="window.print()">Imprimir / Guardar PDF</button>
  <button onclick="window.close()">Cerrar</button>
</div>
<main class="page">
<header>
  <div class="kicker">Universidad Iberoamericana Ciudad de México · FabLab</div>
  <h1>Solicitud de compra ${escapeHtml(folio)} · Vista agrupada</h1>
  <div class="meta">
    <span><strong>Estado:</strong> ${escapeHtml(
      requestStatusLabel(request.status)
    )}</span>
    <span><strong>Fecha:</strong> ${escapeHtml(created)}</span>
    <span><strong>Productos agrupados:</strong> ${groups.length}</span>
    <span><strong>Líneas / SKU:</strong> ${lines.length}</span>
  </div>
</header>

<section class="top-summary">
  <div><span>Productos agrupados</span><strong>${groups.length}</strong></div>
  <div><span>Piezas solicitadas</span><strong>${totalQty}</strong></div>
  <div><span>Importe esperado</span><strong>${escapeHtml(
    moneyMapText(totalExpectedByCurrency)
  )}</strong></div>
  <div><span>Gasto real recibido</span><strong>${escapeHtml(
    moneyMapText(actualByCurrency)
  )}</strong></div>
</section>

${
  filters.length
    ? `<section class="filters">${filters
        .map(
          filter =>
            `<span class="filter"><strong>${escapeHtml(
              filter.label
            )}:</strong> ${escapeHtml(filter.value)}</span>`
        )
        .join("")}</section>`
    : ""
}

<section>
  ${groups.map(pdfGroupCardHtml).join("")}
</section>
</main>
<script>
window.addEventListener("load",async()=>{
  const waits=Array.from(document.images).map(img=>img.complete?Promise.resolve():new Promise(r=>{img.onload=r;img.onerror=r}));
  await Promise.all(waits);
  setTimeout(()=>window.print(),350);
});
<\/script>
</body>
</html>`);
    popup.document.close();
  } catch (error) {
    console.error(error);
    popup.document.open();
    popup.document.write(
      `<h2>No se pudo generar el PDF agrupado</h2><p>${escapeHtml(
        error.message
      )}</p>`
    );
    popup.document.close();
  }
}

document.addEventListener("shown.bs.modal", event => {
  const modal = event.target;
  if (modal?.id === "purchaseRequestDetailModal") {
    enhanceRequestDetailModal(modal);
  }
});

document.addEventListener("shown.bs.offcanvas", event => {
  if (event.target?.id === "purchaseRequestsPanel") {
    decorateHistoryPdfButtons();
  }
});

document.addEventListener("click", async event => {
  const modeButton = event.target.closest(".request-view-mode");
  if (modeButton) {
    const body = document.querySelector("#purchaseRequestDetailBody");
    if (body) renderDetailMode(body, modeButton.dataset.mode || "extended");
    return;
  }

  const groupedHistoryPdf = event.target.closest(".request-history-pdf-grouped");
  if (groupedHistoryPdf) {
    await exportGroupedPdf(groupedHistoryPdf.dataset.requestId);
    return;
  }

  const groupedDetailPdf = event.target.closest("#purchaseRequestDetailPdfGrouped");
  if (groupedDetailPdf) {
    await exportGroupedPdf(groupedDetailPdf.dataset.requestId);
  }
});

startHistoryDecoration();
