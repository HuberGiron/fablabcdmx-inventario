import { db } from "./firebase-app.js";
import {
  collection,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const PANEL_ID = "purchaseBudgetsPanel";
const BODY_ID = "purchaseBudgetsPanelBody";
const TABS_ID = "purchaseBudgetTabs";
const CONTENT_ID = "purchaseBudgetTabContent";
const TAB_ID = "budget-report-tab";
const PANE_ID = "budget-report-pane";
const REPORT_BODY_ID = "purchaseBudgetVisualReport";
const STYLE_ID = "purchaseBudgetVisualReportStyles";

let attachObserver = null;
let bodyObserver = null;
let boundBody = null;
let renderBusy = false;
let renderSequence = 0;
let reportTabActive = false;
let scheduledTimer = null;

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

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMoney(text) {
  const cleaned = String(text || "")
    .replace(/[^0-9.,-]/g, "")
    .replace(/,/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  return `${new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num(value))} MXN`;
}

function percent(part, total) {
  const denominator = num(total);
  if (denominator <= 0) return 0;
  return (num(part) / denominator) * 100;
}

function percentText(part, total) {
  if (num(total) <= 0) {
    return num(part) > 0 ? "Sin presupuesto" : "0%";
  }
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

function compareCodes(left, right) {
  const a = String(left || "").split(".").map(part => Number(part));
  const b = String(right || "").split(".").map(part => Number(part));
  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i += 1) {
    const av = Number.isFinite(a[i]) ? a[i] : -1;
    const bv = Number.isFinite(b[i]) ? b[i] : -1;
    if (av !== bv) return av - bv;
  }

  return String(left || "").localeCompare(String(right || ""), "es", {
    numeric: true,
    sensitivity: "base",
  });
}

function currentYear() {
  return Number(document.querySelector("#purchaseBudgetYear")?.value)
    || new Date().getFullYear();
}

function createState(zoneId, code, name, allocated = 0) {
  return {
    zoneId: String(zoneId || ""),
    code: String(code || zoneId || ""),
    name: String(name || ""),
    allocated: Math.max(num(allocated), 0),
    requested: 0,
    requisition: 0,
    received: 0,
  };
}

function used(state) {
  return num(state.requested) + num(state.requisition) + num(state.received);
}

function available(state) {
  return num(state.allocated) - used(state);
}

function splitZoneDisplay(text) {
  const value = normalizeText(text);
  const dot = value.indexOf("·");

  if (dot < 0) {
    return { code: value, name: "" };
  }

  return {
    code: value.slice(0, dot).trim(),
    name: value.slice(dot + 1).trim(),
  };
}

function allocationStatesFromUi() {
  const table = document.querySelector(".purchase-budget-zone-table");
  if (!table) return [];

  return [...table.querySelectorAll("tbody tr")]
    .map(row => {
      const cells = row.querySelectorAll("td");
      if (cells.length < 2) return null;

      const input = row.querySelector(".purchase-budget-zone-input");
      const zoneId = String(
        input?.dataset?.zoneId || row.dataset.rawZoneId || ""
      ).trim();

      const display = splitZoneDisplay(cells[0]?.textContent || "");
      const allocated = parseMoney(cells[1]?.textContent || "");

      return createState(
        zoneId,
        display.code || zoneId,
        display.name,
        allocated
      );
    })
    .filter(state => state?.zoneId)
    .sort((a, b) =>
      compareCodes(a.code, b.code)
      || a.name.localeCompare(b.name, "es", { sensitivity: "base" })
    );
}

async function loadFinancialLines(year) {
  const requestSnapshot = await getDocs(collection(db, "purchaseRequests"));

  const requests = requestSnapshot.docs
    .map(requestDoc => ({
      id: requestDoc.id,
      ...requestDoc.data(),
    }))
    .filter(request => {
      if (request.status === "draft") return false;

      const date =
        timestampToDate(request.sentAt)
        || timestampToDate(request.createdAt);

      return date ? date.getFullYear() === Number(year) : true;
    });

  const allLines = [];
  let cursor = 0;

  const runners = Array.from(
    { length: Math.min(6, Math.max(1, requests.length)) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= requests.length) break;

        const request = requests[index];

        const lineSnapshot = await getDocs(
          collection(db, "purchaseRequests", request.id, "items")
        );

        lineSnapshot.docs.forEach(lineDoc => {
          allLines.push({
            requestId: request.id,
            requestStatus: request.status,
            ...lineDoc.data(),
          });
        });
      }
    }
  );

  await Promise.all(runners);
  return allLines;
}

