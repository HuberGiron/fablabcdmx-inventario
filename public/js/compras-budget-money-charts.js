import { db } from "./firebase-app.js";
import {
  collection,
  getDocs,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const PANEL_ID = "purchaseBudgetsPanel";
const REPORT_ID = "purchaseBudgetReport";
const CHARTS_ID = "purchaseBudgetMoneyCharts";
const STYLE_ID = "purchaseBudgetMoneyChartsStyles";

let panelObserver = null;
let reportObserver = null;
let observedReport = null;
let renderBusy = false;
let renderSeq = 0;
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

function formatMoney(value) {
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

function percentLabel(part, total) {
  if (num(total) <= 0) {
    return num(part) > 0 ? "Sin presupuesto" : "0%";
  }

  return `${percent(part, total).toLocaleString("es-MX", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })}%`;
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

function timestampToDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function budgetYear() {
  return (
    Number(document.querySelector("#purchaseBudgetYear")?.value)
    || new Date().getFullYear()
  );
}

function selectedZoneId() {
  return String(
    document.querySelector("#budgetFilterZone")?.value || "all"
  );
}

function displayMeta(rawCode, rawName) {
  const code = String(rawCode ?? "").trim();
  const name = String(rawName ?? "").trim();

  // Respeta la misma convención ya usada por compras-budget-ui-fix.js:
  // si el nombre comienza con el código público, éste manda sobre el ID técnico.
  const match = name.match(/^(\d+(?:\.\d+)*)(?:\.)?\s+(.+)$/);

  if (match) {
    return {
      rawCode: code,
      code: match[1],
      name: match[2].trim(),
    };
  }

  return {
    rawCode: code,
    code,
    name,
  };
}

function compareCodes(left, right) {
  const a = String(left || "")
    .split(".")
    .map(part => Number(part));

  const b = String(right || "")
    .split(".")
    .map(part => Number(part));

  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i += 1) {
    const av = Number.isFinite(a[i]) ? a[i] : -1;
    const bv = Number.isFinite(b[i]) ? b[i] : -1;

    if (av !== bv) return av - bv;
  }

  return String(left || "").localeCompare(
    String(right || ""),
    "es",
    {
      numeric: true,
      sensitivity: "base",
    }
  );
}

function createZoneState(zoneId, zoneName = "") {
  return {
    zoneId: String(zoneId || ""),
    zoneName: String(zoneName || ""),
    allocated: 0,
    ordered: 0,
    requisition: 0,
    received: 0,
  };
}

function usedAmount(state) {
  return (
    num(state.ordered)
    + num(state.requisition)
    + num(state.received)
  );
}

function availableAmount(state) {
  return num(state.allocated) - usedAmount(state);
}

function utilizationPercent(state) {
  if (num(state.allocated) <= 0) {
    return usedAmount(state) > 0 ? Infinity : 0;
  }

  return (usedAmount(state) / num(state.allocated)) * 100;
}

function budgetDocYearMatches(data, year) {
  return Number(data?.year) === Number(year);
}

async function loadZoneCatalog() {
  const snapshot = await getDocs(collection(db, "zones"));

  const map = new Map();

  snapshot.docs.forEach(zoneDoc => {
    const data = zoneDoc.data();
    const rawId = String(
      data.zoneId ?? data.code ?? zoneDoc.id ?? ""
    );

    const rawName = String(
      data.name ?? data.nombre ?? data.zoneName ?? ""
    );

    const meta = displayMeta(rawId, rawName);

    map.set(rawId, {
      rawId,
      code: meta.code,
      name: meta.name,
    });
  });

  return map;
}

async function loadAllocations(year) {
  const snapshot = await getDocs(
    query(
      collection(db, "purchaseBudgets"),
      where("year", "==", Number(year))
    )
  );

  const map = new Map();

  snapshot.docs.forEach(budgetDoc => {
    const data = budgetDoc.data();

    if (!budgetDocYearMatches(data, year)) return;

    const zoneId = String(data.zoneId || "");

    if (!zoneId) return;

    map.set(zoneId, {
      zoneId,
      zoneName: String(data.zoneName || ""),
      allocated: Math.max(num(data.allocatedAmount), 0),
    });
  });

  return map;
}

async function loadRequestLinesForYear(year) {
  const requestSnapshot = await getDocs(
    collection(db, "purchaseRequests")
  );

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

      return date
        ? date.getFullYear() === Number(year)
        : true;
    });

  const results = [];
  let cursor = 0;

  const runners = Array.from(
    {
      length: Math.min(6, Math.max(requests.length, 1)),
    },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= requests.length) break;

        const request = requests[index];

        const linesSnapshot = await getDocs(
          collection(
            db,
            "purchaseRequests",
            request.id,
            "items"
          )
        );

        linesSnapshot.docs.forEach(lineDoc => {
          results.push({
            requestId: request.id,
            requestFolio: request.folio || request.id,
            requestStatus: request.status,
            id: lineDoc.id,
            ...lineDoc.data(),
          });
        });
      }
    }
  );

  await Promise.all(runners);
  return results;
}

