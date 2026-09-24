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

const MODAL_ID = "purchaseRequestWideRequisitionModal";
const STYLE_ID = "purchaseRequestWideRequisitionStyles";

let currentRole = "";
let currentProfile = null;
let activeRequestId = "";
let activeRequest = null;
let activeLines = [];
let reopenDetailAfterModal = false;
let reopenRequestId = "";
let saveBusy = false;

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

function canRequisitionLine(line) {
  return (
    linePendingQty(line) > 0
    && line.requisitionStatus !== "requisitioned"
    && num(line.quantityReceived) === 0
    && num(line.quantityCancelled) === 0
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

function areaText(line) {
  return [
    `${line.zoneId || ""}${line.zoneName ? ` · ${line.zoneName}` : ""}`,
    `${line.subzoneId || ""}${line.subzoneName ? ` · ${line.subzoneName}` : ""}`,
    `${line.locationCode || line.locationId || ""}${line.locationName ? ` · ${line.locationName}` : ""}`,
  ].filter(Boolean).join(" / ");
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

function requestIdFromDetail() {
  return String(
    document.querySelector("#purchaseRequestDetailPdf")?.dataset?.requestId || ""
  );
}

async function loadRole() {
  const user = auth.currentUser;
  if (!user) return;

  try {
    currentProfile = await getUserProfile(user.uid);
    currentRole = currentProfile?.appRole || currentProfile?.role || "";
  } catch (error) {
    console.warn("No se pudo resolver el rol para requisición masiva:", error);
  }
}

async function fetchRequestData(requestId) {
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

function groupEligibleLines(lines) {
  const groups = new Map();

  lines
    .filter(canRequisitionLine)
    .forEach(line => {
      const name = String(line.nombre || line.sku || "Item").trim();
      const key = normalizeText(name);

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          name,
          lines: [],
        });
      }

      groups.get(key).lines.push(line);
    });

  return [...groups.values()]
    .sort((a, b) =>
      a.name.localeCompare(b.name, "es", {
        sensitivity: "base",
        numeric: true,
      })
    );
}

function injectStyles() {
  if (document.querySelector(`#${STYLE_ID}`)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .request-wide-requisition-launch {
      display:inline-flex;
      align-items:center;
      gap:.45rem;
      margin-left:.25rem;
    }

    #${MODAL_ID} .modal-dialog {
      max-width:1500px;
    }

    .request-wide-toolbar {
      display:flex;
      flex-wrap:wrap;
      gap:.65rem 1rem;
      align-items:center;
      padding:.75rem .85rem;
      margin-bottom:.85rem;
      border:1px solid #dee2e6;
      border-radius:.7rem;
      background:#f8f9fa;
    }

    .request-wide-toolbar .request-wide-meta {
      margin-right:auto;
      color:#6c757d;
      font-size:.86rem;
    }

    .request-wide-search {
      min-width:280px;
      max-width:440px;
      flex:1 1 340px;
    }

    .request-wide-product {
      border:1px solid #dfe3e8;
      border-radius:.75rem;
      margin-bottom:.75rem;
      overflow:hidden;
      background:#fff;
    }

    .request-wide-product.is-hidden {
      display:none !important;
    }

    .request-wide-product-head {
      display:flex;
      flex-wrap:wrap;
      gap:.7rem 1rem;
      align-items:center;
      padding:.75rem .85rem;
      background:#f8f9fa;
      border-bottom:1px solid #e5e7ea;
    }

    .request-wide-product-title {
      flex:1 1 280px;
      font-weight:700;
    }

    .request-wide-product-meta {
      color:#6c757d;
      font-size:.82rem;
    }

    .request-wide-product-body {
      padding:.35rem .65rem .65rem;
    }

    .request-wide-table {
      margin-bottom:0;
    }

    .request-wide-table th {
      white-space:nowrap;
      vertical-align:middle;
    }

    .request-wide-table td {
      vertical-align:middle;
    }

    .request-wide-area {
      min-width:310px;
      max-width:460px;
      white-space:normal;
      line-height:1.25;
    }

    .request-wide-cost {
      min-width:145px;
    }

    .request-wide-product-check,
    .request-wide-line-check {
      cursor:pointer;
    }

    .request-wide-summary {
      display:flex;
      flex-wrap:wrap;
      gap:.7rem 1.2rem;
      align-items:center;
      padding:.75rem .9rem;
      border:1px solid #b6d4fe;
      border-left:5px solid #0d6efd;
      border-radius:.7rem;
      background:#e7f1ff;
      margin-bottom:.9rem;
    }

    .request-wide-summary strong {
      font-size:1.05rem;
    }

    .request-wide-error-list {
      max-height:180px;
      overflow:auto;
      margin-top:.75rem;
    }

    @media (max-width:767.98px) {
      .request-wide-toolbar .btn,
      .request-wide-search {
        width:100%;
        max-width:none;
      }
    }
  `;

  document.head.appendChild(style);
}

function launcherContainer() {
  const toolbar = document.querySelector("#requestGroupingToolbar");
  if (!toolbar) return null;

  const topRow = toolbar.querySelector(
    ":scope > .d-flex.flex-wrap.justify-content-between"
  );

  return topRow || toolbar;
}

function ensureLauncher() {
  const requestId = requestIdFromDetail();
  if (!requestId) return;

  const container = launcherContainer();
  if (!container) return;

  let button = container.querySelector("#requestWideRequisitionButton");

  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.id = "requestWideRequisitionButton";
    button.className = "btn btn-primary btn-sm request-wide-requisition-launch";
    button.innerHTML = `
      <span>Requisición masiva</span>
      <span class="badge text-bg-light" id="requestWideRequisitionCount">…</span>`;

    container.appendChild(button);
  }

  button.dataset.requestId = requestId;

  updateLauncherCount(requestId).catch(error => {
    console.error("No se pudo calcular requisición masiva:", error);
  });
}

async function updateLauncherCount(requestId) {
  const snapshot = await getDocs(
    collection(db, "purchaseRequests", requestId, "items")
  );

  const eligible = snapshot.docs
    .map(lineDoc => ({
      id: lineDoc.id,
      ...lineDoc.data(),
    }))
    .filter(canRequisitionLine);

  const count = document.querySelector("#requestWideRequisitionCount");
  const button = document.querySelector("#requestWideRequisitionButton");

  if (count) count.textContent = String(eligible.length);

  if (button) {
    button.disabled = eligible.length === 0;
    button.title = eligible.length
      ? `${eligible.length} SKU todavía pueden registrarse en requisición`
      : "No quedan SKU disponibles para requisición";
  }
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
            <h5 class="modal-title mb-0">
              Requisición masiva de la solicitud
            </h5>
            <div class="small text-muted" id="requestWideRequisitionSubtitle"></div>
          </div>

          <button type="button"
                  class="btn-close"
                  data-bs-dismiss="modal"
                  aria-label="Cerrar"></button>
        </div>

        <div class="modal-body">
          <div id="requestWideRequisitionBody"></div>
        </div>

        <div class="modal-footer">
          <div class="me-auto small text-muted" id="requestWideRequisitionFooter"></div>

          <button type="button"
                  class="btn btn-secondary"
                  data-bs-dismiss="modal">
            Cancelar
          </button>

          <button type="button"
                  class="btn btn-primary"
                  id="requestWideRequisitionSave">
            Registrar requisiciones seleccionadas
          </button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);

  modal.addEventListener("hidden.bs.modal", () => {
    if (!reopenDetailAfterModal || !reopenRequestId) return;

    const requestId = reopenRequestId;
    reopenDetailAfterModal = false;
    reopenRequestId = "";

    const viewButton = document.querySelector(
      `.request-history-view[data-request-id="${CSS.escape(requestId)}"]`
    );

    if (viewButton) {
      window.setTimeout(() => viewButton.click(), 120);
    }

    window.setTimeout(() => {
      document.querySelector("#refreshPurchaseRequests")?.click();
    }, 900);
  });

  return modal;
}

function lineRowHtml(line, groupIndex) {
  const pending = linePendingQty(line);
  const currency = String(line.currency || "MXN").toUpperCase();
  const unitCost = Math.max(num(line.unitPrice), 0);

  return `
    <tr class="request-wide-line"
        data-line-id="${escapeHtml(line.id)}"
        data-group-index="${groupIndex}"
        data-pending="${pending}"
        data-currency="${escapeHtml(currency)}"
        data-name="${escapeHtml(normalizeText(`${line.nombre || ""} ${line.sku || ""} ${areaText(line)}`))}">
      <td>
        <input class="form-check-input request-wide-line-check"
               type="checkbox"
               checked
               aria-label="Seleccionar ${escapeHtml(line.sku || line.nombre || line.id)}">
      </td>

      <td>
        <strong>${escapeHtml(line.sku || "")}</strong>
      </td>

      <td class="request-wide-area">
        ${escapeHtml(areaText(line))}
      </td>

      <td class="text-end">
        ${num(line.quantityRequested)}
      </td>

      <td class="text-end">
        <strong>${pending}</strong>
      </td>

      <td class="request-wide-cost">
        <div class="input-group input-group-sm">
          <span class="input-group-text">$</span>
          <input class="form-control request-wide-unit-cost"
                 type="number"
                 min="0"
                 step="0.01"
                 value="${unitCost}"
                 ${currentRole === "admin" ? "" : "disabled"}>
        </div>

        <div class="small text-muted mt-1">
          ${escapeHtml(currency)}
          ${currentRole !== "admin" ? " · sólo Admin ajusta costo" : ""}
        </div>
      </td>
    </tr>`;
}

function productHtml(group, index) {
  const pieces = group.lines.reduce(
    (sum, line) => sum + linePendingQty(line),
    0
  );

  return `
    <section class="request-wide-product"
             data-group-index="${index}"
             data-group-name="${escapeHtml(normalizeText(group.name))}">

      <div class="request-wide-product-head">
        <div>
          <input class="form-check-input request-wide-product-check"
                 type="checkbox"
                 checked
                 data-group-index="${index}"
                 id="requestWideProduct-${index}">
        </div>

        <label class="request-wide-product-title"
               for="requestWideProduct-${index}">
          ${escapeHtml(group.name)}
        </label>

        <div class="request-wide-product-meta">
          ${group.lines.length} SKU / áreas ·
          ${pieces} pieza${pieces === 1 ? "" : "s"} pendientes
        </div>
      </div>

      <div class="request-wide-product-body">
        <div class="table-responsive">
          <table class="table table-sm request-wide-table align-middle">
            <thead>
              <tr>
                <th></th>
                <th>SKU</th>
                <th>Zona / Subzona / Área</th>
                <th class="text-end">Solicitado</th>
                <th class="text-end">A requisición</th>
                <th>Costo unitario oficial</th>
              </tr>
            </thead>

            <tbody>
              ${group.lines
                .map(line => lineRowHtml(line, index))
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    </section>`;
}

function renderModalBody() {
  const groups = groupEligibleLines(activeLines);

  const folio = activeRequest?.folio || activeRequest?.id || "Solicitud";
  const alias = String(activeRequest?.alias || "").trim();

  document.querySelector("#requestWideRequisitionSubtitle").textContent =
    `${folio}${alias ? ` · ${alias}` : ""}`;

  const body = document.querySelector("#requestWideRequisitionBody");

  if (!groups.length) {
    body.innerHTML = `
      <div class="alert alert-success mb-0">
        No quedan SKU elegibles para registrar requisición en esta solicitud.
      </div>`;

    document.querySelector("#requestWideRequisitionSave").disabled = true;
    document.querySelector("#requestWideRequisitionFooter").textContent = "";
    return;
  }

  body.innerHTML = `
    <div class="request-wide-summary" id="requestWideSummary"></div>

    <div class="request-wide-toolbar">
      <input id="requestWideSearch"
             class="form-control form-control-sm request-wide-search"
             type="search"
             placeholder="Buscar producto, SKU, zona o área"
             autocomplete="off">

      <div class="request-wide-meta">
        Todos los SKU elegibles vienen seleccionados por defecto.
      </div>

      <button type="button"
              class="btn btn-outline-dark btn-sm"
              id="requestWideSelectAll">
        Seleccionar todos
      </button>

      <button type="button"
              class="btn btn-outline-secondary btn-sm"
              id="requestWideClearAll">
        Deseleccionar todos
      </button>
    </div>

    <div class="alert alert-light border py-2 small">
      Puedes desmarcar productos completos o sólo determinados SKU.
      La requisición continúa registrándose por SKU/área para no mezclar inventarios.
      ${
        currentRole === "admin"
          ? "Puedes ajustar aquí mismo el costo unitario oficial."
          : "Los costos se mantienen en el valor vigente; sólo el Administrador puede modificarlos."
      }
    </div>

    <div id="requestWideProducts">
      ${groups.map(productHtml).join("")}
    </div>`;

  syncAllProductChecks();
  updateSelectionSummary();
}

function selectedLineRows() {
  return [
    ...document.querySelectorAll(`#${MODAL_ID} .request-wide-line`),
  ].filter(row =>
    row.querySelector(".request-wide-line-check")?.checked
  );
}

function syncProductCheck(groupIndex) {
  const lines = [
    ...document.querySelectorAll(
      `#${MODAL_ID} .request-wide-line[data-group-index="${groupIndex}"]`
    ),
  ];

  const check = document.querySelector(
    `#${MODAL_ID} .request-wide-product-check[data-group-index="${groupIndex}"]`
  );

  if (!check || !lines.length) return;

  const selected = lines.filter(row =>
    row.querySelector(".request-wide-line-check")?.checked
  ).length;

  check.checked = selected === lines.length;
  check.indeterminate = selected > 0 && selected < lines.length;
}

function syncAllProductChecks() {
  const indexes = new Set(
    [
      ...document.querySelectorAll(
        `#${MODAL_ID} .request-wide-line`
      ),
    ].map(row => String(row.dataset.groupIndex))
  );

  indexes.forEach(syncProductCheck);
}

function updateSelectionSummary() {
  const rows = selectedLineRows();
  const productIndexes = new Set(
    rows.map(row => String(row.dataset.groupIndex))
  );

  let pieces = 0;
  const totals = new Map();

  rows.forEach(row => {
    const pending = num(row.dataset.pending);
    const currency = row.dataset.currency || "MXN";
    const unitCost = num(
      row.querySelector(".request-wide-unit-cost")?.value
    );

    pieces += pending;
    totals.set(
      currency,
      num(totals.get(currency)) + pending * unitCost
    );
  });

  const money = [...totals.entries()]
    .map(([currency, amount]) =>
      formatCurrencyWithCode(amount, currency)
    )
    .join(" · ");

  const summary = document.querySelector("#requestWideSummary");
  const footer = document.querySelector("#requestWideRequisitionFooter");
  const save = document.querySelector("#requestWideRequisitionSave");

  const text =
    `${productIndexes.size} producto${productIndexes.size === 1 ? "" : "s"} · `
    + `${rows.length} SKU · `
    + `${pieces} pieza${pieces === 1 ? "" : "s"}`
    + `${money ? ` · ${money}` : ""}`;

  if (summary) {
    summary.innerHTML = `
      <span><strong>${productIndexes.size}</strong> productos</span>
      <span><strong>${rows.length}</strong> SKU / áreas</span>
      <span><strong>${pieces}</strong> piezas</span>
      ${money ? `<span><strong>${escapeHtml(money)}</strong></span>` : ""}
    `;
  }

  if (footer) {
    footer.textContent = rows.length
      ? text
      : "No hay SKU seleccionados.";
  }

  if (save) {
    save.disabled = rows.length === 0 || saveBusy;
  }
}

function applySearchFilter() {
  const query = normalizeText(
    document.querySelector("#requestWideSearch")?.value || ""
  );

  const tokens = query.split(/\s+/).filter(Boolean);

  document
    .querySelectorAll(`#${MODAL_ID} .request-wide-product`)
    .forEach(product => {
      const rows = [
        ...product.querySelectorAll(".request-wide-line"),
      ];

      const productName = normalizeText(
        product.querySelector(".request-wide-product-title")?.textContent || ""
      );

      let visibleRows = 0;

      rows.forEach(row => {
        const haystack = normalizeText(
          `${productName} ${row.dataset.name || ""}`
        );

        const visible =
          !tokens.length
          || tokens.every(token => haystack.includes(token));

        row.classList.toggle("d-none", !visible);

        if (visible) visibleRows += 1;
      });

      product.classList.toggle(
        "is-hidden",
        tokens.length > 0 && visibleRows === 0
      );
    });
}

async function openModal(requestId) {
  await Promise.all([
    loadRole(),
    fetchRequestData(requestId),
  ]);

  const modal = ensureModal();
  modal.dataset.requestId = requestId;

  renderModalBody();

  const detailModal = document.querySelector("#purchaseRequestDetailModal");

  const showModal = () => {
    bootstrap.Modal.getOrCreateInstance(modal).show();
  };

  if (detailModal?.classList.contains("show")) {
    reopenDetailAfterModal = true;
    reopenRequestId = requestId;

    const instance = bootstrap.Modal.getOrCreateInstance(detailModal);

    const onHidden = () => {
      detailModal.removeEventListener("hidden.bs.modal", onHidden);
      showModal();
    };

    detailModal.addEventListener("hidden.bs.modal", onHidden);
    instance.hide();
  } else {
    reopenDetailAfterModal = false;
    reopenRequestId = "";
    showModal();
  }
}

async function applyRequisitionLine(requestId, requestFolio, lineId, unitCost) {
  const lineRef = doc(
    db,
    "purchaseRequests",
    requestId,
    "items",
    lineId
  );

  await runTransaction(db, async transaction => {
    const lineSnap = await transaction.get(lineRef);

    if (!lineSnap.exists()) {
      throw new Error("La línea ya no existe.");
    }

    const line = {
      id: lineSnap.id,
      ...lineSnap.data(),
    };

    if (!canRequisitionLine(line)) {
      throw new Error(
        `${line.sku || line.nombre || line.id}: ya no está disponible para requisición completa.`
      );
    }

    const itemId = String(line.itemId || lineId);
    const itemRef = doc(db, "items", itemId);
    const itemSnap = await transaction.get(itemRef);

    if (!itemSnap.exists()) {
      throw new Error(
        `${line.sku || line.nombre || line.id}: el item asociado ya no existe.`
      );
    }

    const item = {
      id: itemSnap.id,
      ...itemSnap.data(),
    };

    const qty = linePendingQty(line);
    const oldPrice = Math.max(num(line.unitPrice), 0);
    const officialPrice =
      currentRole === "admin"
        ? Math.max(num(unitCost), 0)
        : oldPrice;

    const refs = normalizeRequisitionRefs(
      item.purchaseRequisitionRefs
    ).filter(ref =>
      !(
        ref.requestId === requestId
        && ref.lineId === itemId
      )
    );

    refs.push({
      requestId,
      lineId: itemId,
      folio: String(requestFolio || requestId),
      requisitionQty: qty,
    });

    const totalRequisitionQty = refs.reduce(
      (sum, ref) => sum + num(ref.requisitionQty),
      0
    );

    transaction.update(itemRef, {
      purchaseRequisitionQty: totalRequisitionQty,
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
      requisitionUnitCost: officialPrice,
      updatedAt: serverTimestamp(),
    };

    if (
      currentRole === "admin"
      && Math.abs(officialPrice - oldPrice) > 0.005
    ) {
      lineUpdate.originalUnitPrice =
        Object.prototype.hasOwnProperty.call(line, "originalUnitPrice")
          ? num(line.originalUnitPrice)
          : oldPrice;

      lineUpdate.unitPrice = officialPrice;
    }

    transaction.update(lineRef, lineUpdate);
  });
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from(
    {
      length: Math.min(limit, items.length),
    },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) break;

        try {
          results[index] = {
            ok: true,
            value: await worker(items[index], index),
          };
        } catch (error) {
          results[index] = {
            ok: false,
            error,
          };
        }
      }
    }
  );

  await Promise.all(runners);
  return results;
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
    totals[currency] =
      num(totals[currency]) + qty * price;
  });

  await updateDoc(
    doc(db, "purchaseRequests", requestId),
    {
      itemCount: snapshot.size,
      totalQty,
      totalsByCurrency: totals,
      updatedAt: serverTimestamp(),
    }
  );
}