function applyFinancialLines(states, lines) {
  const map = new Map(
    states.map(state => [String(state.zoneId), state])
  );

  for (const line of lines) {
    const zoneId = String(line.zoneId || "");
    if (!zoneId) continue;

    const currency = String(line.currency || "MXN").toUpperCase();
    if (currency !== "MXN") continue;

    if (!map.has(zoneId)) {
      map.set(
        zoneId,
        createState(
          zoneId,
          zoneId,
          line.zoneName || `Zona ${zoneId}`,
          0
        )
      );
    }

    const state = map.get(zoneId);
    const pending = linePendingQty(line);
    const receivedAmount = lineActualSpent(line);
    const pendingAmount = pending * linePendingUnitCost(line);

    if (receivedAmount > 0) {
      state.received += receivedAmount;
    }

    if (pendingAmount > 0) {
      if (line.requisitionStatus === "requisitioned") {
        state.requisition += pendingAmount;
      } else {
        state.requested += pendingAmount;
      }
    }
  }

  return [...map.values()]
    .sort((a, b) =>
      compareCodes(a.code, b.code)
      || a.name.localeCompare(b.name, "es", { sensitivity: "base" })
    );
}

function globalState(states) {
  const total = createState("all", "", "Presupuesto global", 0);

  states.forEach(state => {
    total.allocated += num(state.allocated);
    total.requested += num(state.requested);
    total.requisition += num(state.requisition);
    total.received += num(state.received);
  });

  return total;
}

function segmentPercent(value, denominator) {
  if (denominator <= 0) return 0;
  return Math.max(0, (num(value) / denominator) * 100);
}

function distributionBarHtml(state, small = false) {
  const totalUsed = used(state);
  const free = Math.max(available(state), 0);
  const denominator = Math.max(num(state.allocated), totalUsed, 0.01);

  const parts = [
    ["requested", state.requested, "Solicitado / por requisitar"],
    ["requisition", state.requisition, "En requisición"],
    ["received", state.received, "Entregado / ejercido"],
    ["available", free, "Disponible"],
  ];

  return `
    <div class="budget-report-stack ${small ? "is-small" : ""}">
      ${parts
        .filter(([, value]) => num(value) > 0)
        .map(([className, value, label]) => `
          <div class="${className}"
               style="width:${segmentPercent(value, denominator)}%"
               title="${escapeHtml(label)}: ${escapeHtml(money(value))}">
          </div>`)
        .join("")}
    </div>`;
}

function donutStyle(state) {
  const allocated = num(state.allocated);

  if (allocated <= 0) {
    return "conic-gradient(#e9ecef 0 100%)";
  }

  const requested = Math.max(
    0,
    Math.min(100, percent(state.requested, allocated))
  );

  const requisition = Math.max(
    0,
    Math.min(
      100 - requested,
      percent(state.requisition, allocated)
    )
  );

  const received = Math.max(
    0,
    Math.min(
      100 - requested - requisition,
      percent(state.received, allocated)
    )
  );

  const reqEnd = requested;
  const requisitionEnd = reqEnd + requisition;
  const receivedEnd = requisitionEnd + received;

  return `conic-gradient(
    #f0ad00 0 ${reqEnd}%,
    #0d6efd ${reqEnd}% ${requisitionEnd}%,
    #198754 ${requisitionEnd}% ${receivedEnd}%,
    #dfe3e8 ${receivedEnd}% 100%
  )`;
}

function metricCardHtml(label, amount, total, cssClass) {
  return `
    <div class="budget-report-metric">
      <span class="budget-report-dot ${cssClass}"></span>
      <div>
        <div class="budget-report-metric-label">${escapeHtml(label)}</div>
        <strong>${escapeHtml(money(amount))}</strong>
        <small>${escapeHtml(percentText(amount, total))} del presupuesto global</small>
      </div>
    </div>`;
}

