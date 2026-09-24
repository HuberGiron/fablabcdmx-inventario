import { auth, db } from "./firebase-app.js";
import { getUserProfile } from "./common.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const STYLE_ID = "purchaseRequestStageToolsStyles";
const PRICE_MODAL_ID = "purchaseRequestPriceModal";

let currentRole = "";
let currentProfile = null;
let activeRequestId = "";
let activeRequest = null;
let activeLines = [];
let decorationToken = 0;
let contentObserver = null;
let observedContent = null;
let reopenDetailAfterPrice = false;
let reopenDetailRequestId = "";

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

function requestIdFromDetail() {
  return String(
    document.querySelector("#purchaseRequestDetailPdf")?.dataset?.requestId || ""
  );
}

function selectedStages() {
  const checks = [
    ...document.querySelectorAll(
      "#requestStageFilterGroup .request-stage-filter-check"
    ),
  ];

  if (!checks.length) {
    return new Set(["ordered", "requisition", "received", "cancelled"]);
  }

  return new Set(
    checks
      .filter(check => check.checked)
      .map(check => String(check.value))
  );
}

function stagesForLine(line) {
  const stages = new Set();
  const pending = linePendingQty(line);
  const received = Math.max(num(line?.quantityReceived), 0);
  const cancelled = Math.max(num(line?.quantityCancelled), 0);
  const requisitioned = line?.requisitionStatus === "requisitioned";

  // "Solicitado / sin requisición" = aún hay pendiente y todavía no pasó
  // a requisición. Es precisamente la lista útil para saber qué falta tramitar.
  if (pending > 0 && !requisitioned) {
    stages.add("ordered");
  }

  // "En requisición" representa las piezas que siguen pendientes después de
  // haber sido formalmente requisitadas.
  if (pending > 0 && requisitioned) {
    stages.add("requisition");
  }

  // "Con recepción" incluye recepción parcial o total.
  if (received > 0) {
    stages.add("received");
  }

  // Cancelado puede coexistir con otros estados cuando fue parcial.
  if (cancelled > 0) {
    stages.add("cancelled");
  }

  return stages;
}

function stageMatches(line, selected = selectedStages()) {
  if (!selected.size) return false;
  const lineStages = stagesForLine(line);
  return [...lineStages].some(stage => selected.has(stage));
}

function stageLabel(line) {
  const stages = stagesForLine(line);
  const labels = [];

  if (stages.has("ordered")) labels.push("Solicitado / sin requisición");
  if (stages.has("requisition")) labels.push("En requisición");
  if (stages.has("received")) labels.push("Con recepción");
  if (stages.has("cancelled")) labels.push("Cancelado");

  return labels.join(" · ") || "Sin movimiento";
}

function searchMatches(line) {
  const query = normalizeText(
    document.querySelector("#requestDetailSearch")?.value || ""
  );
  if (!query) return true;

  const tokens = query.split(/\s+/).filter(Boolean);
  const haystack = normalizeText([
    line?.nombre,
    line?.sku,
    line?.zoneId,
    line?.zoneName,
    line?.subzoneId,
    line?.subzoneName,
    line?.locationCode,
    line?.locationName,
  ].filter(Boolean).join(" "));

  return tokens.every(token => haystack.includes(token));
}

function filteredLines() {
  const selected = selectedStages();
  return activeLines.filter(
    line => searchMatches(line) && stageMatches(line, selected)
  );
}

function lineBySku(sku) {
  const key = String(sku || "").trim();
  if (!key) return null;
  return activeLines.find(line => String(line.sku || "").trim() === key) || null;
}

function groupLinesByName(lines = activeLines) {
  const groups = new Map();

  for (const line of lines) {
    const name = String(line?.nombre || line?.sku || "Item").trim();
    const key = normalizeText(name);

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name,
        lines: [],
      });
    }

    groups.get(key).lines.push(line);
  }

  return groups;
}

async function loadRole() {
  const user = auth.currentUser;
  if (!user) return;

  try {
    currentProfile = await getUserProfile(user.uid);
    currentRole = currentProfile?.appRole || currentProfile?.role || "";
  } catch (error) {
    console.warn("No se pudo obtener el rol para herramientas de solicitud:", error);
  }
}

async function loadRequestData(requestId) {
  if (!requestId) return;

  const [requestSnap, linesSnap] = await Promise.all([
    getDoc(doc(db, "purchaseRequests", requestId)),
    getDocs(collection(db, "purchaseRequests", requestId, "items")),
  ]);

  if (!requestSnap.exists()) {
    throw new Error("La solicitud ya no existe.");
  }

  activeRequestId = requestId;
  activeRequest = {
    id: requestSnap.id,
    ...requestSnap.data(),
  };

  activeLines = linesSnap.docs.map(lineDoc => ({
    id: lineDoc.id,
    ...lineDoc.data(),
  }));
}

