import { db } from "./firebase-app.js";
import {
  collection,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const GLOBAL_MODAL_ID = "purchaseGlobalProgressModal";
const GLOBAL_BODY_ID = "purchaseGlobalProgressBody";
const CHARTS_ID = "purchaseGlobalMoneyCharts";
const SECONDARY_TITLE_ID = "purchaseGlobalSecondaryTitle";
const STYLE_ID = "purchaseGlobalMoneyChartsStyles";

let renderBusy = false;
let bodyObserver = null;
let observedBody = null;
let renderSequence = 0;

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

function normalizeCurrency(value) {
  return String(value || "MXN").trim().toUpperCase() || "MXN";
}

function formatCurrency(value, currency = "MXN") {
  const code = normalizeCurrency(currency);

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
  const code = normalizeCurrency(currency);
  return `${formatCurrency(value, code)} ${code}`;
}

function percent(part, total) {
  const denominator = num(total);
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(100, (num(part) / denominator) * 100));
}

function percentText(part, total) {
  return `${percent(part, total).toLocaleString("es-MX", {
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

function linePendingQty(line) {
  return Math.max(
    num(line?.quantityRequested)
      - num(line?.quantityReceived)
      - num(line?.quantityCancelled),
    0
  );
}

function lineActualSpent(line) {
  if (Object.prototype.hasOwnProperty.call(line || {}, "actualCostTotal")) {
    return Math.max(num(line.actualCostTotal), 0);
  }

  return Math.max(
    num(line?.quantityReceived) * num(line?.unitPrice),
    0
  );
}

function linePendingUnitCost(line) {
  if (line?.requisitionStatus === "requisitioned") {
    return Math.max(
      num(line?.requisitionUnitCost ?? line?.unitPrice),
      0
    );
  }

  return Math.max(num(line?.unitPrice), 0);
}

function createCurrencyStage() {
  return {
    ordered: 0,
    requisition: 0,
    received: 0,
    total: 0,
  };
}

function summarizeMoney(lines) {
  const currencies = new Map();

  for (const line of lines || []) {
    const currency = normalizeCurrency(line.currency);
    const pending = linePendingQty(line);
    const receivedAmount = lineActualSpent(line);
    const pendingAmount = pending * linePendingUnitCost(line);

    if (!currencies.has(currency)) {
      currencies.set(currency, createCurrencyStage());
    }

    const stage = currencies.get(currency);

    if (receivedAmount > 0) {
      stage.received += receivedAmount;
    }

    if (pendingAmount > 0) {
      if (line.requisitionStatus === "requisitioned") {
        stage.requisition += pendingAmount;
      } else {
        stage.ordered += pendingAmount;
      }
    }

    stage.total =
      stage.ordered
      + stage.requisition
      + stage.received;
  }

  return currencies;
}

function mergeSummary(target, source) {
  for (const [currency, stage] of source.entries()) {
    if (!target.has(currency)) {
      target.set(currency, createCurrencyStage());
    }

    const current = target.get(currency);
    current.ordered += num(stage.ordered);
    current.requisition += num(stage.requisition);
    current.received += num(stage.received);
    current.total =
      current.ordered
      + current.requisition
      + current.received;
  }
}

async function fetchRequestLines(requestId) {
  const snapshot = await getDocs(
    collection(
      db,
      "purchaseRequests",
      requestId,
      "items"
    )
  );

  return snapshot.docs.map(lineDoc => ({
    id: lineDoc.id,
    ...lineDoc.data(),
  }));
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from(
    {
      length: Math.min(limit, Math.max(items.length, 1)),
    },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) break;
        results[index] = await worker(items[index], index);
      }
    }
  );

  await Promise.all(runners);
  return results;
}

async function loadMonetaryBundles() {
  const requestSnapshot = await getDocs(
    collection(db, "purchaseRequests")
  );

  const requests = requestSnapshot.docs
    .map(requestDoc => ({
      id: requestDoc.id,
      ...requestDoc.data(),
    }))
    .filter(request => request.status !== "draft")
    .sort((a, b) => {
      const da =
        timestampToDate(a.sentAt || a.createdAt)?.getTime() || 0;

      const dbv =
        timestampToDate(b.sentAt || b.createdAt)?.getTime() || 0;

      return dbv - da;
    });

  return mapLimit(
    requests,
    6,
    async request => {
      const lines = await fetchRequestLines(request.id);
      return {
        request,
        money: summarizeMoney(lines),
      };
    }
  );
}

function stageLegendHtml(stage, currency) {
  return `
    <div class="global-money-legend">
      <div class="global-money-legend-item">
        <span class="global-money-dot ordered"></span>
        <div>
          <span>Por requisitar</span>
          <strong>${escapeHtml(formatCurrencyWithCode(stage.ordered, currency))}</strong>
          <small>${percentText(stage.ordered, stage.total)}</small>
        </div>
      </div>

      <div class="global-money-legend-item">
        <span class="global-money-dot requisition"></span>
        <div>
          <span>En requisición</span>
          <strong>${escapeHtml(formatCurrencyWithCode(stage.requisition, currency))}</strong>
          <small>${percentText(stage.requisition, stage.total)}</small>
        </div>
      </div>

      <div class="global-money-legend-item">
        <span class="global-money-dot received"></span>
        <div>
          <span>Recibido / ejercido</span>
          <strong>${escapeHtml(formatCurrencyWithCode(stage.received, currency))}</strong>
          <small>${percentText(stage.received, stage.total)}</small>
        </div>
      </div>
    </div>`;
}

function stackedBarHtml(stage, { showLabels = true } = {}) {
  const orderedPct = percent(stage.ordered, stage.total);
  const requisitionPct = percent(stage.requisition, stage.total);
  const receivedPct = percent(stage.received, stage.total);

  return `
    <div class="global-money-stack"
         role="img"
         aria-label="Por requisitar ${orderedPct.toFixed(1)}%, en requisición ${requisitionPct.toFixed(1)}%, recibido ${receivedPct.toFixed(1)}%">
      ${
        orderedPct > 0
          ? `<div class="global-money-segment ordered"
                  style="width:${orderedPct}%"
                  title="Por requisitar: ${orderedPct.toFixed(1)}%">
               ${showLabels && orderedPct >= 9 ? `${orderedPct.toFixed(0)}%` : ""}
             </div>`
          : ""
      }

      ${
        requisitionPct > 0
          ? `<div class="global-money-segment requisition"
                  style="width:${requisitionPct}%"
                  title="En requisición: ${requisitionPct.toFixed(1)}%">
               ${showLabels && requisitionPct >= 9 ? `${requisitionPct.toFixed(0)}%` : ""}
             </div>`
          : ""
      }

      ${
        receivedPct > 0
          ? `<div class="global-money-segment received"
                  style="width:${receivedPct}%"
                  title="Recibido: ${receivedPct.toFixed(1)}%">
               ${showLabels && receivedPct >= 9 ? `${receivedPct.toFixed(0)}%` : ""}
             </div>`
          : ""
      }
    </div>`;
}

function donutHtml(stage) {
  const orderedPct = percent(stage.ordered, stage.total);
  const requisitionPct = percent(stage.requisition, stage.total);
  const receivedPct = percent(stage.received, stage.total);

  const reqEnd = orderedPct + requisitionPct;

  return `
    <div class="global-money-donut-wrap">
      <div class="global-money-donut"
           style="--ordered-end:${orderedPct}%;
                  --req-end:${reqEnd}%;"
           aria-label="Distribución monetaria del proceso">
        <div class="global-money-donut-center">
          <span>Total vigente</span>
          <strong>100%</strong>
          <small>Recibido ${receivedPct.toFixed(1)}%</small>
        </div>
      </div>
    </div>`;
}

function globalCurrencyCardHtml(currency, stage) {
  return `
    <section class="global-money-currency-card">
      <div class="global-money-card-head">
        <div>
          <div class="global-money-eyebrow">Avance monetario global · ${escapeHtml(currency)}</div>
          <h5 class="mb-1">
            ${escapeHtml(formatCurrencyWithCode(stage.total, currency))}
          </h5>
          <div class="small text-muted">
            Monto vigente solicitado, excluyendo cantidades canceladas.
          </div>
        </div>

        <div class="global-money-received-kpi">
          <span>Ejercido / recibido</span>
          <strong>${percentText(stage.received, stage.total)}</strong>
          <small>${escapeHtml(formatCurrencyWithCode(stage.received, currency))}</small>
        </div>
      </div>

      <div class="global-money-main-grid">
        ${donutHtml(stage)}

        <div>
          ${stageLegendHtml(stage, currency)}

          <div class="mt-3">
            <div class="d-flex justify-content-between gap-2 small mb-1">
              <strong>Avance del monto solicitado</strong>
              <span>
                Requisitado + recibido:
                <strong>${percentText(stage.requisition + stage.received, stage.total)}</strong>
              </span>
            </div>

            ${stackedBarHtml(stage)}
          </div>
        </div>
      </div>
    </section>`;
}

function requestCurrencyStage(bundle, currency) {
  return bundle.money.get(currency) || createCurrencyStage();
}

function requestAmountRowsHtml(currency, bundles, globalStage) {
  const rows = bundles
    .map(bundle => ({
      request: bundle.request,
      stage: requestCurrencyStage(bundle, currency),
    }))
    .filter(row => row.stage.total > 0)
    .sort((a, b) => b.stage.total - a.stage.total);

  if (!rows.length) {
    return `
      <div class="text-muted small">
        No hay solicitudes con monto vigente en ${escapeHtml(currency)}.
      </div>`;
  }

  return `
    <div class="global-money-request-list">
      ${rows.map(({ request, stage }) => {
        const folio = request.folio || request.id;
        const alias = String(request.alias || "").trim();
        const share = percent(stage.total, globalStage.total);

        return `
          <article class="global-money-request-row">
            <div class="global-money-request-head">
              <div class="global-money-request-name">
                <strong>${escapeHtml(folio)}</strong>
                ${alias ? `<span>${escapeHtml(alias)}</span>` : ""}
              </div>

              <div class="text-end">
                <strong>${escapeHtml(formatCurrencyWithCode(stage.total, currency))}</strong>
                <div class="small text-muted">
                  ${share.toFixed(1)}% del monto global
                </div>
              </div>
            </div>

            <div class="global-money-share-row">
              <span>Participación global</span>
              <div class="global-money-share-track">
                <div style="width:${share}%"></div>
              </div>
              <strong>${share.toFixed(1)}%</strong>
            </div>

            <div class="global-money-request-progress">
              ${stackedBarHtml(stage, { showLabels: false })}
            </div>

            <div class="global-money-request-stage-values">
              <span>
                <i class="ordered"></i>
                Por requisitar
                <strong>${escapeHtml(formatCurrencyWithCode(stage.ordered, currency))}</strong>
                (${percentText(stage.ordered, stage.total)})
              </span>

              <span>
                <i class="requisition"></i>
                Requisición
                <strong>${escapeHtml(formatCurrencyWithCode(stage.requisition, currency))}</strong>
                (${percentText(stage.requisition, stage.total)})
              </span>

              <span>
                <i class="received"></i>
                Recibido
                <strong>${escapeHtml(formatCurrencyWithCode(stage.received, currency))}</strong>
                (${percentText(stage.received, stage.total)})
              </span>
            </div>
          </article>`;
      }).join("")}
    </div>`;
}

function chartsHtml(globalMoney, bundles) {
  const currencies = [...globalMoney.keys()]
    .filter(currency => globalMoney.get(currency)?.total > 0)
    .sort();

  if (!currencies.length) {
    return `
      <section id="${CHARTS_ID}" class="global-money-charts">
        <div class="alert alert-light border mb-0">
          Todavía no hay montos vigentes para graficar.
        </div>
      </section>`;
  }

  return `
    <section id="${CHARTS_ID}" class="global-money-charts">
      <div class="global-money-section-title">
        <div>
          <h5 class="mb-1">Avance financiero de las solicitudes</h5>
          <div class="small text-muted">
            El monto es el indicador principal. El total vigente se divide en:
            por requisitar, en requisición y recibido/ejercido.
          </div>
        </div>
      </div>

      ${currencies.map(currency => {
        const stage = globalMoney.get(currency);

        return `
          ${globalCurrencyCardHtml(currency, stage)}

          <div class="global-money-requests-section">
            <div class="d-flex flex-wrap justify-content-between align-items-end gap-2 mb-2">
              <div>
                <h6 class="mb-1">Monto y avance por solicitud · ${escapeHtml(currency)}</h6>
                <div class="small text-muted">
                  La primera barra indica qué parte del monto global representa cada solicitud;
                  la segunda divide internamente su monto por etapa.
                </div>
              </div>
            </div>

            ${requestAmountRowsHtml(currency, bundles, stage)}
          </div>`;
      }).join("")}
    </section>`;
}

function injectStyles() {
  if (document.querySelector(`#${STYLE_ID}`)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;

  style.textContent = `
    .global-money-charts {
      margin:1rem 0 1.35rem;
    }

    .global-money-section-title {
      display:flex;
      justify-content:space-between;
      gap:1rem;
      align-items:flex-end;
      margin-bottom:.85rem;
    }

    .global-money-currency-card {
      border:1px solid #d9dde3;
      border-radius:.85rem;
      padding:1rem;
      background:#fff;
      margin-bottom:1rem;
      box-shadow:0 1px 2px rgba(0,0,0,.03);
    }

    .global-money-card-head {
      display:flex;
      flex-wrap:wrap;
      justify-content:space-between;
      gap:.75rem 1rem;
      align-items:flex-start;
      margin-bottom:1rem;
    }

    .global-money-eyebrow {
      color:#6c757d;
      font-size:.74rem;
      font-weight:700;
      text-transform:uppercase;
      letter-spacing:.035em;
    }

    .global-money-card-head h5 {
      font-size:1.55rem;
      font-weight:750;
    }

    .global-money-received-kpi {
      min-width:190px;
      border:1px solid #badbcc;
      border-left:5px solid #198754;
      border-radius:.65rem;
      padding:.6rem .75rem;
      background:#f2fbf6;
      text-align:right;
    }

    .global-money-received-kpi span,
    .global-money-received-kpi small {
      display:block;
      color:#5f6b65;
      font-size:.73rem;
    }

    .global-money-received-kpi strong {
      display:block;
      color:#146c43;
      font-size:1.4rem;
    }

    .global-money-main-grid {
      display:grid;
      grid-template-columns:230px 1fr;
      gap:1rem 1.25rem;
      align-items:center;
    }

    .global-money-donut-wrap {
      display:flex;
      justify-content:center;
      align-items:center;
    }

    .global-money-donut {
      width:190px;
      height:190px;
      border-radius:50%;
      display:grid;
      place-items:center;
      background:
        conic-gradient(
          #f0ad00 0 var(--ordered-end),
          #0d6efd var(--ordered-end) var(--req-end),
          #198754 var(--req-end) 100%
        );
      position:relative;
    }

    .global-money-donut::after {
      content:"";
      width:118px;
      height:118px;
      border-radius:50%;
      background:#fff;
      position:absolute;
      inset:50% auto auto 50%;
      transform:translate(-50%,-50%);
      box-shadow:0 0 0 1px rgba(0,0,0,.04);
    }

    .global-money-donut-center {
      position:relative;
      z-index:1;
      text-align:center;
      width:105px;
    }

    .global-money-donut-center span,
    .global-money-donut-center small {
      display:block;
      color:#6c757d;
      font-size:.7rem;
    }

    .global-money-donut-center strong {
      display:block;
      font-size:1.45rem;
      line-height:1.1;
      margin:.12rem 0;
    }

    .global-money-legend {
      display:grid;
      grid-template-columns:repeat(3,minmax(0,1fr));
      gap:.65rem;
    }

    .global-money-legend-item {
      display:grid;
      grid-template-columns:12px 1fr;
      gap:.55rem;
      align-items:start;
      border:1px solid #e2e5e9;
      border-radius:.65rem;
      padding:.6rem .65rem;
      background:#fafbfc;
    }

    .global-money-dot {
      width:11px;
      height:11px;
      border-radius:50%;
      margin-top:.22rem;
    }

    .global-money-dot.ordered,
    .global-money-request-stage-values i.ordered {
      background:#f0ad00;
    }

    .global-money-dot.requisition,
    .global-money-request-stage-values i.requisition {
      background:#0d6efd;
    }

    .global-money-dot.received,
    .global-money-request-stage-values i.received {
      background:#198754;
    }

    .global-money-legend-item span:not(.global-money-dot) {
      display:block;
      color:#6c757d;
      font-size:.72rem;
    }

    .global-money-legend-item strong {
      display:block;
      font-size:.88rem;
      margin:.08rem 0;
    }

    .global-money-legend-item small {
      color:#6c757d;
      font-weight:700;
    }

    .global-money-stack {
      display:flex;
      overflow:hidden;
      width:100%;
      min-height:26px;
      border-radius:999px;
      background:#e9ecef;
      box-shadow:inset 0 0 0 1px rgba(0,0,0,.04);
    }

    .global-money-segment {
      display:flex;
      align-items:center;
      justify-content:center;
      min-width:0;
      color:#111;
      font-size:.7rem;
      font-weight:800;
      white-space:nowrap;
    }

    .global-money-segment.ordered {
      background:#f0ad00;
    }

    .global-money-segment.requisition {
      background:#0d6efd;
      color:#fff;
    }

    .global-money-segment.received {
      background:#198754;
      color:#fff;
    }

    .global-money-requests-section {
      border:1px solid #d9dde3;
      border-radius:.85rem;
      padding:1rem;
      background:#fff;
      margin-bottom:1.15rem;
    }

    .global-money-request-list {
      display:flex;
      flex-direction:column;
      gap:.65rem;
    }

    .global-money-request-row {
      border:1px solid #e1e5ea;
      border-radius:.7rem;
      padding:.7rem .8rem;
      background:#fff;
      break-inside:avoid;
    }

    .global-money-request-head {
      display:flex;
      flex-wrap:wrap;
      justify-content:space-between;
      gap:.55rem 1rem;
      align-items:flex-start;
      margin-bottom:.45rem;
    }

    .global-money-request-name {
      display:flex;
      flex-direction:column;
      min-width:210px;
    }

    .global-money-request-name span {
      color:#0d6efd;
      font-size:.82rem;
      font-weight:650;
    }

    .global-money-share-row {
      display:grid;
      grid-template-columns:120px minmax(120px,1fr) 55px;
      gap:.55rem;
      align-items:center;
      font-size:.74rem;
      color:#6c757d;
      margin-bottom:.4rem;
    }

    .global-money-share-track {
      height:7px;
      border-radius:999px;
      background:#e9ecef;
      overflow:hidden;
    }

    .global-money-share-track > div {
      height:100%;
      background:#343a40;
      border-radius:999px;
    }

    .global-money-request-progress .global-money-stack {
      min-height:18px;
    }

    .global-money-request-stage-values {
      display:flex;
      flex-wrap:wrap;
      gap:.3rem 1rem;
      margin-top:.4rem;
      color:#6c757d;
      font-size:.72rem;
    }

    .global-money-request-stage-values span {
      display:inline-flex;
      flex-wrap:wrap;
      align-items:center;
      gap:.25rem;
    }

    .global-money-request-stage-values i {
      width:8px;
      height:8px;
      border-radius:50%;
      display:inline-block;
      flex:0 0 auto;
    }

    .global-money-request-stage-values strong {
      color:#343a40;
    }

    .global-money-secondary-title {
      margin:.5rem 0 .7rem;
      padding-top:.8rem;
      border-top:1px solid #dee2e6;
    }

    @media (max-width:991.98px) {
      .global-money-main-grid {
        grid-template-columns:1fr;
      }

      .global-money-legend {
        grid-template-columns:1fr;
      }

      .global-money-donut {
        width:170px;
        height:170px;
      }
    }

    @media (max-width:575.98px) {
      .global-money-share-row {
        grid-template-columns:1fr;
      }

      .global-money-share-row strong {
        text-align:left;
      }

      .global-money-card-head h5 {
        font-size:1.25rem;
      }

      .global-money-received-kpi {
        width:100%;
        text-align:left;
      }
    }

    @media print {
      .global-money-currency-card,
      .global-money-requests-section,
      .global-money-request-row {
        box-shadow:none !important;
        break-inside:avoid;
      }

      .global-money-donut {
        -webkit-print-color-adjust:exact !important;
        print-color-adjust:exact !important;
      }

      .global-money-segment,
      .global-money-share-track > div,
      .global-money-dot,
      .global-money-request-stage-values i {
        -webkit-print-color-adjust:exact !important;
        print-color-adjust:exact !important;
      }
    }
  `;

  document.head.appendChild(style);
}