function globalReportHtml(state) {
  const totalUsed = used(state);
  const free = available(state);
  const over = Math.max(-free, 0);

  return `
    <section class="budget-report-global-card">
      <div class="budget-report-global-head">
        <div>
          <div class="budget-report-eyebrow">Presupuesto global autorizado</div>
          <h3>${escapeHtml(money(state.allocated))}</h3>
          <div class="small text-muted">
            Suma de la columna <strong>Asignado</strong> de todas las zonas.
          </div>
        </div>

        <div class="budget-report-utilization ${over > 0 ? "is-over" : ""}">
          <span>Utilizado / comprometido</span>
          <strong>${escapeHtml(percentText(totalUsed, state.allocated))}</strong>
          <small>
            ${
              over > 0
                ? `Sobreejercicio: ${escapeHtml(money(over))}`
                : `Disponible: ${escapeHtml(money(Math.max(free, 0)))}`
            }
          </small>
        </div>
      </div>

      <div class="budget-report-global-grid">
        <div class="budget-report-donut-wrap">
          <div class="budget-report-donut"
               style="background:${donutStyle(state)}">
            <div class="budget-report-donut-center">
              <span>Asignado</span>
              <strong>100%</strong>
              <small>
                Ejercido ${escapeHtml(percentText(state.received, state.allocated))}
              </small>
            </div>
          </div>
        </div>

        <div>
          <div class="budget-report-metrics">
            ${metricCardHtml(
              "Solicitado / por requisitar",
              state.requested,
              state.allocated,
              "requested"
            )}

            ${metricCardHtml(
              "En requisición",
              state.requisition,
              state.allocated,
              "requisition"
            )}

            ${metricCardHtml(
              "Entregado / ejercido",
              state.received,
              state.allocated,
              "received"
            )}

            ${metricCardHtml(
              over > 0 ? "Sobreejercicio" : "Disponible",
              over > 0 ? over : Math.max(free, 0),
              state.allocated,
              over > 0 ? "over" : "available"
            )}
          </div>

          <div class="budget-report-bar-caption">
            <span>Distribución del presupuesto global</span>
            <strong>
              ${escapeHtml(money(totalUsed))}
              de
              ${escapeHtml(money(state.allocated))}
            </strong>
          </div>

          ${distributionBarHtml(state)}

          ${
            over > 0
              ? `<div class="budget-report-over-alert">
                   El monto comprometido + ejercido supera el presupuesto
                   autorizado en
                   <strong>${escapeHtml(money(over))}</strong>.
                 </div>`
              : ""
          }
        </div>
      </div>
    </section>`;
}

function zoneReportHtml(state) {
  const totalUsed = used(state);
  const free = available(state);
  const over = Math.max(-free, 0);

  return `
    <article class="budget-report-zone-card">
      <div class="budget-report-zone-head">
        <div>
          <div class="budget-report-zone-title">
            Zona ${escapeHtml(state.code)} · ${escapeHtml(state.name)}
          </div>

          <div class="small text-muted">
            Presupuesto asignado:
            <strong>${escapeHtml(money(state.allocated))}</strong>
          </div>
        </div>

        <div class="text-end">
          <strong class="${over > 0 ? "text-danger" : ""}">
            ${escapeHtml(percentText(totalUsed, state.allocated))} utilizado
          </strong>

          <div class="small ${over > 0 ? "text-danger fw-semibold" : "text-muted"}">
            ${
              over > 0
                ? `Sobreejercicio ${escapeHtml(money(over))}`
                : `Disponible ${escapeHtml(money(Math.max(free, 0)))}`
            }
          </div>
        </div>
      </div>

      ${distributionBarHtml(state, true)}

      <div class="budget-report-zone-values">
        <span>
          <i class="requested"></i>
          Solicitado
          <strong>${escapeHtml(money(state.requested))}</strong>
          (${escapeHtml(percentText(state.requested, state.allocated))})
        </span>

        <span>
          <i class="requisition"></i>
          En requisición
          <strong>${escapeHtml(money(state.requisition))}</strong>
          (${escapeHtml(percentText(state.requisition, state.allocated))})
        </span>

        <span>
          <i class="received"></i>
          Entregado
          <strong>${escapeHtml(money(state.received))}</strong>
          (${escapeHtml(percentText(state.received, state.allocated))})
        </span>

        <span>
          <i class="${over > 0 ? "over" : "available"}"></i>
          ${over > 0 ? "Sobreejercicio" : "Disponible"}
          <strong>
            ${escapeHtml(
              money(over > 0 ? over : Math.max(free, 0))
            )}
          </strong>
        </span>
      </div>
    </article>`;
}