function injectStyles() {
  if (document.querySelector(`#${STYLE_ID}`)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .request-stage-tools {
      margin-top:.75rem;
      padding:.75rem .85rem;
      border:1px solid #d9dde3;
      border-radius:.7rem;
      background:#f8f9fa;
    }
    .request-stage-filter-row {
      display:flex;
      flex-wrap:wrap;
      align-items:center;
      gap:.55rem 1rem;
    }
    .request-stage-filter-row .form-check {
      margin:0;
      min-height:auto;
    }
    .request-stage-filter-row .form-check-label {
      cursor:pointer;
      white-space:nowrap;
    }
    .request-stage-filter-row .form-check-input {
      cursor:pointer;
      margin-top:.18rem;
    }
    .request-stage-tools-meta {
      color:#6c757d;
      font-size:.82rem;
    }
    .request-stage-hidden {
      display:none !important;
    }
    .request-stage-row-hidden {
      display:none !important;
    }
    .request-stage-group-meta {
      margin:.55rem 0 0;
      color:#6c757d;
      font-size:.8rem;
    }
    .request-price-action {
      margin-left:.1rem;
    }
    .request-group-price-wrap {
      display:flex;
      flex-wrap:wrap;
      gap:.5rem;
      align-items:center;
      margin-top:.65rem;
    }
    #${PRICE_MODAL_ID} .modal-dialog {
      max-width:1200px;
    }
    .request-price-table th {
      white-space:nowrap;
      vertical-align:middle;
    }
    .request-price-table td {
      vertical-align:middle;
    }
    .request-price-area {
      min-width:280px;
      max-width:420px;
      white-space:normal;
      line-height:1.25;
    }
    .request-price-input {
      min-width:140px;
    }
    @media (max-width:767.98px) {
      .request-stage-filter-row {
        align-items:flex-start;
      }
      .request-stage-tools .btn {
        width:100%;
      }
    }
  `;
  document.head.appendChild(style);
}

function ensureStageToolbar() {
  const toolbar = document.querySelector("#requestGroupingToolbar");
  if (!toolbar) return;

  let tools = toolbar.querySelector(".request-stage-tools");
  if (tools) return;

  tools = document.createElement("div");
  tools.className = "request-stage-tools";

  tools.innerHTML = `
    <div class="d-flex flex-wrap justify-content-between gap-2 align-items-start">
      <div>
        <div class="fw-semibold mb-1">Filtrar por etapa</div>
        <div id="requestStageFilterGroup" class="request-stage-filter-row">
          <div class="form-check">
            <input class="form-check-input request-stage-filter-check"
                   type="checkbox"
                   value="ordered"
                   id="requestStageOrdered"
                   checked>
            <label class="form-check-label" for="requestStageOrdered">
              Solicitados / sin requisición
            </label>
          </div>

          <div class="form-check">
            <input class="form-check-input request-stage-filter-check"
                   type="checkbox"
                   value="requisition"
                   id="requestStageRequisition"
                   checked>
            <label class="form-check-label" for="requestStageRequisition">
              En requisición
            </label>
          </div>

          <div class="form-check">
            <input class="form-check-input request-stage-filter-check"
                   type="checkbox"
                   value="received"
                   id="requestStageReceived"
                   checked>
            <label class="form-check-label" for="requestStageReceived">
              Con recepción
            </label>
          </div>

          <div class="form-check">
            <input class="form-check-input request-stage-filter-check"
                   type="checkbox"
                   value="cancelled"
                   id="requestStageCancelled"
                   checked>
            <label class="form-check-label" for="requestStageCancelled">
              Cancelados
            </label>
          </div>
        </div>

        <div class="request-stage-tools-meta mt-2" id="requestStageFilterCount"></div>
      </div>

      <div class="d-flex flex-wrap gap-2">
        <button type="button"
                class="btn btn-outline-secondary btn-sm"
                id="requestStageSelectAll">
          Mostrar todos
        </button>

        <button type="button"
                class="btn btn-outline-dark btn-sm"
                id="requestPrintFiltered">
          Imprimir filtrados
        </button>
      </div>
    </div>`;

  toolbar.appendChild(tools);
}

function extendedCards() {
  const content = document.querySelector("#requestGroupingContent");
  if (!content) return [];

  return [...content.querySelectorAll(".request-line-row")]
    .filter(card => !card.classList.contains("grouped-request-card"));
}

function groupedCards() {
  const content = document.querySelector("#requestGroupingContent");
  if (!content) return [];
  return [...content.querySelectorAll(".grouped-request-card")];
}

function skuFromExtendedCard(card) {
  const meta = String(
    card.querySelector(".request-line-meta")?.textContent || ""
  );

  return meta.split("·")[0].trim();
}

function skuFromGroupedRow(row) {
  return String(
    row.querySelector("td:first-child strong")?.textContent
      || row.querySelector("td:first-child")?.textContent
      || ""
  ).trim();
}

function decorateExtendedPriceButtons() {
  if (currentRole !== "admin") return;

  for (const card of extendedCards()) {
    if (card.querySelector(".request-price-action")) continue;

    const sku = skuFromExtendedCard(card);
    const line = lineBySku(sku);
    if (!line) continue;

    let actions = [...card.querySelectorAll(".d-flex.flex-wrap.gap-2.mt-3")]
      .at(-1);

    if (!actions) {
      actions = document.createElement("div");
      actions.className = "d-flex flex-wrap gap-2 mt-3";
      card.appendChild(actions);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-outline-secondary btn-sm request-price-action";
    button.dataset.lineId = line.id;
    button.textContent = "Cambiar precio";

    actions.appendChild(button);
  }
}

function decorateGroupedPriceButtons() {
  if (currentRole !== "admin") return;

  const groups = groupLinesByName();

  for (const card of groupedCards()) {
    if (card.querySelector(".request-group-price-wrap")) continue;

    const groupName = String(
      card.querySelector(".request-line-title")?.textContent || ""
    ).trim();

    const group = groups.get(normalizeText(groupName));
    if (!group) continue;

    const wrap = document.createElement("div");
    wrap.className = "request-group-price-wrap";

    wrap.innerHTML = `
      <button type="button"
              class="btn btn-outline-secondary btn-sm request-group-price"
              data-group-name="${escapeHtml(groupName)}">
        Cambiar precio (${group.lines.length} SKU)
      </button>

      <span class="small text-muted">
        Cambia el precio vigente de uno o varios SKU de este producto.
      </span>`;

    const batchActions = card.querySelector(".purchase-group-batch-actions");
    const breakdown =
      [...card.querySelectorAll(".mt-3")]
        .find(node =>
          String(node.textContent || "").includes("Desglose por SKU")
        );

    if (batchActions) {
      batchActions.insertAdjacentElement("afterend", wrap);
    } else if (breakdown) {
      card.insertBefore(wrap, breakdown);
    } else {
      card.appendChild(wrap);
    }
  }
}

function applyStageFilters() {
  ensureStageToolbar();

  const selected = selectedStages();
  let visibleLineCount = 0;

  // Vista extendida: cada tarjeta corresponde a un SKU/línea.
  for (const card of extendedCards()) {
    const line = lineBySku(skuFromExtendedCard(card));
    if (!line) continue;

    const visible = stageMatches(line, selected);
    card.classList.toggle("request-stage-hidden", !visible);

    if (visible && searchMatches(line)) {
      visibleLineCount += 1;
    }
  }

  // Vista agrupada: se conserva el producto si AL MENOS un SKU del grupo
  // coincide. Dentro de su tabla se ocultan los SKU que no coinciden.
  const groups = groupLinesByName();

  for (const card of groupedCards()) {
    const groupName = String(
      card.querySelector(".request-line-title")?.textContent || ""
    ).trim();

    const group = groups.get(normalizeText(groupName));
    if (!group) continue;

    const matchingLines = group.lines.filter(
      line => stageMatches(line, selected)
    );

    card.classList.toggle(
      "request-stage-hidden",
      matchingLines.length === 0
    );

    const matchingSkus = new Set(
      matchingLines.map(line => String(line.sku || "").trim())
    );

    const rows = [
      ...card.querySelectorAll(".grouped-breakdown-table tbody tr"),
    ];

    rows.forEach(row => {
      const sku = skuFromGroupedRow(row);
      row.classList.toggle(
        "request-stage-row-hidden",
        !matchingSkus.has(sku)
      );
    });

    let meta = card.querySelector(".request-stage-group-meta");
    if (!meta) {
      meta = document.createElement("div");
      meta.className = "request-stage-group-meta";
      const tableWrap = card.querySelector(".table-responsive");
      if (tableWrap) {
        tableWrap.insertAdjacentElement("beforebegin", meta);
      }
    }

    if (meta) {
      meta.textContent =
        `${matchingLines.length} de ${group.lines.length} SKU visibles por etapa.`;
    }

    visibleLineCount += matchingLines.filter(searchMatches).length;
  }

  const totalMatching = filteredLines().length;
  const count = document.querySelector("#requestStageFilterCount");

  if (count) {
    count.textContent =
      `${totalMatching} línea${totalMatching === 1 ? "" : "s"} coinciden con búsqueda + etapa.`;
  }

  decorateExtendedPriceButtons();
  decorateGroupedPriceButtons();
}

function scheduleApply(delay = 0) {
  const token = ++decorationToken;

  window.setTimeout(() => {
    if (token !== decorationToken) return;
    applyStageFilters();
  }, delay);
}

function observeDetailContent() {
  const content = document.querySelector("#requestGroupingContent");
  if (!content || content === observedContent) return;

  if (contentObserver) {
    contentObserver.disconnect();
  }

  observedContent = content;

  contentObserver = new MutationObserver(mutations => {
    const changed = mutations.some(
      mutation =>
        mutation.type === "childList"
        && (
          mutation.addedNodes.length > 0
          || mutation.removedNodes.length > 0
        )
    );

    if (changed) {
      scheduleApply(0);
    }
  });

  // Sólo hijos directos para no reaccionar a botones/badges agregados por
  // este mismo módulo.
  contentObserver.observe(content, {
    childList: true,
    subtree: false,
  });
}

function ensurePriceModal() {
  let modal = document.querySelector(`#${PRICE_MODAL_ID}`);
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = PRICE_MODAL_ID;
  modal.className = "modal fade";
  modal.tabIndex = -1;

  modal.innerHTML = `
    <div class="modal-dialog modal-xl modal-dialog-scrollable">
      <div class="modal-content">
        <div class="modal-header">
          <div>
            <h5 class="modal-title mb-0" id="requestPriceModalTitle">
              Cambiar precio
            </h5>
            <div class="small text-muted" id="requestPriceModalSubtitle"></div>
          </div>
          <button type="button"
                  class="btn-close"
                  data-bs-dismiss="modal"
                  aria-label="Cerrar"></button>
        </div>

        <div class="modal-body" id="requestPriceModalBody"></div>

        <div class="modal-footer">
          <div class="me-auto small text-muted">
            El gasto ya recibido no se modifica; el nuevo precio se aplica como
            referencia vigente y a las piezas pendientes.
          </div>

          <button type="button"
                  class="btn btn-secondary"
                  data-bs-dismiss="modal">
            Cancelar
          </button>

          <button type="button"
                  class="btn btn-dark"
                  id="requestPriceModalSave">
            Guardar precios
          </button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);

  modal.addEventListener("hidden.bs.modal", () => {
    if (!reopenDetailAfterPrice || !reopenDetailRequestId) return;

    const requestId = reopenDetailRequestId;
    reopenDetailAfterPrice = false;
    reopenDetailRequestId = "";

    const viewButton = document.querySelector(
      `.request-history-view[data-request-id="${CSS.escape(requestId)}"]`
    );

    if (viewButton) {
      window.setTimeout(() => viewButton.click(), 100);
    }
  });

  return modal;
}

function priceRowHtml(line, { checked = false, selectable = true } = {}) {
  const currency = String(line.currency || "MXN").toUpperCase();
  const currentPrice = Math.max(num(line.unitPrice), 0);
  const originalPrice =
    Object.prototype.hasOwnProperty.call(line, "originalUnitPrice")
      ? num(line.originalUnitPrice)
      : null;

  const area = [
    `${line.zoneId || ""}${line.zoneName ? ` · ${line.zoneName}` : ""}`,
    `${line.subzoneId || ""}${line.subzoneName ? ` · ${line.subzoneName}` : ""}`,
    `${line.locationCode || line.locationId || ""}${line.locationName ? ` · ${line.locationName}` : ""}`,
  ].filter(Boolean).join(" / ");

  return `
    <tr class="request-price-row"
        data-line-id="${escapeHtml(line.id)}"
        data-current-price="${currentPrice}">
      <td>
        ${
          selectable
            ? `<input class="form-check-input request-price-select"
                      type="checkbox"
                      ${checked ? "checked" : ""}>`
            : `<input class="form-check-input request-price-select"
                      type="checkbox"
                      checked
                      disabled>`
        }
      </td>

      <td>
        <strong>${escapeHtml(line.sku || "")}</strong>
        <div class="small text-muted">
          ${escapeHtml(line.nombre || "")}
        </div>
      </td>

      <td class="request-price-area">
        ${escapeHtml(area)}
      </td>

      <td>
        <div><strong>${escapeHtml(formatCurrencyWithCode(currentPrice, currency))}</strong></div>
        ${
          originalPrice !== null
          && Math.abs(originalPrice - currentPrice) > 0.005
            ? `<div class="small text-muted">
                 Inicial: ${escapeHtml(formatCurrencyWithCode(originalPrice, currency))}
               </div>`
            : ""
        }
      </td>

      <td>
        <input class="form-control form-control-sm request-price-input"
               type="number"
               min="0"
               step="0.01"
               value="${currentPrice}">
        <div class="small text-muted mt-1">${escapeHtml(currency)}</div>
      </td>

      <td>
        ${escapeHtml(stageLabel(line))}
      </td>
    </tr>`;
}

function openPriceModal(lines, title) {
  if (currentRole !== "admin") {
    alert("Sólo el Administrador puede cambiar precios.");
    return;
  }

  const modal = ensurePriceModal();
  const single = lines.length === 1;

  modal.dataset.requestId = activeRequestId;
  modal.querySelector("#requestPriceModalTitle").textContent =
    single ? "Cambiar precio del producto" : "Cambiar precios del producto agrupado";

  modal.querySelector("#requestPriceModalSubtitle").textContent = title || "";

  modal.querySelector("#requestPriceModalBody").innerHTML = `
    ${
      !single
        ? `<div class="d-flex flex-wrap gap-2 mb-3">
             <button type="button"
                     class="btn btn-outline-dark btn-sm"
                     id="requestPriceSelectAll">
               Seleccionar todos
             </button>
             <button type="button"
                     class="btn btn-outline-secondary btn-sm"
                     id="requestPriceClear">
               Limpiar selección
             </button>
           </div>`
        : ""
    }

    <div class="table-responsive">
      <table class="table table-sm request-price-table align-middle">
        <thead>
          <tr>
            <th></th>
            <th>SKU / producto</th>
            <th>Zona / Subzona / Área</th>
            <th>Precio vigente</th>
            <th>Nuevo precio</th>
            <th>Etapa</th>
          </tr>
        </thead>
        <tbody>
          ${lines.map(line =>
            priceRowHtml(line, {
              checked: single,
              selectable: !single,
            })
          ).join("")}
        </tbody>
      </table>
    </div>`;

  const detailModal = document.querySelector("#purchaseRequestDetailModal");

  const showPrice = () => {
    bootstrap.Modal.getOrCreateInstance(modal).show();
  };

  if (detailModal?.classList.contains("show")) {
    reopenDetailAfterPrice = true;
    reopenDetailRequestId = activeRequestId;

    const detailInstance = bootstrap.Modal.getOrCreateInstance(detailModal);
    const onHidden = () => {
      detailModal.removeEventListener("hidden.bs.modal", onHidden);
      showPrice();
    };

    detailModal.addEventListener("hidden.bs.modal", onHidden);
    detailInstance.hide();
  } else {
    reopenDetailAfterPrice = false;
    reopenDetailRequestId = "";
    showPrice();
  }
}

async function recomputeRequestTotals(requestId) {
  const snapshot = await getDocs(
    collection(db, "purchaseRequests", requestId, "items")
  );

  const totals = {};
  let totalQty = 0;

  snapshot.docs.forEach(lineDoc => {
    const line = lineDoc.data();
    const currency = String(line.currency || "MXN").toUpperCase();
    const qty = Math.max(num(line.quantityRequested), 0);
    const price = Math.max(num(line.unitPrice), 0);

    totalQty += qty;
    totals[currency] = num(totals[currency]) + qty * price;
  });

  await updateDoc(doc(db, "purchaseRequests", requestId), {
    totalQty,
    itemCount: snapshot.size,
    totalsByCurrency: totals,
    updatedAt: serverTimestamp(),
  });
}

async function savePriceChanges() {
  const modal = document.querySelector(`#${PRICE_MODAL_ID}`);
  if (!modal) return;

  if (currentRole !== "admin") {
    alert("Sólo el Administrador puede cambiar precios.");
    return;
  }

  const requestId = String(modal.dataset.requestId || "");
  if (!requestId) return;

  const rows = [...modal.querySelectorAll(".request-price-row")];

  const selectedRows = rows.filter(row => {
    const check = row.querySelector(".request-price-select");
    return check?.checked || check?.disabled;
  });

  if (!selectedRows.length) {
    alert("Selecciona al menos un SKU.");
    return;
  }

  const changes = selectedRows.map(row => {
    const lineId = String(row.dataset.lineId || "");
    const newPrice = Number(row.querySelector(".request-price-input")?.value);

    if (!lineId) {
      throw new Error("Hay una línea sin identificador.");
    }

    if (!Number.isFinite(newPrice) || newPrice < 0) {
      throw new Error("Todos los precios deben ser mayores o iguales a cero.");
    }

    return {
      lineId,
      newPrice,
    };
  });

  if (!confirm(`¿Guardar el nuevo precio en ${changes.length} SKU?`)) {
    return;
  }

  const save = modal.querySelector("#requestPriceModalSave");
  save.disabled = true;

  try {
    for (const change of changes) {
      const lineRef = doc(
        db,
        "purchaseRequests",
        requestId,
        "items",
        change.lineId
      );

      const lineSnap = await getDoc(lineRef);
      if (!lineSnap.exists()) {
        throw new Error("Una de las líneas ya no existe.");
      }

      const line = {
        id: lineSnap.id,
        ...lineSnap.data(),
      };

      const oldPrice = Math.max(num(line.unitPrice), 0);

      const update = {
        unitPrice: change.newPrice,
        priceChangedAt: serverTimestamp(),
        priceChangedBy: auth.currentUser?.uid || "",
        priceChangedByName:
          currentProfile?.nombre
          || auth.currentUser?.email
          || "",
        updatedAt: serverTimestamp(),
      };

      if (!Object.prototype.hasOwnProperty.call(line, "originalUnitPrice")) {
        update.originalUnitPrice = oldPrice;
      }

      // Si ya se formalizó la requisición, el precio vigente debe ser también
      // el costo de requisición para que el presupuesto pendiente use el nuevo
      // monto negociado.
      if (line.requisitionStatus === "requisitioned") {
        update.requisitionUnitCost = change.newPrice;
      }

      // actualCostTotal NO se modifica: lo ya recibido conserva su costo real.
      await updateDoc(lineRef, update);
    }

    await recomputeRequestTotals(requestId);

    alert(
      `${changes.length} precio${changes.length === 1 ? "" : "s"} actualizado${changes.length === 1 ? "" : "s"} correctamente.`
    );

    bootstrap.Modal.getOrCreateInstance(modal).hide();
  } catch (error) {
    console.error("No se pudieron cambiar los precios:", error);
    alert(`No se pudieron cambiar los precios: ${error.message}`);
    save.disabled = false;
  }
}