function bodyReadyForCharts(body) {
  if (!body) return false;

  if (body.querySelector(".spinner-border")) {
    return false;
  }

  return Boolean(
    body.querySelector(".request-progress-overview")
    || body.querySelector(".global-progress-table")
  );
}

async function renderCharts() {
  const body = document.querySelector(`#${GLOBAL_BODY_ID}`);

  if (
    !body
    || !bodyReadyForCharts(body)
    || body.querySelector(`#${CHARTS_ID}`)
    || renderBusy
  ) {
    return;
  }

  renderBusy = true;
  const sequence = ++renderSequence;

  try {
    const bundles = await loadMonetaryBundles();

    if (
      sequence !== renderSequence
      || !document.body.contains(body)
      || body.querySelector(`#${CHARTS_ID}`)
    ) {
      return;
    }

    const globalMoney = new Map();

    for (const bundle of bundles) {
      mergeSummary(globalMoney, bundle.money);
    }

    const wrapper = document.createElement("div");
    wrapper.innerHTML = chartsHtml(globalMoney, bundles);
    const charts = wrapper.firstElementChild;

    const intro = body.querySelector(".global-report-intro");
    const existingSummary = body.querySelector(".request-progress-overview");

    if (intro) {
      intro.insertAdjacentElement("afterend", charts);
    } else if (existingSummary) {
      body.insertBefore(charts, existingSummary);
    } else {
      body.prepend(charts);
    }

    if (
      existingSummary
      && !body.querySelector(`#${SECONDARY_TITLE_ID}`)
    ) {
      const title = document.createElement("div");
      title.id = SECONDARY_TITLE_ID;
      title.className = "global-money-secondary-title";
      title.innerHTML = `
        <h6 class="mb-1">Complemento operativo: productos y piezas</h6>
        <div class="small text-muted">
          Estos indicadores se conservan como referencia; arriba se muestra el
          avance principal por monto.
        </div>`;

      existingSummary.insertAdjacentElement("beforebegin", title);
    }
  } catch (error) {
    console.error("No se pudieron generar las gráficas monetarias:", error);

    if (
      !body.querySelector(`#${CHARTS_ID}`)
      && bodyReadyForCharts(body)
    ) {
      const warning = document.createElement("div");
      warning.id = CHARTS_ID;
      warning.className = "alert alert-warning";
      warning.textContent =
        `No se pudieron cargar las gráficas de montos: ${error.message}`;
      body.prepend(warning);
    }
  } finally {
    renderBusy = false;
  }
}