function summarizeByZone({
  zoneCatalog,
  allocations,
  lines,
}) {
  const states = new Map();

  const ensure = (zoneId, zoneName = "") => {
    const id = String(zoneId || "");
    if (!id) return null;

    if (!states.has(id)) {
      const catalog = zoneCatalog.get(id);

      states.set(
        id,
        createZoneState(
          id,
          catalog?.name || zoneName || `Zona ${id}`
        )
      );
    }

    return states.get(id);
  };

  for (const [zoneId, allocation] of allocations.entries()) {
    const state = ensure(
      zoneId,
      allocation.zoneName
    );

    if (!state) continue;
    state.allocated = Math.max(num(allocation.allocated), 0);
  }

  for (const line of lines) {
    const zoneId = String(line.zoneId || "");
    if (!zoneId) continue;

    // El presupuesto actual está expresado en MXN. Igual que el reporte
    // presupuestal existente, no mezclamos monedas extranjeras.
    const currency = String(line.currency || "MXN").toUpperCase();
    if (currency !== "MXN") continue;

    const state = ensure(zoneId, line.zoneName || "");
    if (!state) continue;

    const pending = linePendingQty(line);
    const pendingAmount = pending * linePendingUnitCost(line);
    const receivedAmount = lineActualSpent(line);

    if (receivedAmount > 0) {
      state.received += receivedAmount;
    }

    if (pendingAmount > 0) {
      if (line.requisitionStatus === "requisitioned") {
        state.requisition += pendingAmount;
      } else {
        state.ordered += pendingAmount;
      }
    }
  }

  return states;
}

function totalState(states) {
  const total = createZoneState("all", "Todas las zonas");

  for (const state of states) {
    total.allocated += num(state.allocated);
    total.ordered += num(state.ordered);
    total.requisition += num(state.requisition);
    total.received += num(state.received);
  }

  return total;
}

function visibleStates(states, zoneCatalog) {
  const selected = selectedZoneId();

  const list = [...states.values()]
    .filter(state =>
      num(state.allocated) > 0
      || usedAmount(state) > 0
    )
    .map(state => {
      const meta =
        zoneCatalog.get(state.zoneId)
        || displayMeta(state.zoneId, state.zoneName);

      return {
        ...state,
        displayCode: meta.code || state.zoneId,
        displayName: meta.name || state.zoneName,
      };
    })
    .sort((a, b) =>
      compareCodes(a.displayCode, b.displayCode)
      || String(a.displayName).localeCompare(
        String(b.displayName),
        "es",
        { sensitivity: "base" }
      )
    );

  if (selected === "all") return list;

  return list.filter(state => state.zoneId === selected);
}