function activeMode() {
  const grouped = document.querySelector(
    '.request-view-mode[data-mode="grouped"].btn-dark'
  );
  return grouped ? "grouped" : "extended";
}

function printStageNames() {
  const checks = [
    ...document.querySelectorAll(
      "#requestStageFilterGroup .request-stage-filter-check"
    ),
  ];

  return checks
    .filter(check => check.checked)
    .map(check => check.nextElementSibling?.textContent?.trim() || check.value)
    .join(", ");
}

function printableLineRows(lines) {
  return lines.map(line => {
    const currency = String(line.currency || "MXN").toUpperCase();
    const area = [
      `${line.zoneId || ""}${line.zoneName ? ` · ${line.zoneName}` : ""}`,
      `${line.subzoneId || ""}${line.subzoneName ? ` · ${line.subzoneName}` : ""}`,
      `${line.locationCode || line.locationId || ""}${line.locationName ? ` · ${line.locationName}` : ""}`,
    ].filter(Boolean).join(" / ");

    return `
      <tr>
        <td><strong>${escapeHtml(line.nombre || "")}</strong></td>
        <td>${escapeHtml(line.sku || "")}</td>
        <td>${escapeHtml(area)}</td>
        <td>${escapeHtml(stageLabel(line))}</td>
        <td class="num">${num(line.quantityRequested)}</td>
        <td class="num">${num(line.quantityReceived)}</td>
        <td class="num">${linePendingQty(line)}</td>
        <td class="money">${escapeHtml(formatCurrencyWithCode(line.unitPrice, currency))}</td>
      </tr>`;
  }).join("");
}