async function saveMassRequisition() {
  if (saveBusy) return;

  const modal = document.querySelector(`#${MODAL_ID}`);
  if (!modal) return;

  const requestId = String(modal.dataset.requestId || "");
  const rows = selectedLineRows();

  if (!requestId || !rows.length) {
    alert("Selecciona al menos un SKU.");
    return;
  }

  const selections = [];

  try {
    rows.forEach(row => {
      const lineId = String(row.dataset.lineId || "");
      const unitCost = Number(
        row.querySelector(".request-wide-unit-cost")?.value
      );

      if (!lineId) {
        throw new Error("Hay una línea sin identificador.");
      }

      if (!Number.isFinite(unitCost) || unitCost < 0) {
        throw new Error(
          "Todos los costos seleccionados deben ser mayores o iguales a cero."
        );
      }

      selections.push({
        lineId,
        unitCost,
      });
    });
  } catch (error) {
    alert(error.message);
    return;
  }

  const productCount = new Set(
    rows.map(row => String(row.dataset.groupIndex))
  ).size;

  const ok = confirm(
    `¿Registrar requisición para ${selections.length} SKU de ${productCount} producto${productCount === 1 ? "" : "s"}?\n\n`
    + `La operación puede tardar unos segundos si la solicitud contiene muchos SKU.`
  );

  if (!ok) return;

  saveBusy = true;

  const save = document.querySelector("#requestWideRequisitionSave");
  const dismiss = modal.querySelector('[data-bs-dismiss="modal"]');

  if (save) {
    save.disabled = true;
    save.textContent = "Registrando…";
  }

  if (dismiss) dismiss.disabled = true;

  const requestFolio =
    activeRequest?.folio
    || activeRequest?.id
    || requestId;

  try {
    const results = await mapLimit(
      selections,
      5,
      selection =>
        applyRequisitionLine(
          requestId,
          requestFolio,
          selection.lineId,
          selection.unitCost
        )
    );

    const successes = results.filter(result => result?.ok);
    const failures = results.filter(result => result && !result.ok);

    // Recalcular una sola vez al final reduce contención y funciona mucho
    // mejor en solicitudes con cientos de líneas.
    await recomputeRequestTotals(requestId);

    if (failures.length) {
      const messages = failures
        .slice(0, 12)
        .map(result => result.error?.message || "Error desconocido");

      const suffix =
        failures.length > 12
          ? `\n… y ${failures.length - 12} errores adicionales.`
          : "";

      alert(
        `Se registraron ${successes.length} requisiciones.\n`
        + `${failures.length} no pudieron registrarse:\n\n`
        + messages.join("\n")
        + suffix
      );
    } else {
      alert(
        `${successes.length} requisición${successes.length === 1 ? "" : "es"} `
        + `registrada${successes.length === 1 ? "" : "s"} correctamente.`
      );
    }

    // Si hubo fallas dejamos el modal abierto y refrescamos sólo lo pendiente,
    // para que el usuario pueda corregir/reintentar. Si todo salió bien cerramos.
    await fetchRequestData(requestId);

    if (failures.length) {
      renderModalBody();
    } else {
      bootstrap.Modal.getOrCreateInstance(modal).hide();
    }
  } catch (error) {
    console.error("No se pudo completar la requisición masiva:", error);
    alert(`No se pudo completar la requisición masiva: ${error.message}`);
  } finally {
    saveBusy = false;

    if (save) {
      save.disabled = false;
      save.textContent = "Registrar requisiciones seleccionadas";
    }

    if (dismiss) dismiss.disabled = false;

    updateSelectionSummary();
  }
}