function observeGlobalBody() {
  const body = document.querySelector(`#${GLOBAL_BODY_ID}`);

  if (!body || body === observedBody) {
    return;
  }

  if (bodyObserver) {
    bodyObserver.disconnect();
  }

  observedBody = body;

  bodyObserver = new MutationObserver(mutations => {
    const replaced =
      mutations.some(
        mutation =>
          mutation.type === "childList"
          && (
            mutation.addedNodes.length > 0
            || mutation.removedNodes.length > 0
          )
      );

    if (!replaced) return;

    // Si el render principal reemplazó el body, las gráficas dejan de existir
    // y se reconstruyen. La inserción de nuestras propias gráficas no provoca
    // una segunda carga porque CHARTS_ID ya está presente.
    if (!body.querySelector(`#${CHARTS_ID}`)) {
      window.setTimeout(renderCharts, 60);
    }
  });

  bodyObserver.observe(body, {
    childList: true,
    subtree: false,
  });
}

function start() {
  injectStyles();
  observeGlobalBody();

  document.addEventListener("shown.bs.modal", event => {
    if (event.target?.id !== GLOBAL_MODAL_ID) return;

    observeGlobalBody();
    window.setTimeout(renderCharts, 80);
  });

  document.addEventListener("click", event => {
    if (
      event.target.closest("#refreshPurchaseGlobalProgress")
      || event.target.closest("#purchaseGlobalProgressReport")
    ) {
      window.setTimeout(() => {
        observeGlobalBody();
        renderCharts();
      }, 150);
    }
  });

  // El modal normalmente ya existe porque este módulo se carga después de
  // compras-request-progress.js. El intervalo cubre recargas/variaciones de DOM.
  let attempts = 0;

  const timer = window.setInterval(() => {
    attempts += 1;
    observeGlobalBody();

    if (
      document.querySelector(`#${GLOBAL_BODY_ID}`)
      || attempts >= 40
    ) {
      clearInterval(timer);
    }
  }, 250);
}

start();