function reportHtml(states, year) {
  const global = globalState(states);

  return `
    <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
      <div>
        <h3 class="h6 mb-1">Reporte presupuestal · ${year}</h3>
        <div class="small text-muted">
          El presupuesto autorizado por Zona es la referencia.
          El reporte muestra su avance real desde solicitud hasta entrega.
        </div>
      </div>

      <div class="d-flex flex-wrap gap-2">
        <button type="button"
                class="btn btn-outline-dark btn-sm"
                id="refreshBudgetVisualReport">
          Actualizar reporte
        </button>

        <button type="button"
                class="btn btn-outline-danger btn-sm"
                id="printBudgetVisualReport">
          Imprimir / PDF
        </button>
      </div>
    </div>

    ${globalReportHtml(global)}

    <section class="budget-report-zones-section">
      <div class="budget-report-zones-head">
        <div>
          <h4 class="h6 mb-1">Avance por zona</h4>
          <div class="small text-muted">
            Cada zona se mide contra SU PROPIO presupuesto asignado,
            no contra su participación en el presupuesto global.
          </div>
        </div>

        <div class="budget-report-legend">
          <span><i class="requested"></i>Solicitado</span>
          <span><i class="requisition"></i>Requisición</span>
          <span><i class="received"></i>Entregado</span>
          <span><i class="available"></i>Disponible</span>
        </div>
      </div>

      <div class="budget-report-zone-list">
        ${
          states.length
            ? states.map(zoneReportHtml).join("")
            : `<div class="text-muted">
                 No hay presupuestos por zona para este ejercicio.
               </div>`
        }
      </div>
    </section>`;
}