function bindEvents() {
  document.addEventListener("purchase-request-detail-rendered", () => {
    window.setTimeout(ensureLauncher, 0);
  });

  document.addEventListener("shown.bs.modal", event => {
    if (event.target?.id === "purchaseRequestDetailModal") {
      window.setTimeout(ensureLauncher, 0);
    }
  });

  document.addEventListener("click", async event => {
    const modeButton = event.target.closest(".request-view-mode");

    if (modeButton) {
      // El agrupador reconstruye el toolbar, así que volvemos a insertar el
      // botón al terminar el cambio de vista.
      window.setTimeout(ensureLauncher, 80);
      return;
    }

    const launch = event.target.closest("#requestWideRequisitionButton");

    if (launch) {
      const requestId =
        String(launch.dataset.requestId || requestIdFromDetail());

      if (requestId) {
        await openModal(requestId);
      }
      return;
    }

    if (event.target.closest("#requestWideSelectAll")) {
      document
        .querySelectorAll(
          `#${MODAL_ID} .request-wide-line-check`
        )
        .forEach(check => {
          check.checked = true;
        });

      syncAllProductChecks();
      updateSelectionSummary();
      return;
    }

    if (event.target.closest("#requestWideClearAll")) {
      document
        .querySelectorAll(
          `#${MODAL_ID} .request-wide-line-check`
        )
        .forEach(check => {
          check.checked = false;
        });

      syncAllProductChecks();
      updateSelectionSummary();
      return;
    }

    if (event.target.closest("#requestWideRequisitionSave")) {
      await saveMassRequisition();
    }
  });

  document.addEventListener("change", event => {
    const productCheck =
      event.target.closest(".request-wide-product-check");

    if (productCheck) {
      const groupIndex = String(productCheck.dataset.groupIndex);

      document
        .querySelectorAll(
          `#${MODAL_ID} .request-wide-line[data-group-index="${CSS.escape(groupIndex)}"] .request-wide-line-check`
        )
        .forEach(check => {
          check.checked = productCheck.checked;
        });

      productCheck.indeterminate = false;
      updateSelectionSummary();
      return;
    }

    const lineCheck =
      event.target.closest(".request-wide-line-check");

    if (lineCheck) {
      const row = lineCheck.closest(".request-wide-line");
      if (row) {
        syncProductCheck(String(row.dataset.groupIndex));
      }

      updateSelectionSummary();
      return;
    }

    if (event.target.closest(".request-wide-unit-cost")) {
      updateSelectionSummary();
    }
  });

  document.addEventListener("input", event => {
    if (event.target.closest("#requestWideSearch")) {
      applySearchFilter();
      return;
    }

    if (event.target.closest(".request-wide-unit-cost")) {
      updateSelectionSummary();
    }
  });
}

injectStyles();
ensureModal();
loadRole();
bindEvents();