function donutBackground(state) {
  const allocated = num(state.allocated);
  const ordered = num(state.ordered);
  const requisition = num(state.requisition);
  const received = num(state.received);

  if (allocated <= 0) {
    return "conic-gradient(#e9ecef 0 100%)";
  }

  const requestedPct = Math.max(0, Math.min(100, percent(ordered, allocated)));
  const requisitionPct = Math.max(
    0,
    Math.min(100 - requestedPct, percent(requisition, allocated))
  );

  const receivedPct = Math.max(
    0,
    Math.min(
      100 - requestedPct - requisitionPct,
      percent(received, allocated)
    )
  );

  const reqEnd = requestedPct;
  const requisitionEnd = reqEnd + requisitionPct;
  const receivedEnd = requisitionEnd + receivedPct;

  return `conic-gradient(
    #f0ad00 0 ${reqEnd}%,
    #0d6efd ${reqEnd}% ${requisitionEnd}%,
    #198754 ${requisitionEnd}% ${receivedEnd}%,
    #dfe3e8 ${receivedEnd}% 100%
  )`;
}

function legendCardHtml(
  label,
  amount,
  allocated,
  cssClass
) {
  return `
    <div class="budget-money-legend-card">
      <span class="budget-money-dot ${cssClass}"></span>

      <div>
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(formatMoney(amount))}</strong>
        <small>${escapeHtml(percentLabel(amount, allocated))}</small>
      </div>
    </div>`;
}

function primaryChartHtml(state, title) {
  const allocated = num(state.allocated);
  const used = usedAmount(state);
  const available = availableAmount(state);
  const utilization = utilizationPercent(state);
  const over = Math.max(-available, 0);

  const orderedPct =
    allocated > 0
      ? Math.max(0, percent(state.ordered, allocated))
      : 0;

  const requisitionPct =
    allocated > 0
      ? Math.max(0, percent(state.requisition, allocated))
      : 0;

  const receivedPct =
    allocated > 0
      ? Math.max(0, percent(state.received, allocated))
      : 0;

  const availablePct =
    allocated > 0
      ? Math.max(0, percent(Math.max(available, 0), allocated))
      : 0;

  const barScale = Math.max(
    allocated,
    used,
    0.01
  );

  return `
    <section class="budget-money-main-card">
      <div class="budget-money-main-head">
        <div>
          <div class="budget-money-eyebrow">
            Avance presupuestal · ${escapeHtml(title)}
          </div>

          <h4>${escapeHtml(formatMoney(allocated))}</h4>

          <div class="small text-muted">
            Presupuesto asignado = 100%.
          </div>
        </div>

        <div class="budget-money-utilization ${over > 0 ? "is-over" : ""}">
          <span>Presupuesto utilizado</span>

          <strong>
            ${
              Number.isFinite(utilization)
                ? `${utilization.toLocaleString("es-MX", {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 1,
                  })}%`
                : "Sin presupuesto"
            }
          </strong>

          <small>
            ${
              over > 0
                ? `Sobreejercicio: ${escapeHtml(formatMoney(over))}`
                : `Disponible: ${escapeHtml(formatMoney(Math.max(available, 0)))}`
            }
          </small>
        </div>
      </div>

      <div class="budget-money-main-grid">
        <div class="budget-money-donut-wrap">
          <div class="budget-money-donut"
               style="background:${donutBackground(state)}">
            <div class="budget-money-donut-center">
              <span>Asignado</span>
              <strong>100%</strong>
              <small>
                Ejercido ${escapeHtml(percentLabel(state.received, allocated))}
              </small>
            </div>
          </div>
        </div>

        <div>
          <div class="budget-money-legend">
            ${legendCardHtml(
              "Solicitado / por requisitar",
              state.ordered,
              allocated,
              "ordered"
            )}

            ${legendCardHtml(
              "En requisición",
              state.requisition,
              allocated,
              "requisition"
            )}

            ${legendCardHtml(
              "Entregado / ejercido",
              state.received,
              allocated,
              "received"
            )}

            ${legendCardHtml(
              over > 0 ? "Sobreejercicio" : "Disponible",
              over > 0 ? over : Math.max(available, 0),
              allocated,
              over > 0 ? "over" : "available"
            )}
          </div>

          <div class="budget-money-bar-title">
            <span>Distribución del presupuesto asignado</span>
            <strong>
              ${escapeHtml(formatMoney(used))}
              usados de
              ${escapeHtml(formatMoney(allocated))}
            </strong>
          </div>

          <div class="budget-money-stack">
            ${
              state.ordered > 0
                ? `<div class="budget-money-segment ordered"
                        style="width:${(state.ordered / barScale) * 100}%"
                        title="Solicitado: ${formatMoney(state.ordered)}"></div>`
                : ""
            }

            ${
              state.requisition > 0
                ? `<div class="budget-money-segment requisition"
                        style="width:${(state.requisition / barScale) * 100}%"
                        title="En requisición: ${formatMoney(state.requisition)}"></div>`
                : ""
            }

            ${
              state.received > 0
                ? `<div class="budget-money-segment received"
                        style="width:${(state.received / barScale) * 100}%"
                        title="Recibido: ${formatMoney(state.received)}"></div>`
                : ""
            }

            ${
              available > 0
                ? `<div class="budget-money-segment available"
                        style="width:${(available / barScale) * 100}%"
                        title="Disponible: ${formatMoney(available)}"></div>`
                : ""
            }
          </div>

          ${
            over > 0
              ? `<div class="budget-money-over-warning">
                   El compromiso + gasto supera el presupuesto asignado por
                   <strong>${escapeHtml(formatMoney(over))}</strong>.
                 </div>`
              : ""
          }
        </div>
      </div>
    </section>`;
}