function printableGroupedHtml(lines) {
  const groups = groupLinesByName(lines);

  return [...groups.values()].map(group => {
    const requested = group.lines.reduce(
      (sum, line) => sum + num(line.quantityRequested),
      0
    );
    const received = group.lines.reduce(
      (sum, line) => sum + num(line.quantityReceived),
      0
    );
    const pending = group.lines.reduce(
      (sum, line) => sum + linePendingQty(line),
      0
    );

    return `
      <section class="print-group">
        <div class="print-group-head">
          <div>
            <h2>${escapeHtml(group.name)}</h2>
            <div class="muted">${group.lines.length} SKU / áreas visibles</div>
          </div>
          <div class="group-totals">
            Solicitado: <strong>${requested}</strong> ·
            Recibido: <strong>${received}</strong> ·
            Pendiente: <strong>${pending}</strong>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Zona / Subzona / Área</th>
              <th>Etapa</th>
              <th>Solicitado</th>
              <th>Recibido</th>
              <th>Pendiente</th>
              <th>Precio vigente</th>
            </tr>
          </thead>
          <tbody>
            ${group.lines.map(line => {
              const currency = String(line.currency || "MXN").toUpperCase();
              const area = [
                `${line.zoneId || ""}${line.zoneName ? ` · ${line.zoneName}` : ""}`,
                `${line.subzoneId || ""}${line.subzoneName ? ` · ${line.subzoneName}` : ""}`,
                `${line.locationCode || line.locationId || ""}${line.locationName ? ` · ${line.locationName}` : ""}`,
              ].filter(Boolean).join(" / ");

              return `
                <tr>
                  <td><strong>${escapeHtml(line.sku || "")}</strong></td>
                  <td>${escapeHtml(area)}</td>
                  <td>${escapeHtml(stageLabel(line))}</td>
                  <td class="num">${num(line.quantityRequested)}</td>
                  <td class="num">${num(line.quantityReceived)}</td>
                  <td class="num">${linePendingQty(line)}</td>
                  <td class="money">${escapeHtml(formatCurrencyWithCode(line.unitPrice, currency))}</td>
                </tr>`;
            }).join("")}
          </tbody>
        </table>
      </section>`;
  }).join("");
}