function injectStyles() {
  if (document.querySelector(`#${STYLE_ID}`)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;

  style.textContent = `
    .budget-report-global-card,
    .budget-report-zones-section {
      border:1px solid #d9dde3;
      border-radius:.85rem;
      background:#fff;
      padding:1rem;
      margin-bottom:1rem;
    }

    .budget-report-global-head {
      display:flex;
      flex-wrap:wrap;
      justify-content:space-between;
      gap:.75rem 1rem;
      align-items:flex-start;
      margin-bottom:1rem;
    }

    .budget-report-eyebrow {
      color:#6c757d;
      font-size:.75rem;
      font-weight:700;
      letter-spacing:.035em;
      text-transform:uppercase;
    }

    .budget-report-global-head h3 {
      margin:.15rem 0;
      font-size:1.65rem;
      font-weight:750;
    }

    .budget-report-utilization {
      min-width:220px;
      border:1px solid #b6d4fe;
      border-left:5px solid #0d6efd;
      border-radius:.65rem;
      background:#f4f8ff;
      padding:.6rem .75rem;
      text-align:right;
    }

    .budget-report-utilization.is-over {
      border-color:#f1aeb5;
      border-left-color:#dc3545;
      background:#fff5f5;
    }

    .budget-report-utilization span,
    .budget-report-utilization small {
      display:block;
      color:#6c757d;
      font-size:.74rem;
    }

    .budget-report-utilization strong {
      display:block;
      font-size:1.4rem;
    }

    .budget-report-utilization.is-over strong,
    .budget-report-utilization.is-over small {
      color:#b02a37;
    }

    .budget-report-global-grid {
      display:grid;
      grid-template-columns:230px 1fr;
      gap:1rem 1.25rem;
      align-items:center;
    }

    .budget-report-donut-wrap {
      display:flex;
      justify-content:center;
      align-items:center;
    }

    .budget-report-donut {
      width:190px;
      height:190px;
      border-radius:50%;
      display:grid;
      place-items:center;
      position:relative;
    }

    .budget-report-donut::after {
      content:"";
      width:118px;
      height:118px;
      border-radius:50%;
      background:#fff;
      position:absolute;
      top:50%;
      left:50%;
      transform:translate(-50%,-50%);
      box-shadow:0 0 0 1px rgba(0,0,0,.04);
    }

    .budget-report-donut-center {
      position:relative;
      z-index:1;
      width:106px;
      text-align:center;
    }

    .budget-report-donut-center span,
    .budget-report-donut-center small {
      display:block;
      color:#6c757d;
      font-size:.7rem;
    }

    .budget-report-donut-center strong {
      display:block;
      font-size:1.42rem;
      line-height:1.1;
      margin:.12rem 0;
    }

    .budget-report-metrics {
      display:grid;
      grid-template-columns:repeat(4,minmax(0,1fr));
      gap:.6rem;
    }

    .budget-report-metric {
      display:grid;
      grid-template-columns:12px 1fr;
      gap:.5rem;
      border:1px solid #e2e5e9;
      border-radius:.65rem;
      background:#fafbfc;
      padding:.6rem;
    }

    .budget-report-metric-label {
      color:#6c757d;
      font-size:.7rem;
    }

    .budget-report-metric strong {
      display:block;
      margin:.08rem 0;
      font-size:.85rem;
    }

    .budget-report-metric small {
      color:#6c757d;
      font-size:.7rem;
      font-weight:700;
    }

    .budget-report-dot {
      width:10px;
      height:10px;
      border-radius:50%;
      margin-top:.22rem;
    }

    .budget-report-dot.requested,
    .budget-report-zone-values i.requested,
    .budget-report-legend i.requested {
      background:#f0ad00;
    }

    .budget-report-dot.requisition,
    .budget-report-zone-values i.requisition,
    .budget-report-legend i.requisition {
      background:#0d6efd;
    }

    .budget-report-dot.received,
    .budget-report-zone-values i.received,
    .budget-report-legend i.received {
      background:#198754;
    }

    .budget-report-dot.available,
    .budget-report-zone-values i.available,
    .budget-report-legend i.available {
      background:#dfe3e8;
    }

    .budget-report-dot.over,
    .budget-report-zone-values i.over {
      background:#dc3545;
    }

    .budget-report-bar-caption {
      display:flex;
      flex-wrap:wrap;
      justify-content:space-between;
      gap:.5rem;
      margin:.9rem 0 .35rem;
      font-size:.78rem;
    }

    .budget-report-stack {
      display:flex;
      width:100%;
      min-height:25px;
      overflow:hidden;
      border-radius:999px;
      background:#eef0f2;
      box-shadow:inset 0 0 0 1px rgba(0,0,0,.04);
    }

    .budget-report-stack.is-small {
      min-height:16px;
      margin-top:.5rem;
    }

    .budget-report-stack > div {
      min-width:0;
    }

    .budget-report-stack > .requested {
      background:#f0ad00;
    }

    .budget-report-stack > .requisition {
      background:#0d6efd;
    }

    .budget-report-stack > .received {
      background:#198754;
    }

    .budget-report-stack > .available {
      background:#dfe3e8;
    }

    .budget-report-over-alert {
      margin-top:.6rem;
      border:1px solid #f1aeb5;
      border-radius:.55rem;
      background:#fff5f5;
      color:#b02a37;
      padding:.55rem .7rem;
      font-size:.8rem;
    }

    .budget-report-zones-head {
      display:flex;
      flex-wrap:wrap;
      justify-content:space-between;
      gap:.6rem 1rem;
      align-items:flex-end;
      margin-bottom:.8rem;
    }

    .budget-report-legend {
      display:flex;
      flex-wrap:wrap;
      gap:.4rem .85rem;
      color:#6c757d;
      font-size:.72rem;
    }

    .budget-report-legend span,
    .budget-report-zone-values span {
      display:inline-flex;
      flex-wrap:wrap;
      align-items:center;
      gap:.25rem;
    }

    .budget-report-legend i,
    .budget-report-zone-values i {
      display:inline-block;
      width:8px;
      height:8px;
      border-radius:50%;
      flex:0 0 auto;
    }

    .budget-report-zone-list {
      display:flex;
      flex-direction:column;
      gap:.65rem;
    }

    .budget-report-zone-card {
      border:1px solid #e2e5e9;
      border-radius:.7rem;
      padding:.72rem .82rem;
      break-inside:avoid;
    }

    .budget-report-zone-head {
      display:flex;
      flex-wrap:wrap;
      justify-content:space-between;
      gap:.5rem 1rem;
      align-items:flex-start;
    }

    .budget-report-zone-title {
      font-weight:700;
    }

    .budget-report-zone-values {
      display:flex;
      flex-wrap:wrap;
      gap:.3rem 1rem;
      margin-top:.45rem;
      color:#6c757d;
      font-size:.72rem;
    }

    .budget-report-zone-values strong {
      color:#343a40;
    }

    @media (max-width:1199.98px) {
      .budget-report-metrics {
        grid-template-columns:repeat(2,minmax(0,1fr));
      }
    }

    @media (max-width:991.98px) {
      .budget-report-global-grid {
        grid-template-columns:1fr;
      }
    }

    @media (max-width:575.98px) {
      .budget-report-metrics {
        grid-template-columns:1fr;
      }

      .budget-report-utilization {
        width:100%;
        text-align:left;
      }
    }

    @media print {
      body.purchase-budget-report-print > *:not(#${PANEL_ID}) {
        display:none !important;
      }

      body.purchase-budget-report-print #${PANEL_ID} {
        position:static !important;
        display:block !important;
        visibility:visible !important;
        transform:none !important;
        height:auto !important;
        max-height:none !important;
        border:0 !important;
      }

      body.purchase-budget-report-print #${PANEL_ID} .offcanvas-header,
      body.purchase-budget-report-print #${PANEL_ID} #purchaseBudgetTabs,
      body.purchase-budget-report-print #${PANEL_ID} #purchaseBudgetYear,
      body.purchase-budget-report-print #${PANEL_ID} #refreshPurchaseBudgets,
      body.purchase-budget-report-print #${PANEL_ID} #refreshBudgetVisualReport,
      body.purchase-budget-report-print #${PANEL_ID} #printBudgetVisualReport,
      body.purchase-budget-report-print #${PANEL_ID} .purchase-budget-summary-grid,
      body.purchase-budget-report-print #${PANEL_ID} .purchase-budget-foreign-warning {
        display:none !important;
      }

      body.purchase-budget-report-print #${PANE_ID} {
        display:block !important;
        opacity:1 !important;
      }

      .budget-report-global-card,
      .budget-report-zones-section,
      .budget-report-zone-card {
        break-inside:avoid;
        box-shadow:none !important;
      }

      .budget-report-donut,
      .budget-report-stack > div,
      .budget-report-dot,
      .budget-report-zone-values i,
      .budget-report-legend i {
        -webkit-print-color-adjust:exact !important;
        print-color-adjust:exact !important;
      }
    }
  `;

  document.head.appendChild(style);
}

function ensureReportTab() {
  const tabs = document.querySelector(`#${TABS_ID}`);
  const content = document.querySelector(`#${CONTENT_ID}`);
  if (!tabs || !content) return false;

  if (!document.querySelector(`#${TAB_ID}`)) {
    const li = document.createElement("li");
    li.className = "nav-item";
    li.setAttribute("role", "presentation");

    li.innerHTML = `
      <button class="nav-link"
              id="${TAB_ID}"
              data-bs-toggle="tab"
              data-bs-target="#${PANE_ID}"
              type="button"
              role="tab"
              aria-controls="${PANE_ID}"
              aria-selected="false">
        Reporte presupuestal
      </button>`;

    tabs.appendChild(li);
  }

  if (!document.querySelector(`#${PANE_ID}`)) {
    const pane = document.createElement("div");
    pane.className = "tab-pane fade";
    pane.id = PANE_ID;
    pane.setAttribute("role", "tabpanel");
    pane.setAttribute("aria-labelledby", TAB_ID);
    pane.tabIndex = 0;

    pane.innerHTML = `
      <div id="${REPORT_BODY_ID}">
        <div class="text-center text-muted py-5">
          Abre esta pestaña para generar el reporte presupuestal.
        </div>
      </div>`;

    content.appendChild(pane);
  }

  if (reportTabActive) {
    const tabButton = document.querySelector(`#${TAB_ID}`);
    if (tabButton) {
      bootstrap.Tab.getOrCreateInstance(tabButton).show();
    }
  }

  return true;
}

async function renderReport() {
  if (renderBusy) return;

  const target = document.querySelector(`#${REPORT_BODY_ID}`);
  if (!target) return;

  const baseStates = allocationStatesFromUi();

  if (!baseStates.length) {
    target.innerHTML = `
      <div class="alert alert-warning">
        No se encontró la tabla de presupuesto autorizado por zona.
      </div>`;
    return;
  }

  renderBusy = true;
  const sequence = ++renderSequence;

  target.innerHTML = `
    <div class="text-center text-muted py-5">
      <div class="spinner-border spinner-border-sm me-2" role="status"></div>
      Calculando presupuesto global y avance por zonas…
    </div>`;

  try {
    const year = currentYear();
    const lines = await loadFinancialLines(year);

    if (sequence !== renderSequence) return;

    const states = applyFinancialLines(baseStates, lines);

    target.innerHTML = reportHtml(states, year);
  } catch (error) {
    console.error("No se pudo generar el Reporte presupuestal:", error);

    target.innerHTML = `
      <div class="alert alert-danger">
        No se pudo generar el Reporte presupuestal:
        ${escapeHtml(error.message)}
      </div>`;
  } finally {
    renderBusy = false;
  }
}

function printReport() {
  document.body.classList.add("purchase-budget-report-print");

  const cleanup = () => {
    document.body.classList.remove("purchase-budget-report-print");
    window.removeEventListener("afterprint", cleanup);
  };

  window.addEventListener("afterprint", cleanup);
  window.print();
  window.setTimeout(cleanup, 1600);
}

function scheduleAttach(delay = 0) {
  clearTimeout(scheduledTimer);

  scheduledTimer = window.setTimeout(() => {
    if (ensureReportTab() && reportTabActive) {
      renderReport();
    }
  }, delay);
}

function bindBodyObserver() {
  const body = document.querySelector(`#${BODY_ID}`);
  if (!body || body === boundBody) return Boolean(body);

  if (bodyObserver) {
    bodyObserver.disconnect();
  }

  boundBody = body;

  bodyObserver = new MutationObserver(() => {
    scheduleAttach(60);
  });

  bodyObserver.observe(body, {
    childList: true,
    subtree: false,
  });

  scheduleAttach(0);
  return true;
}

function start() {
  injectStyles();

  if (!bindBodyObserver()) {
    attachObserver = new MutationObserver(() => {
      if (bindBodyObserver()) {
        attachObserver.disconnect();
        attachObserver = null;
      }
    });

    attachObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  document.addEventListener("shown.bs.offcanvas", event => {
    if (event.target?.id !== PANEL_ID) return;
    bindBodyObserver();
    scheduleAttach(50);
  });

  document.addEventListener("shown.bs.tab", event => {
    if (event.target?.id === TAB_ID) {
      reportTabActive = true;
      renderReport();
      return;
    }

    if (
      event.target?.id === "budget-allocation-tab"
      || event.target?.id === "budget-spending-tab"
    ) {
      reportTabActive = false;
    }
  });

  document.addEventListener("click", event => {
    if (event.target.closest("#refreshBudgetVisualReport")) {
      renderReport();
      return;
    }

    if (event.target.closest("#printBudgetVisualReport")) {
      printReport();
      return;
    }

    if (
      event.target.closest("#refreshPurchaseBudgets, .budget-save-zone")
    ) {
      scheduleAttach(700);
    }
  });

  document.addEventListener("change", event => {
    if (event.target.matches("#purchaseBudgetYear")) {
      reportTabActive = false;
      scheduleAttach(700);
    }
  });
}

start();