function zoneRowHtml(state) {
  const allocated = num(state.allocated);
  const used = usedAmount(state);
  const available = availableAmount(state);
  const over = Math.max(-available, 0);

  const denominator = Math.max(
    allocated,
    used,
    0.01
  );

  return `
    <article class="budget-money-zone-row">
      <div class="budget-money-zone-head">
        <div>
          <strong>
            Zona ${escapeHtml(state.displayCode)}
            ·
            ${escapeHtml(state.displayName)}
          </strong>

          <div class="small text-muted">
            Asignado:
            ${escapeHtml(formatMoney(allocated))}
          </div>
        </div>

        <div class="text-end">
          <strong>
            ${
              allocated > 0
                ? `${percent(used, allocated).toLocaleString("es-MX", {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 1,
                  })}% utilizado`
                : (
                    used > 0
                      ? "Sin presupuesto asignado"
                      : "0% utilizado"
                  )
            }
          </strong>

          <div class="small ${over > 0 ? "text-danger fw-semibold" : "text-muted"}">
            ${
              over > 0
                ? `Faltan ${escapeHtml(formatMoney(over))}`
                : `Disponible ${escapeHtml(formatMoney(Math.max(available, 0)))}`
            }
          </div>
        </div>
      </div>

      <div class="budget-money-zone-stack">
        ${
          state.ordered > 0
            ? `<div class="ordered"
                    style="width:${(state.ordered / denominator) * 100}%"
                    title="Solicitado: ${formatMoney(state.ordered)}"></div>`
            : ""
        }

        ${
          state.requisition > 0
            ? `<div class="requisition"
                    style="width:${(state.requisition / denominator) * 100}%"
                    title="En requisición: ${formatMoney(state.requisition)}"></div>`
            : ""
        }

        ${
          state.received > 0
            ? `<div class="received"
                    style="width:${(state.received / denominator) * 100}%"
                    title="Recibido: ${formatMoney(state.received)}"></div>`
            : ""
        }

        ${
          available > 0
            ? `<div class="available"
                    style="width:${(available / denominator) * 100}%"
                    title="Disponible: ${formatMoney(available)}"></div>`
            : ""
        }
      </div>

      <div class="budget-money-zone-values">
        <span>
          <i class="ordered"></i>
          Solicitado
          <strong>${escapeHtml(formatMoney(state.ordered))}</strong>
          (${escapeHtml(percentLabel(state.ordered, allocated))})
        </span>

        <span>
          <i class="requisition"></i>
          Requisición
          <strong>${escapeHtml(formatMoney(state.requisition))}</strong>
          (${escapeHtml(percentLabel(state.requisition, allocated))})
        </span>

        <span>
          <i class="received"></i>
          Entregado
          <strong>${escapeHtml(formatMoney(state.received))}</strong>
          (${escapeHtml(percentLabel(state.received, allocated))})
        </span>

        <span>
          <i class="${over > 0 ? "over" : "available"}"></i>
          ${over > 0 ? "Sobreejercicio" : "Disponible"}
          <strong>
            ${escapeHtml(
              formatMoney(
                over > 0
                  ? over
                  : Math.max(available, 0)
              )
            )}
          </strong>
        </span>
      </div>
    </article>`;
}