function printFiltered() {
  const popup = window.open("", "_blank");

  if (!popup) {
    alert(
      "El navegador bloqueó la ventana de impresión. Permite ventanas emergentes e inténtalo nuevamente."
    );
    return;
  }

  const lines = filteredLines();
  const folio = activeRequest?.folio || activeRequest?.id || "Solicitud";
  const alias = String(activeRequest?.alias || "").trim();
  const mode = activeMode();
  const search = String(
    document.querySelector("#requestDetailSearch")?.value || ""
  ).trim();

  popup.document.open();
  popup.document.write(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${escapeHtml(folio)} · Listado filtrado</title>
<style>
@page{size:A4 landscape;margin:10mm}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:Arial,sans-serif;color:#181818;margin:0;font-size:10pt}
.toolbar{display:flex;justify-content:flex-end;gap:8px;padding:8px;border-bottom:1px solid #ddd}
header{border-bottom:3px solid #8d1731;padding-bottom:4mm;margin-bottom:5mm}
.kicker{font-size:8pt;letter-spacing:.08em;text-transform:uppercase;color:#8d1731;font-weight:700}
h1{font-size:20pt;margin:1mm 0}
.meta{display:flex;flex-wrap:wrap;gap:3mm 8mm;color:#555;font-size:9pt}
.summary{padding:3mm;border:1px solid #ddd;border-radius:2mm;background:#fafafa;margin-bottom:5mm}
table{width:100%;border-collapse:collapse;font-size:8pt}
th,td{border-bottom:1px solid #ddd;padding:1.6mm;text-align:left;vertical-align:top}
th{background:#f4f4f4}
.num,.money{text-align:right;white-space:nowrap}
.print-group{border:1px solid #ddd;border-radius:2mm;margin-bottom:5mm;break-inside:avoid;overflow:hidden}
.print-group-head{display:flex;justify-content:space-between;gap:5mm;padding:3mm;background:#fafafa;border-bottom:1px solid #ddd}
.print-group h2{font-size:13pt;margin:0}
.muted{color:#666;font-size:8pt}
.group-totals{white-space:nowrap}
.empty{padding:10mm;text-align:center;color:#666}
@media print{.toolbar{display:none}}
</style>
</head>
<body>
<div class="toolbar">
  <button onclick="window.print()">Imprimir / Guardar PDF</button>
  <button onclick="window.close()">Cerrar</button>
</div>

<header>
  <div class="kicker">Universidad Iberoamericana Ciudad de México · FabLab</div>
  <h1>${escapeHtml(folio)} · Listado filtrado</h1>
  <div class="meta">
    ${alias ? `<span><strong>Alias:</strong> ${escapeHtml(alias)}</span>` : ""}
    <span><strong>Etapas:</strong> ${escapeHtml(printStageNames() || "Ninguna")}</span>
    <span><strong>Búsqueda:</strong> ${escapeHtml(search || "Sin búsqueda")}</span>
    <span><strong>Vista:</strong> ${mode === "grouped" ? "Agrupada" : "Extendida"}</span>
  </div>
</header>

<div class="summary">
  <strong>${lines.length}</strong>
  línea${lines.length === 1 ? "" : "s"} coincide${lines.length === 1 ? "" : "n"} con los filtros.
</div>

${
  !lines.length
    ? `<div class="empty">No hay elementos que coincidan con los filtros seleccionados.</div>`
    : mode === "grouped"
      ? printableGroupedHtml(lines)
      : `<table>
           <thead>
             <tr>
               <th>Producto</th>
               <th>SKU</th>
               <th>Zona / Subzona / Área</th>
               <th>Etapa</th>
               <th>Solicitado</th>
               <th>Recibido</th>
               <th>Pendiente</th>
               <th>Precio vigente</th>
             </tr>
           </thead>
           <tbody>
             ${printableLineRows(lines)}
           </tbody>
         </table>`
}

<script>
window.addEventListener("load",()=>setTimeout(()=>window.print(),250));
<\/script>
</body>
</html>`);

  popup.document.close();
}

async function initializeForDetail(requestId) {
  if (!requestId) return;

  try {
    await Promise.all([
      loadRole(),
      loadRequestData(requestId),
    ]);

    ensureStageToolbar();
    observeDetailContent();
    scheduleApply(0);
  } catch (error) {
    console.error("No se pudieron inicializar filtros de la solicitud:", error);
  }
}

function bindEvents() {
  document.addEventListener("purchase-request-detail-rendered", event => {
    const requestId = String(
      event.detail?.requestId || requestIdFromDetail()
    );

    initializeForDetail(requestId);
  });

  document.addEventListener("shown.bs.modal", event => {
    if (event.target?.id !== "purchaseRequestDetailModal") return;
    initializeForDetail(requestIdFromDetail());
  });

  document.addEventListener("input", event => {
    if (event.target.matches("#requestDetailSearch")) {
      scheduleApply(0);
    }
  });

  document.addEventListener("change", event => {
    if (
      event.target.matches(
        "#requestStageFilterGroup .request-stage-filter-check"
      )
    ) {
      applyStageFilters();
      return;
    }
  });

  document.addEventListener("click", async event => {
    const mode = event.target.closest(".request-view-mode");
    if (mode) {
      // El módulo agrupador reconstruye el contenido al cambiar de vista.
      window.setTimeout(() => {
        ensureStageToolbar();
        observeDetailContent();
        applyStageFilters();
      }, 80);
      return;
    }

    if (event.target.closest("#requestStageSelectAll")) {
      document
        .querySelectorAll(
          "#requestStageFilterGroup .request-stage-filter-check"
        )
        .forEach(check => {
          check.checked = true;
        });

      applyStageFilters();
      return;
    }

    if (event.target.closest("#requestPrintFiltered")) {
      printFiltered();
      return;
    }

    const individualPrice =
      event.target.closest(".request-price-action");

    if (individualPrice) {
      const line = activeLines.find(
        item => item.id === individualPrice.dataset.lineId
      );

      if (line) {
        openPriceModal(
          [line],
          `${line.nombre || line.sku || "Producto"} · ${line.sku || ""}`
        );
      }
      return;
    }

    const groupPrice =
      event.target.closest(".request-group-price");

    if (groupPrice) {
      const group = groupLinesByName().get(
        normalizeText(groupPrice.dataset.groupName || "")
      );

      if (group?.lines?.length) {
        openPriceModal(group.lines, group.name);
      }
      return;
    }

    if (event.target.closest("#requestPriceSelectAll")) {
      document
        .querySelectorAll(
          `#${PRICE_MODAL_ID} .request-price-select:not(:disabled)`
        )
        .forEach(check => {
          check.checked = true;
        });
      return;
    }

    if (event.target.closest("#requestPriceClear")) {
      document
        .querySelectorAll(
          `#${PRICE_MODAL_ID} .request-price-select:not(:disabled)`
        )
        .forEach(check => {
          check.checked = false;
        });
      return;
    }

    if (event.target.closest("#requestPriceModalSave")) {
      try {
        await savePriceChanges();
      } catch (error) {
        console.error(error);
        alert(`No se pudieron guardar los precios: ${error.message}`);
      }
    }
  });
}

injectStyles();
ensurePriceModal();
loadRole();
bindEvents();