function chartsHtml({
  focusState,
  focusTitle,
  zoneStates,
  year,
}) {
  return `
    <section id="${CHARTS_ID}" class="budget-money-charts">
      <div class="budget-money-section-title">
        <div>
          <h5 class="mb-1">Avance real del presupuesto · ${year}</h5>

          <div class="small text-muted">
            El presupuesto asignado es la base. Se separa en solicitado,
            requisición, entregado/ejercido y disponible.
          </div>
        </div>
      </div>

      ${primaryChartHtml(
        focusState,
        focusTitle
      )}

      <section class="budget-money-zones-card">
        <div class="d-flex flex-wrap justify-content-between align-items-end gap-2 mb-3">
          <div>
            <h6 class="mb-1">
              Avance por zona
            </h6>

            <div class="small text-muted">
              Cada barra usa como referencia el presupuesto asignado a esa zona.
            </div>
          </div>

          <div class="budget-money-mini-legend">
            <span><i class="ordered"></i>Solicitado</span>
            <span><i class="requisition"></i>Requisición</span>
            <span><i class="received"></i>Entregado</span>
            <span><i class="available"></i>Disponible</span>
          </div>
        </div>

        <div class="budget-money-zone-list">
          ${
            zoneStates.length
              ? zoneStates.map(zoneRowHtml).join("")
              : `<div class="text-muted small">
                   No hay presupuesto ni movimientos para las zonas seleccionadas.
                 </div>`
          }
        </div>
      </section>
    </section>`;
}

function injectStyles() {
  if (document.querySelector(`#${STYLE_ID}`)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;

  style.textContent = `
    .budget-money-charts {
      margin:1rem 0 1.25rem;
    }

    .budget-money-section-title {
      margin-bottom:.8rem;
    }

    .budget-money-main-card,
    .budget-money-zones-card {
      border:1px solid #d9dde3;
      border-radius:.85rem;
      background:#fff;
      padding:1rem;
      margin-bottom:1rem;
      box-shadow:0 1px 2px rgba(0,0,0,.03);
    }

    .budget-money-main-head {
      display:flex;
      flex-wrap:wrap;
      justify-content:space-between;
      gap:.75rem 1rem;
      align-items:flex-start;
      margin-bottom:1rem;
    }

    .budget-money-eyebrow {
      color:#6c757d;
      font-size:.74rem;
      font-weight:700;
      text-transform:uppercase;
      letter-spacing:.035em;
    }

    .budget-money-main-head h4 {
      margin:.15rem 0 .15rem;
      font-size:1.6rem;
      font-weight:750;
    }

    .budget-money-utilization {
      min-width:220px;
      border:1px solid #b6d4fe;
      border-left:5px solid #0d6efd;
      border-radius:.65rem;
      padding:.6rem .75rem;
      background:#f4f8ff;
      text-align:right;
    }

    .budget-money-utilization.is-over {
      border-color:#f1aeb5;
      border-left-color:#dc3545;
      background:#fff5f5;
    }

    .budget-money-utilization span,
    .budget-money-utilization small {
      display:block;
      color:#6c757d;
      font-size:.73rem;
    }

    .budget-money-utilization strong {
      display:block;
      font-size:1.35rem;
    }

    .budget-money-utilization.is-over strong,
    .budget-money-utilization.is-over small {
      color:#b02a37;
    }

    .budget-money-main-grid {
      display:grid;
      grid-template-columns:225px 1fr;
      gap:1rem 1.25rem;
      align-items:center;
    }

    .budget-money-donut-wrap {
      display:flex;
      justify-content:center;
      align-items:center;
    }

    .budget-money-donut {
      width:190px;
      height:190px;
      border-radius:50%;
      display:grid;
      place-items:center;
      position:relative;
    }

    .budget-money-donut::after {
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

    .budget-money-donut-center {
      position:relative;
      z-index:1;
      width:104px;
      text-align:center;
    }

    .budget-money-donut-center span,
    .budget-money-donut-center small {
      display:block;
      color:#6c757d;
      font-size:.7rem;
    }

    .budget-money-donut-center strong {
      display:block;
      font-size:1.4rem;
      line-height:1.1;
      margin:.12rem 0;
    }

    .budget-money-legend {
      display:grid;
      grid-template-columns:repeat(4,minmax(0,1fr));
      gap:.6rem;
    }

    .budget-money-legend-card {
      display:grid;
      grid-template-columns:12px 1fr;
      gap:.5rem;
      border:1px solid #e2e5e9;
      border-radius:.65rem;
      background:#fafbfc;
      padding:.6rem;
    }

    .budget-money-legend-card > div > span {
      display:block;
      color:#6c757d;
      font-size:.7rem;
    }

    .budget-money-legend-card strong {
      display:block;
      margin:.08rem 0;
      font-size:.82rem;
    }

    .budget-money-legend-card small {
      color:#6c757d;
      font-weight:700;
    }

    .budget-money-dot {
      width:10px;
      height:10px;
      border-radius:50%;
      margin-top:.22rem;
    }

    .budget-money-dot.ordered,
    .budget-money-zone-values i.ordered,
    .budget-money-mini-legend i.ordered {
      background:#f0ad00;
    }

    .budget-money-dot.requisition,
    .budget-money-zone-values i.requisition,
    .budget-money-mini-legend i.requisition {
      background:#0d6efd;
    }

    .budget-money-dot.received,
    .budget-money-zone-values i.received,
    .budget-money-mini-legend i.received {
      background:#198754;
    }

    .budget-money-dot.available,
    .budget-money-zone-values i.available,
    .budget-money-mini-legend i.available {
      background:#dfe3e8;
    }

    .budget-money-dot.over,
    .budget-money-zone-values i.over {
      background:#dc3545;
    }

    .budget-money-bar-title {
      display:flex;
      flex-wrap:wrap;
      justify-content:space-between;
      gap:.5rem;
      margin:.85rem 0 .35rem;
      font-size:.78rem;
    }

    .budget-money-stack,
    .budget-money-zone-stack {
      display:flex;
      width:100%;
      overflow:hidden;
      border-radius:999px;
      background:#e9ecef;
      box-shadow:inset 0 0 0 1px rgba(0,0,0,.035);
    }

    .budget-money-stack {
      min-height:24px;
    }

    .budget-money-zone-stack {
      min-height:16px;
    }

    .budget-money-segment,
    .budget-money-zone-stack > div {
      min-width:0;
    }

    .budget-money-segment.ordered,
    .budget-money-zone-stack > .ordered {
      background:#f0ad00;
    }

    .budget-money-segment.requisition,
    .budget-money-zone-stack > .requisition {
      background:#0d6efd;
    }

    .budget-money-segment.received,
    .budget-money-zone-stack > .received {
      background:#198754;
    }

    .budget-money-segment.available,
    .budget-money-zone-stack > .available {
      background:#dfe3e8;
    }

    .budget-money-over-warning {
      margin-top:.6rem;
      padding:.55rem .7rem;
      border:1px solid #f1aeb5;
      border-radius:.55rem;
      background:#fff5f5;
      color:#b02a37;
      font-size:.8rem;
    }

    .budget-money-mini-legend {
      display:flex;
      flex-wrap:wrap;
      gap:.35rem .8rem;
      color:#6c757d;
      font-size:.72rem;
    }

    .budget-money-mini-legend span {
      display:inline-flex;
      align-items:center;
      gap:.28rem;
    }

    .budget-money-mini-legend i,
    .budget-money-zone-values i {
      display:inline-block;
      width:8px;
      height:8px;
      border-radius:50%;
      flex:0 0 auto;
    }

    .budget-money-zone-list {
      display:flex;
      flex-direction:column;
      gap:.65rem;
    }

    .budget-money-zone-row {
      border:1px solid #e2e5e9;
      border-radius:.7rem;
      padding:.7rem .8rem;
      break-inside:avoid;
    }

    .budget-money-zone-head {
      display:flex;
      flex-wrap:wrap;
      justify-content:space-between;
      gap:.5rem 1rem;
      align-items:flex-start;
      margin-bottom:.45rem;
    }

    .budget-money-zone-values {
      display:flex;
      flex-wrap:wrap;
      gap:.3rem 1rem;
      margin-top:.42rem;
      color:#6c757d;
      font-size:.71rem;
    }

    .budget-money-zone-values span {
      display:inline-flex;
      flex-wrap:wrap;
      align-items:center;
      gap:.25rem;
    }

    .budget-money-zone-values strong {
      color:#343a40;
    }

    @media (max-width:1199.98px) {
      .budget-money-legend {
        grid-template-columns:repeat(2,minmax(0,1fr));
      }
    }

    @media (max-width:991.98px) {
      .budget-money-main-grid {
        grid-template-columns:1fr;
      }
    }

    @media (max-width:575.98px) {
      .budget-money-legend {
        grid-template-columns:1fr;
      }

      .budget-money-utilization {
        width:100%;
        text-align:left;
      }

      .budget-money-main-head h4 {
        font-size:1.3rem;
      }
    }

    @media print {
      .budget-money-main-card,
      .budget-money-zones-card,
      .budget-money-zone-row {
        box-shadow:none !important;
        break-inside:avoid;
      }

      .budget-money-donut,
      .budget-money-segment,
      .budget-money-zone-stack > div,
      .budget-money-dot,
      .budget-money-zone-values i,
      .budget-money-mini-legend i {
        -webkit-print-color-adjust:exact !important;
        print-color-adjust:exact !important;
      }
    }
  `;

  document.head.appendChild(style);
}

function reportReady() {
  const report = document.querySelector(`#${REPORT_ID}`);
  if (!report) return false;

  return Boolean(
    report.querySelector(".purchase-budget-summary-grid")
    || report.querySelector(".purchase-budget-report-table")
  );
}

async function renderCharts() {
  const report = document.querySelector(`#${REPORT_ID}`);

  if (
    !report
    || !reportReady()
    || renderBusy
  ) {
    return;
  }

  const existing = report.querySelector(`#${CHARTS_ID}`);
  if (existing) {
    existing.remove();
  }

  renderBusy = true;
  const seq = ++renderSeq;

  try {
    const year = budgetYear();

    const [
      zoneCatalog,
      allocations,
      lines,
    ] = await Promise.all([
      loadZoneCatalog(),
      loadAllocations(year),
      loadRequestLinesForYear(year),
    ]);

    if (
      seq !== renderSeq
      || !document.body.contains(report)
    ) {
      return;
    }

    const states = summarizeByZone({
      zoneCatalog,
      allocations,
      lines,
    });

    const zones = visibleStates(
      states,
      zoneCatalog
    );

    const selected = selectedZoneId();

    let focusState;
    let focusTitle;

    if (selected === "all") {
      focusState = totalState(
        [...states.values()]
      );

      focusTitle = "Todas las zonas";
    } else {
      focusState =
        states.get(selected)
        || createZoneState(
          selected,
          zoneCatalog.get(selected)?.name || `Zona ${selected}`
        );

      const meta =
        zoneCatalog.get(selected)
        || displayMeta(
          selected,
          focusState.zoneName
        );

      focusTitle =
        `Zona ${meta.code} · ${meta.name}`;
    }

    const wrapper = document.createElement("div");

    wrapper.innerHTML = chartsHtml({
      focusState,
      focusTitle,
      zoneStates: zones,
      year,
    });

    const charts = wrapper.firstElementChild;

    // Insertamos después del resumen numérico existente y antes del detalle
    // Zona/Subzona/Área.
    const summary =
      report.querySelector(".purchase-budget-summary-grid");

    if (summary) {
      summary.insertAdjacentElement(
        "afterend",
        charts
      );
    } else {
      report.prepend(charts);
    }
  } catch (error) {
    console.error(
      "No se pudieron generar las gráficas de Presupuestos:",
      error
    );

    const warning = document.createElement("div");
    warning.id = CHARTS_ID;
    warning.className = "alert alert-warning";
    warning.textContent =
      `No se pudieron cargar las gráficas del presupuesto: ${error.message}`;

    report.prepend(warning);
  } finally {
    renderBusy = false;
  }
}

function scheduleRender(delay = 160) {
  clearTimeout(scheduledTimer);

  scheduledTimer = window.setTimeout(() => {
    renderCharts();
  }, delay);
}

function observeReport() {
  const report = document.querySelector(`#${REPORT_ID}`);

  if (!report || report === observedReport) {
    return Boolean(report);
  }

  if (reportObserver) {
    reportObserver.disconnect();
  }

  observedReport = report;

  reportObserver = new MutationObserver(mutations => {
    const meaningful =
      mutations.some(
        mutation =>
          mutation.type === "childList"
          && (
            mutation.addedNodes.length
            || mutation.removedNodes.length
          )
      );

    if (!meaningful) return;

    // compras-status.js puede regenerar todo el reporte al cambiar filtros.
    // Si nuestras gráficas desaparecieron, las volvemos a construir.
    if (!report.querySelector(`#${CHARTS_ID}`)) {
      scheduleRender(80);
    }
  });

  reportObserver.observe(report, {
    childList: true,
    subtree: false,
  });

  scheduleRender(80);
  return true;
}

function attachPanel() {
  const panel = document.querySelector(`#${PANEL_ID}`);

  if (!panel) return false;

  if (!panel.dataset.budgetMoneyChartsBound) {
    panel.dataset.budgetMoneyChartsBound = "1";

    panel.addEventListener("shown.bs.offcanvas", () => {
      observeReport();
      scheduleRender(120);
    });
  }

  observeReport();
  return true;
}

function start() {
  injectStyles();

  if (!attachPanel()) {
    panelObserver = new MutationObserver(() => {
      if (attachPanel()) {
        panelObserver.disconnect();
        panelObserver = null;
      }
    });

    panelObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  document.addEventListener("change", event => {
    if (
      event.target.matches(
        "#budgetFilterZone, #budgetFilterSubzone, #budgetFilterArea, #purchaseBudgetYear"
      )
    ) {
      // Para las gráficas, Zona define el presupuesto asignado.
      // Subzona/Área siguen afectando la tabla existente, pero la gráfica
      // conserva la lectura presupuestal completa de la Zona.
      scheduleRender(250);
    }
  });

  document.addEventListener("click", event => {
    if (
      event.target.closest(
        "#refreshPurchaseBudgets, .budget-save-zone, [data-bs-target='#purchaseBudgetSpendingPane']"
      )
    ) {
      scheduleRender(650);
    }
  });
}

start();
