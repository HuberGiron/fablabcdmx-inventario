import { db } from "./firebase-app.js";
import { waitForUser, getUserProfile } from "./common.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const PURCHASE_STATUS_ORDERED = "ordered";
const PURCHASE_STATUS_RECEIVED = "received";
const ALLOWED_ROLES = new Set(["admin", "supervisor"]);

const itemsById = new Map();
let currentAccessRole = "";
let enhancementQueued = false;
let observer = null;

// Evita que una vista no autorizada alcance a mostrar el contenido de Compras
// mientras Firebase resuelve la sesión y el perfil.
document.documentElement.classList.add("purchase-access-pending");

function injectStyles() {
  if (document.querySelector("#purchaseWorkflowStyles")) return;
  const style = document.createElement("style");
  style.id = "purchaseWorkflowStyles";
  style.textContent = `
    html.purchase-access-pending body { visibility: hidden; }

    .purchase-status-controls {
      margin-top: 1rem;
      padding: .9rem 1rem;
      border: 1px solid transparent;
      border-left-width: 6px;
      border-radius: .7rem;
    }
    .purchase-state-missing {
      background: #f8d7da;
      border-color: #dc3545;
    }
    .purchase-state-ordered {
      background: #fff3cd;
      border-color: #f0ad00;
    }
    .purchase-state-complete {
      background: #d1e7dd;
      border-color: #198754;
    }
    .purchase-status-controls .purchase-status-text {
      color: #343a40;
    }

    .purchase-priority-box {
      min-width: 150px;
      padding: .55rem .7rem;
      border: 1px solid #dee2e6;
      border-radius: .65rem;
      background: #fff;
      text-align: right;
    }
    .purchase-priority-box .form-select {
      min-width: 125px;
    }
    .purchase-priority-label {
      display: block;
      margin-bottom: .25rem;
      color: #6c757d;
      font-size: .75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .02em;
    }
    .priority-badge {
      font-size: .78rem;
      padding: .45rem .65rem;
    }

    #purchaseStatusFilterRow .form-select {
      min-height: 42px;
    }
  `;
  document.head.appendChild(style);
}

function revealPage() {
  document.documentElement.classList.remove("purchase-access-pending");
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function currentInventory(item) {
  return num(item.stockAlmacen) + num(item.stockPrestadoTemporal);
}

function quantityToBuy(item) {
  return Math.max(num(item.inventarioDeseado) - currentInventory(item), 0);
}

function itemPriority(item) {
  const value = Number(item?.purchasePriority);
  return [1, 2, 3].includes(value) ? value : 3;
}

function priorityLabel(priority) {
  const p = Number(priority);
  if (p === 1) return "Prioridad 1 · Alta";
  if (p === 2) return "Prioridad 2 · Media";
  return "Prioridad 3 · Normal";
}

function priorityBadgeClass(priority) {
  const p = Number(priority);
  if (p === 1) return "text-bg-danger";
  if (p === 2) return "text-bg-warning";
  return "text-bg-secondary";
}

function purchaseVisualState(item) {
  const missing = quantityToBuy(item);

  if (missing <= 0) {
    return {
      key: "complete",
      cardBorderClass: "border-success",
      bandClass: "purchase-state-complete",
      badgeClass: "text-bg-success",
      label: "Inventario completo",
      missing: 0,
    };
  }

  if (item.purchaseStatus === PURCHASE_STATUS_ORDERED) {
    return {
      key: "ordered",
      cardBorderClass: "border-warning",
      bandClass: "purchase-state-ordered",
      badgeClass: "text-bg-warning",
      label: "En compras",
      missing,
    };
  }

  return {
    key: "missing",
    cardBorderClass: "border-danger",
    bandClass: "purchase-state-missing",
    badgeClass: "text-bg-danger",
    label: "Falta comprar",
    missing,
  };
}

function purchaseStatusLabel(item) {
  return purchaseVisualState(item).label;
}

function pluralPieces(value) {
  return `${value} pieza${Number(value) === 1 ? "" : "s"}`;
}

function statusControlsHtml(item, state) {
  const current = currentInventory(item);
  const desired = num(item.inventarioDeseado);

  if (state.key === "complete") {
    return `
      <div class="d-flex flex-wrap gap-3 align-items-center justify-content-between">
        <div class="d-flex flex-wrap gap-2 align-items-center">
          <span class="badge ${state.badgeClass}">${state.label}</span>
          <span class="purchase-status-text">Inventario actual: <strong>${current}</strong> / deseado: <strong>${desired}</strong></span>
        </div>
      </div>`;
  }

  if (state.key === "ordered") {
    const requested = num(item.purchaseRequestedQty) || state.missing;
    return `
      <div class="d-flex flex-wrap gap-3 align-items-center justify-content-between">
        <div class="d-flex flex-wrap gap-2 align-items-center">
          <span class="badge ${state.badgeClass}">${state.label}</span>
          <span class="purchase-status-text">Faltan ${pluralPieces(state.missing)} · Solicitud enviada: ${pluralPieces(requested)}</span>
        </div>
        <div class="d-flex flex-wrap gap-2 align-items-center">
          <button type="button" class="btn btn-dark purchase-cancel-btn" data-id="${item.id}">Cancelar compra</button>
          <button type="button" class="btn btn-warning purchase-received-btn" data-id="${item.id}">Ya llegó</button>
        </div>
      </div>`;
  }

  return `
    <div class="d-flex flex-wrap gap-3 align-items-center justify-content-between">
      <div class="d-flex flex-wrap gap-2 align-items-center">
        <span class="badge ${state.badgeClass}">${state.label}</span>
        <span class="purchase-status-text">Faltan ${pluralPieces(state.missing)} para completar el inventario deseado</span>
      </div>
      <button type="button" class="btn btn-danger purchase-send-btn" data-id="${item.id}">Mandar a comprar</button>
    </div>`;
}

function priorityControlHtml(item) {
  const priority = itemPriority(item);

  if (currentAccessRole === "admin") {
    return `
      <div class="purchase-priority-box">
        <label class="purchase-priority-label" for="priority-${item.id}">Prioridad de compra</label>
        <select id="priority-${item.id}" class="form-select form-select-sm purchase-priority-select" data-id="${item.id}" aria-label="Prioridad de compra">
          <option value="1" ${priority === 1 ? "selected" : ""}>1 · Alta</option>
          <option value="2" ${priority === 2 ? "selected" : ""}>2 · Media</option>
          <option value="3" ${priority === 3 ? "selected" : ""}>3 · Normal</option>
        </select>
      </div>`;
  }

  return `
    <div class="purchase-priority-box">
      <span class="purchase-priority-label">Prioridad de compra</span>
      <span class="badge priority-badge ${priorityBadgeClass(priority)}">${priorityLabel(priority)}</span>
    </div>`;
}

function decoratePriority(card, item) {
  const body = card.querySelector(".card-body");
  if (!body) return;

  const header = body.querySelector(":scope > .d-flex.justify-content-between");
  if (!header) return;

  let box = header.querySelector(".purchase-priority-wrapper");
  if (!box) {
    box = document.createElement("div");
    box.className = "purchase-priority-wrapper ms-auto";
    header.appendChild(box);
  }

  const signature = `${currentAccessRole}|${itemPriority(item)}`;
  if (box.dataset.signature === signature) return;
  box.dataset.signature = signature;
  box.innerHTML = priorityControlHtml(item);
}

function decorateCard(card) {
  const itemId = card?.dataset?.itemId;
  const item = itemsById.get(itemId);
  if (!item) return;

  if (currentAccessRole === "supervisor") {
    card.querySelector(".admin-card-actions")?.remove();
  }

  decoratePriority(card, item);

  const state = purchaseVisualState(item);
  const signature = [
    state.key,
    state.missing,
    currentInventory(item),
    num(item.inventarioDeseado),
    item.purchaseStatus || "",
    num(item.purchaseRequestedQty),
  ].join("|");

  card.classList.remove("border-success", "border-warning", "border-danger", "border-2");
  card.classList.add("border-2", state.cardBorderClass);

  const body = card.querySelector(".card-body");
  if (!body) return;

  let controls = body.querySelector(".purchase-status-controls");
  if (!controls) {
    controls = document.createElement("div");
    controls.className = "purchase-status-controls";
    const adminActions = body.querySelector(".admin-card-actions");
    if (adminActions) body.insertBefore(controls, adminActions);
    else body.appendChild(controls);
  }

  controls.classList.remove("purchase-state-missing", "purchase-state-ordered", "purchase-state-complete");
  controls.classList.add(state.bandClass);

  if (controls.dataset.signature !== signature) {
    controls.dataset.signature = signature;
    controls.innerHTML = statusControlsHtml(item, state);
  }
}

function addFilters() {
  if (document.querySelector("#filterPurchaseStatus")) return;

  const filterCardBody = document.querySelector(".filter-card .card-body");
  const toolbar = filterCardBody?.querySelector(".filter-toolbar");
  if (!filterCardBody || !toolbar) return;

  const row = document.createElement("div");
  row.id = "purchaseStatusFilterRow";
  row.className = "row g-3 align-items-end mt-1";
  row.innerHTML = `
    <div class="col-lg-4 col-md-6 ms-lg-auto">
      <label class="form-label small mb-1" for="filterPurchaseStatus">Estado de compra</label>
      <select id="filterPurchaseStatus" class="form-select">
        <option value="all" selected>Todos los estados</option>
        <option value="missing">Falta comprar</option>
        <option value="ordered">En compras</option>
        <option value="complete">Inventario completo / ya llegó</option>
      </select>
    </div>
    <div class="col-lg-4 col-md-6">
      <label class="form-label small mb-1" for="filterPurchasePriority">Prioridad</label>
      <select id="filterPurchasePriority" class="form-select">
        <option value="all" selected>Todas las prioridades</option>
        <option value="1">Prioridad 1 · Alta</option>
        <option value="2">Prioridad 2 · Media</option>
        <option value="3">Prioridad 3 · Normal</option>
      </select>
    </div>`;

  toolbar.parentNode.insertBefore(row, toolbar);

  row.querySelectorAll("select").forEach(select => {
    select.addEventListener("input", () => queueEnhancements());
    select.addEventListener("change", () => queueEnhancements());
  });

  document.querySelector("#clearFilters")?.addEventListener("click", () => {
    setTimeout(() => {
      const status = document.querySelector("#filterPurchaseStatus");
      const priority = document.querySelector("#filterPurchasePriority");
      if (status) status.value = "all";
      if (priority) priority.value = "all";
      queueEnhancements();
    }, 0);
  });
}

function addPrioritySortOption() {
  const sort = document.querySelector("#sortMode");
  if (!sort || sort.querySelector('option[value="priority"]')) return;
  const option = document.createElement("option");
  option.value = "priority";
  option.textContent = "Prioridad (1 → 3)";
  sort.appendChild(option);
  sort.addEventListener("input", () => queueMicrotask(() => queueEnhancements()));
  sort.addEventListener("change", () => queueMicrotask(() => queueEnhancements()));
}

function addLegend() {
  if (document.querySelector("#purchaseStatusLegend")) return;
  const itemsList = document.querySelector("#itemsList");
  if (!itemsList?.parentNode) return;

  const legend = document.createElement("div");
  legend.id = "purchaseStatusLegend";
  legend.className = "d-flex flex-wrap gap-2 align-items-center mb-3 small";
  legend.innerHTML = `
    <span class="fw-semibold me-1">Estado de compra:</span>
    <span class="badge text-bg-danger">Falta comprar</span>
    <span class="badge text-bg-warning">En compras</span>
    <span class="badge text-bg-success">Inventario completo / ya llegó</span>
    <span class="text-muted ms-md-2">Prioridad: 1 alta · 2 media · 3 normal</span>`;
  itemsList.parentNode.insertBefore(legend, itemsList);
}


function addPdfReportButton() {
  if (document.querySelector("#exportPurchasePdf")) return;

  const excelButton = document.querySelector("#exportPurchaseReport");
  const container = excelButton?.parentElement;
  if (!excelButton || !container) return;

  const button = document.createElement("button");
  button.type = "button";
  button.id = "exportPurchasePdf";
  button.className = "btn btn-outline-danger";
  button.textContent = "Generar reporte PDF";
  container.insertBefore(button, excelButton);
}

function reportEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function selectedOptionText(selector, fallback = "") {
  const select = document.querySelector(selector);
  if (!select) return fallback;
  return select.selectedOptions?.[0]?.textContent?.trim() || fallback;
}

function selectedTypesText() {
  const checks = [...document.querySelectorAll(".tipo-check")];
  if (!checks.length) return "Todas las categorías";

  const selected = checks.filter(check => check.checked).map(check => String(check.value || "").trim()).filter(Boolean);
  if (selected.length === checks.length) return "Todas las categorías";
  if (!selected.length) return "Ningún tipo seleccionado";
  return selected.join(", ");
}

function appliedFiltersForReport() {
  return [
    ["Zona", selectedOptionText("#filterZone", "Todas las zonas")],
    ["Subzona", selectedOptionText("#filterSubzone", "Todas las subzonas")],
    ["Ubicación", selectedOptionText("#filterLocation", "Todas las ubicaciones")],
    ["Tipo", selectedTypesText()],
    ["FabAcademy", selectedOptionText("#filterWeek", "Todas las semanas FabAcademy")],
    ["Buscar", document.querySelector("#search")?.value?.trim() || "Sin búsqueda"],
    ["Estado de compra", selectedOptionText("#filterPurchaseStatus", "Todos los estados")],
    ["Prioridad", selectedOptionText("#filterPurchasePriority", "Todas las prioridades")],
    ["Orden", selectedOptionText("#sortMode", "Zona / subzona")],
  ];
}

function reportCards() {
  return nativeCards().filter(card => {
    const item = itemsById.get(card.dataset.itemId);
    return Boolean(item) && matchesExtraFilters(item) && !card.classList.contains("d-none");
  });
}

function cloneCardForPdf(card) {
  const clone = card.cloneNode(true);
  const item = itemsById.get(card.dataset.itemId);

  clone.classList.remove("d-none");
  clone.removeAttribute("data-purchase-status-signature");
  clone.querySelector(".admin-card-actions")?.remove();

  // En el PDF no deben aparecer acciones operativas: editar, descargar,
  // mandar a comprar, cancelar o registrar recepción.
  clone.querySelectorAll("button").forEach(button => button.remove());

  // La prioridad se vuelve una etiqueta estática aun cuando el reporte
  // sea generado por un administrador que en pantalla ve un <select>.
  let priorityWrapper = clone.querySelector(".purchase-priority-wrapper");
  if (!priorityWrapper && item) {
    const body = clone.querySelector(".card-body");
    const header = body?.querySelector(":scope > .d-flex.justify-content-between");
    if (header) {
      priorityWrapper = document.createElement("div");
      priorityWrapper.className = "purchase-priority-wrapper ms-auto";
      header.appendChild(priorityWrapper);
    }
  }
  if (priorityWrapper && item) {
    const priority = itemPriority(item);
    priorityWrapper.innerHTML = `
      <div class="purchase-priority-box">
        <span class="purchase-priority-label">Prioridad de compra</span>
        <span class="badge priority-badge ${priorityBadgeClass(priority)}">${reportEscape(priorityLabel(priority))}</span>
      </div>`;
  }

  // Conservamos el estado y su franja de color, pero eliminamos cualquier
  // contenedor que haya quedado vacío al retirar los botones de acción.
  clone.querySelectorAll(".purchase-status-controls .d-flex").forEach(el => {
    if (!el.textContent.trim() && !el.querySelector("*") ) el.remove();
  });

  // Convertimos enlaces e imágenes a URL absoluta para que funcionen en la
  // ventana independiente usada para imprimir/guardar el PDF.
  clone.querySelectorAll("a[href]").forEach(anchor => {
    try {
      anchor.setAttribute("href", new URL(anchor.getAttribute("href"), document.baseURI).href);
    } catch (_) {}
  });
  clone.querySelectorAll("img[src]").forEach(img => {
    try {
      img.setAttribute("src", new URL(img.getAttribute("src"), document.baseURI).href);
    } catch (_) {}
  });

  return clone.outerHTML;
}

function exportPurchaseReportPdf() {
  const cards = reportCards();
  if (!cards.length) {
    alert("No hay elementos dentro del filtro actual para generar el PDF.");
    return;
  }

  const reportWindow = window.open("", "_blank");
  if (!reportWindow) {
    alert("El navegador bloqueó la ventana del reporte. Permite ventanas emergentes para este sitio e inténtalo nuevamente.");
    return;
  }

  const now = new Date();
  const dateIso = now.toISOString().slice(0, 10);
  const generatedAt = now.toLocaleString("es-MX", { dateStyle: "long", timeStyle: "short" });
  const filterRows = appliedFiltersForReport();
  const filterHtml = filterRows.map(([label, value]) => `
    <div class="report-filter">
      <span class="report-filter-label">${reportEscape(label)}</span>
      <span class="report-filter-value">${reportEscape(value)}</span>
    </div>`).join("");

  const totalText = document.querySelector("#purchaseSummaryTotals")?.textContent?.trim() || "";
  const metaText = document.querySelector("#purchaseSummaryMeta")?.textContent?.trim() || `${cards.length} elementos`;
  const statusText = selectedOptionText("#filterPurchaseStatus", "Todos los estados")
    .replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const documentTitle = `Reporte_Compras_FabLab_${dateIso}${statusText ? `_${statusText}` : ""}`;
  const cardsHtml = cards.map(cloneCardForPdf).join("\n");
  const stylesHref = new URL("css/styles.css", window.location.href).href;

  reportWindow.document.open();
  reportWindow.document.write(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <base href="${reportEscape(document.baseURI)}">
  <title>${reportEscape(documentTitle)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
  <link rel="stylesheet" href="https://use.typekit.net/jov3nat.css">
  <link rel="stylesheet" href="${reportEscape(stylesHref)}">
  <style>
    @page { size: A4 landscape; margin: 9mm; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    html, body { background: #fff !important; }
    body { margin: 0; color: #171717; }
    .report-page { width: 100%; }
    .report-header {
      border-bottom: 3px solid #c8102e;
      margin-bottom: 6mm;
      padding-bottom: 4mm;
    }
    .report-kicker {
      color: #c8102e;
      font-size: 10pt;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    .report-title {
      margin: 1mm 0 2mm;
      font-size: 24pt;
      line-height: 1.08;
    }
    .report-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 3mm 8mm;
      color: #555;
      font-size: 9.5pt;
    }
    .report-summary {
      display: grid;
      grid-template-columns: 1fr 2fr;
      gap: 5mm;
      margin: 5mm 0;
      padding: 4mm;
      border: 1px solid #ddd;
      border-radius: 3mm;
      background: #fafafa;
    }
    .report-summary-total { font-size: 18pt; font-weight: 700; }
    .report-summary-meta { color: #555; font-size: 10pt; }
    .report-filters-title {
      margin: 0 0 2mm;
      font-size: 11pt;
      font-weight: 700;
    }
    .report-filter-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 2mm;
      margin-bottom: 6mm;
    }
    .report-filter {
      min-width: 0;
      padding: 2.2mm 2.8mm;
      border: 1px solid #ddd;
      border-radius: 2mm;
      background: #fff;
    }
    .report-filter-label {
      display: block;
      color: #666;
      font-size: 7.5pt;
      font-weight: 700;
      text-transform: uppercase;
    }
    .report-filter-value {
      display: block;
      margin-top: .5mm;
      font-size: 9pt;
      overflow-wrap: anywhere;
    }
    .report-items-title {
      margin: 0 0 3mm;
      font-size: 13pt;
      font-weight: 700;
    }
    .items-list { display: block !important; }
    .item-card {
      break-inside: avoid;
      page-break-inside: avoid;
      margin-bottom: 6mm !important;
      box-shadow: none !important;
    }
    .item-card .card-body { padding: 4mm !important; }
    .item-card .image-wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 3mm;
      background: #fff;
    }
    .item-card .item-image {
      width: 100%;
      max-height: 54mm;
      object-fit: contain;
    }
    .item-card h2, .item-card h3, .item-card .card-title { break-after: avoid; }
    .purchase-status-controls {
      margin-top: 3mm;
      padding: 3mm 4mm;
      border: 1px solid transparent;
      border-left-width: 2mm;
      border-radius: 2.5mm;
    }
    .purchase-state-missing { background: #f8d7da !important; border-color: #dc3545 !important; }
    .purchase-state-ordered { background: #fff3cd !important; border-color: #f0ad00 !important; }
    .purchase-state-complete { background: #d1e7dd !important; border-color: #198754 !important; }
    .purchase-priority-box {
      min-width: 36mm;
      padding: 2.5mm 3mm;
      border: 1px solid #dee2e6;
      border-radius: 2.5mm;
      background: #fff !important;
      text-align: right;
    }
    .purchase-priority-label {
      display: block;
      margin-bottom: 1mm;
      color: #6c757d;
      font-size: 7pt;
      font-weight: 700;
      text-transform: uppercase;
    }
    .priority-badge { font-size: 8pt; padding: 1.6mm 2.2mm; }
    .admin-card-actions,
    .purchase-send-btn,
    .purchase-cancel-btn,
    .purchase-received-btn,
    .file-download,
    .item-card button { display: none !important; }
    a.btn {
      text-decoration: none !important;
      white-space: nowrap;
    }
    .report-footer-note {
      margin-top: 4mm;
      color: #666;
      font-size: 8pt;
    }
    .report-print-toolbar {
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      padding: 10px;
      background: rgba(255,255,255,.96);
      border-bottom: 1px solid #ddd;
    }
    @media print {
      .no-print { display: none !important; }
      body { font-size: 9.5pt; }
      a[href] { text-decoration: none !important; }
    }
  </style>
</head>
<body>
  <div class="report-print-toolbar no-print">
    <button type="button" class="btn btn-dark" onclick="window.print()">Imprimir / Guardar como PDF</button>
    <button type="button" class="btn btn-outline-secondary" onclick="window.close()">Cerrar</button>
  </div>
  <main class="report-page">
    <header class="report-header">
      <div class="report-kicker">Universidad Iberoamericana Ciudad de México · FabLab</div>
      <h1 class="report-title">Reporte visual de compras</h1>
      <div class="report-meta">
        <span><strong>Generado:</strong> ${reportEscape(generatedAt)}</span>
        <span><strong>Elementos:</strong> ${cards.length}</span>
      </div>
    </header>

    <section class="report-summary">
      <div>
        <div class="report-filter-label">Presupuesto estimado</div>
        <div class="report-summary-total">${reportEscape(totalText)}</div>
      </div>
      <div>
        <div class="report-filter-label">Resumen del filtro</div>
        <div class="report-summary-meta">${reportEscape(metaText)}</div>
      </div>
    </section>

    <section>
      <h2 class="report-filters-title">Filtros aplicados en el inventario</h2>
      <div class="report-filter-grid">${filterHtml}</div>
    </section>

    <section>
      <h2 class="report-items-title">Elementos del reporte</h2>
      <div class="items-list">${cardsHtml}</div>
    </section>

    <div class="report-footer-note">
      Los botones “Más info” e “Info Compra” conservan sus hipervínculos en el PDF generado por el navegador.
    </div>
  </main>
  <script>
    window.addEventListener("load", async () => {
      const waits = Array.from(document.images).map(img => img.complete
        ? Promise.resolve()
        : new Promise(resolve => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          })
      );
      await Promise.all(waits);
      setTimeout(() => window.print(), 350);
    });
  <\/script>
</body>
</html>`);
  reportWindow.document.close();
}

function currentStatusFilter() {
  return document.querySelector("#filterPurchaseStatus")?.value || "all";
}

function currentPriorityFilter() {
  return document.querySelector("#filterPurchasePriority")?.value || "all";
}

function matchesExtraFilters(item) {
  const statusFilter = currentStatusFilter();
  const priorityFilter = currentPriorityFilter();

  if (statusFilter !== "all" && purchaseVisualState(item).key !== statusFilter) return false;
  if (priorityFilter !== "all" && String(itemPriority(item)) !== String(priorityFilter)) return false;
  return true;
}

function nativeCards() {
  return [...document.querySelectorAll("#itemsList .item-card[data-item-id]")];
}

function effectiveRows() {
  return nativeCards()
    .map(card => itemsById.get(card.dataset.itemId))
    .filter(Boolean)
    .filter(matchesExtraFilters);
}

function applyCardFiltersAndOrdering() {
  const cards = nativeCards();
  let visible = 0;

  cards.forEach(card => {
    const item = itemsById.get(card.dataset.itemId);
    const show = Boolean(item) && matchesExtraFilters(item);
    card.classList.toggle("d-none", !show);
    if (show) visible += 1;
  });

  const sort = document.querySelector("#sortMode")?.value || "zone";
  if (sort === "priority") {
    const container = document.querySelector("#itemsList");
    const sorted = [...cards].sort((a, b) => {
      const ia = itemsById.get(a.dataset.itemId);
      const ib = itemsById.get(b.dataset.itemId);
      return itemPriority(ia) - itemPriority(ib);
    });

    const currentIds = cards.map(c => c.dataset.itemId).join("|");
    const sortedIds = sorted.map(c => c.dataset.itemId).join("|");
    if (container && currentIds !== sortedIds) {
      sorted.forEach(card => container.appendChild(card));
    }
  }

  const resultCount = document.querySelector("#resultCount");
  if (resultCount) {
    resultCount.textContent = `${visible} resultado${visible === 1 ? "" : "s"}`;
  }
}

function formatCurrency(value, currency = "MXN") {
  const n = num(value);
  const code = String(currency || "MXN").toUpperCase();
  try {
    return new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${code} ${n.toFixed(2)}`;
  }
}

function formatCurrencyWithCode(value, currency = "MXN") {
  const code = String(currency || "MXN").toUpperCase();
  return `${formatCurrency(value, code)} ${code}`;
}

function purchaseCategory(tipo) {
  const raw = String(tipo || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (raw === "mobiliario") return "Mobiliario";
  if (raw === "computo") return "Cómputo";
  if (raw === "maquina" || raw === "herramienta") return "Máquinas";
  return "Consumibles, accesorios, equipo auxiliar, otros";
}

const PURCHASE_CATEGORIES = [
  "Mobiliario",
  "Cómputo",
  "Máquinas",
  "Consumibles, accesorios, equipo auxiliar, otros",
];

function addMoneyTotal(totals, currency, amount) {
  const code = currency || "MXN";
  totals[code] = num(totals[code]) + num(amount);
}

function formatMoneyTotals(totals) {
  const entries = Object.entries(totals || {}).sort(([a], [b]) => String(a).localeCompare(String(b), "es"));
  return entries.length
    ? entries.map(([currency, total]) => formatCurrencyWithCode(total, currency)).join(" · ")
    : formatCurrencyWithCode(0, "MXN");
}

function buildCategorySummary(rows) {
  const groups = new Map();
  PURCHASE_CATEGORIES.forEach((category, index) => groups.set(category, {
    category,
    sort: index,
    totals: {},
    qty: 0,
    items: 0,
  }));

  rows.forEach(item => {
    const category = purchaseCategory(item.tipo);
    const group = groups.get(category);
    const qty = quantityToBuy(item);
    const currency = item.moneda || "MXN";
    const subtotal = qty * num(item.precioUnitario);
    group.items += 1;
    group.qty += qty;
    addMoneyTotal(group.totals, currency, subtotal);
  });

  return [...groups.values()].sort((a, b) => a.sort - b.sort);
}

function buildBreakdown(rows) {
  const zoneMap = new Map();

  rows.forEach(item => {
    const zoneId = String(item.zoneId || "s/z");
    const subzoneId = String(item.subzoneId || "s/s");
    const category = purchaseCategory(item.tipo);
    const qty = quantityToBuy(item);
    const currency = item.moneda || "MXN";
    const subtotal = qty * num(item.precioUnitario);

    if (!zoneMap.has(zoneId)) {
      zoneMap.set(zoneId, {
        zoneId,
        zoneName: item.zoneName || "Sin zona",
        totals: {},
        qty: 0,
        items: 0,
        subzones: new Map(),
      });
    }
    const zone = zoneMap.get(zoneId);

    if (!zone.subzones.has(subzoneId)) {
      zone.subzones.set(subzoneId, {
        subzoneId,
        subzoneName: item.subzoneName || "Sin subzona",
        totals: {},
        qty: 0,
        items: 0,
        categories: new Map(),
      });
    }
    const subzone = zone.subzones.get(subzoneId);

    if (!subzone.categories.has(category)) {
      subzone.categories.set(category, {
        category,
        totals: {},
        qty: 0,
        items: 0,
      });
    }
    const cat = subzone.categories.get(category);

    [zone, subzone, cat].forEach(group => {
      group.items += 1;
      group.qty += qty;
      addMoneyTotal(group.totals, currency, subtotal);
    });
  });

  return [...zoneMap.values()]
    .sort((a, b) => String(a.zoneId).localeCompare(String(b.zoneId), "es", { numeric: true }))
    .map(zone => ({
      ...zone,
      subzones: [...zone.subzones.values()]
        .sort((a, b) => String(a.subzoneId).localeCompare(String(b.subzoneId), "es", { numeric: true }))
        .map(subzone => ({
          ...subzone,
          categories: [...subzone.categories.values()].sort((a, b) =>
            PURCHASE_CATEGORIES.indexOf(a.category) - PURCHASE_CATEGORIES.indexOf(b.category)
          ),
        })),
    }));
}

function recalculateSummaryAndReport() {
  const rows = effectiveRows();
  const totalsEl = document.querySelector("#purchaseSummaryTotals");
  const metaEl = document.querySelector("#purchaseSummaryMeta");

  const totals = {};
  let totalQty = 0;
  rows.forEach(item => {
    const qty = quantityToBuy(item);
    totalQty += qty;
    addMoneyTotal(totals, item.moneda || "MXN", qty * num(item.precioUnitario));
  });

  if (totalsEl) totalsEl.textContent = formatMoneyTotals(totals);
  if (metaEl) {
    metaEl.textContent = `${rows.length} elemento${rows.length === 1 ? "" : "s"} en el filtro · ${totalQty} pieza${totalQty === 1 ? "" : "s"} sugerida${totalQty === 1 ? "" : "s"} a comprar`;
  }

  const report = document.querySelector("#purchaseBreakdownReport");
  if (!report) return;

  if (!rows.length) {
    report.innerHTML = '<p class="purchase-report-empty">No hay elementos dentro del filtro actual.</p>';
    return;
  }

  const categories = buildCategorySummary(rows);
  const breakdown = buildBreakdown(rows);

  report.innerHTML = `
    <div class="purchase-category-summary" aria-label="Totales por categoría">
      ${categories.map(cat => `
        <div class="purchase-category-summary-card">
          <div class="purchase-category-summary-label">${cat.category}</div>
          <div class="purchase-category-summary-total">${formatMoneyTotals(cat.totals)}</div>
          <div class="purchase-category-summary-meta">${cat.items} item${cat.items === 1 ? "" : "s"} · ${cat.qty} pieza${cat.qty === 1 ? "" : "s"} sugerida${cat.qty === 1 ? "" : "s"}</div>
        </div>`).join("")}
    </div>
    <div class="purchase-report-grid">
      ${breakdown.map(zone => `
        <section class="purchase-zone-report">
          <div class="purchase-zone-header">
            <h3 class="purchase-zone-title">Zona ${zone.zoneId} · ${zone.zoneName}</h3>
            <div class="purchase-zone-total">${formatMoneyTotals(zone.totals)}</div>
          </div>
          <div class="purchase-subzone-list">
            ${zone.subzones.map(subzone => `
              <div class="purchase-subzone-report">
                <div class="purchase-subzone-header">
                  <div class="purchase-subzone-title">Subzona ${subzone.subzoneId} · ${subzone.subzoneName}</div>
                  <div class="purchase-subzone-total">${formatMoneyTotals(subzone.totals)}</div>
                </div>
                <div class="purchase-category-table">
                  ${subzone.categories.map(cat => `
                    <div class="purchase-category-row">
                      <div>
                        <div class="purchase-category-name">${cat.category}</div>
                        <div class="purchase-category-meta">${cat.items} item${cat.items === 1 ? "" : "s"} · ${cat.qty} pieza${cat.qty === 1 ? "" : "s"} sugerida${cat.qty === 1 ? "" : "s"}</div>
                      </div>
                      <div class="purchase-category-total">${formatMoneyTotals(cat.totals)}</div>
                    </div>`).join("")}
                </div>
              </div>`).join("")}
          </div>
        </section>`).join("")}
    </div>`;
}

function queueEnhancements() {
  if (enhancementQueued) return;
  enhancementQueued = true;
  queueMicrotask(() => {
    enhancementQueued = false;
    nativeCards().forEach(decorateCard);
    applyCardFiltersAndOrdering();
    recalculateSummaryAndReport();
  });
}

async function fetchLiveItem(itemId) {
  const snapshot = await getDoc(doc(db, "items", itemId));
  if (!snapshot.exists()) throw new Error("El item ya no existe en Firestore.");
  return { id: snapshot.id, ...snapshot.data() };
}

function setButtonBusy(button, busy, busyLabel) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText || button.textContent;
  }
}

async function sendToPurchases(itemId, button) {
  setButtonBusy(button, true, "Guardando...");

  try {
    const item = await fetchLiveItem(itemId);
    const missing = quantityToBuy(item);

    if (missing <= 0) {
      itemsById.set(itemId, item);
      queueEnhancements();
      alert("Este item ya tiene completo su inventario deseado.");
      return;
    }

    const ok = confirm(
      `¿Marcar como enviado a Compras?\n\n${item.nombre || item.sku || "Item"}\nCantidad faltante: ${pluralPieces(missing)}`
    );
    if (!ok) return;

    await updateDoc(doc(db, "items", itemId), {
      purchaseStatus: PURCHASE_STATUS_ORDERED,
      purchaseRequestedQty: missing,
      purchaseRequestedAt: serverTimestamp(),
      purchaseReceivedAt: null,
      purchaseReceivedQty: null,
      updatedAt: serverTimestamp(),
    });

    itemsById.set(itemId, {
      ...item,
      purchaseStatus: PURCHASE_STATUS_ORDERED,
      purchaseRequestedQty: missing,
    });
    queueEnhancements();
  } catch (error) {
    console.error(error);
    alert(`No se pudo mandar el item a Compras: ${error.message}`);
  } finally {
    setButtonBusy(button, false);
  }
}

async function cancelPurchase(itemId, button) {
  setButtonBusy(button, true, "Cancelando...");

  try {
    const item = await fetchLiveItem(itemId);

    if (item.purchaseStatus !== PURCHASE_STATUS_ORDERED) {
      itemsById.set(itemId, item);
      queueEnhancements();
      alert("Este item ya no está marcado como 'En compras'. Se actualizó la tarjeta con el estado actual.");
      return;
    }

    const ok = confirm(
      `¿Cancelar esta solicitud de compra?\n\n${item.nombre || item.sku || "Item"}\n\nEl artículo volverá al estado "Falta comprar" y podrá solicitarse nuevamente.`
    );
    if (!ok) return;

    await updateDoc(doc(db, "items", itemId), {
      purchaseStatus: "cancelled",
      purchaseRequestedQty: 0,
      purchaseRequestedAt: null,
      purchaseReceivedQty: null,
      purchaseReceivedAt: null,
      updatedAt: serverTimestamp(),
    });

    itemsById.set(itemId, {
      ...item,
      purchaseStatus: "cancelled",
      purchaseRequestedQty: 0,
      purchaseRequestedAt: null,
      purchaseReceivedQty: null,
      purchaseReceivedAt: null,
    });

    // No se modifica stock ni prioridad. Al dejar de estar "ordered",
    // purchaseVisualState() lo devuelve automáticamente a "Falta comprar".
    queueEnhancements();
  } catch (error) {
    console.error(error);
    alert(`No se pudo cancelar la compra: ${error.message}`);
  } finally {
    setButtonBusy(button, false);
  }
}

async function markAsReceived(itemId, button) {
  setButtonBusy(button, true, "Actualizando...");

  try {
    const item = await fetchLiveItem(itemId);

    if (item.purchaseStatus !== PURCHASE_STATUS_ORDERED) {
      itemsById.set(itemId, item);
      queueEnhancements();
      alert("Este item ya no está marcado como 'En compras'. Se actualizó la tarjeta con el estado actual.");
      return;
    }

    const missing = quantityToBuy(item);
    if (missing <= 0) {
      await updateDoc(doc(db, "items", itemId), {
        purchaseStatus: PURCHASE_STATUS_RECEIVED,
        purchaseReceivedQty: 0,
        purchaseReceivedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      window.location.reload();
      return;
    }

    const ok = confirm(
      `¿Confirmar que ya llegó la compra?\n\n${item.nombre || item.sku || "Item"}\nSe agregarán ${pluralPieces(missing)} al stock de almacén para completar el inventario deseado.`
    );
    if (!ok) return;

    const newWarehouseStock = num(item.stockAlmacen) + missing;

    await updateDoc(doc(db, "items", itemId), {
      stockAlmacen: newWarehouseStock,
      purchaseStatus: PURCHASE_STATUS_RECEIVED,
      purchaseReceivedQty: missing,
      purchaseReceivedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    window.location.reload();
  } catch (error) {
    console.error(error);
    alert(`No se pudo registrar la recepción de la compra: ${error.message}`);
  } finally {
    setButtonBusy(button, false);
  }
}

async function updatePriority(itemId, select) {
  if (currentAccessRole !== "admin") return;

  const priority = Number(select.value);
  if (![1, 2, 3].includes(priority)) return;

  select.disabled = true;
  try {
    await updateDoc(doc(db, "items", itemId), {
      purchasePriority: priority,
      updatedAt: serverTimestamp(),
    });

    const current = itemsById.get(itemId) || await fetchLiveItem(itemId);
    itemsById.set(itemId, { ...current, purchasePriority: priority });
    queueEnhancements();
  } catch (error) {
    console.error(error);
    alert(`No se pudo cambiar la prioridad: ${error.message}`);
    const item = itemsById.get(itemId);
    if (item) select.value = String(itemPriority(item));
  } finally {
    select.disabled = false;
  }
}

function bindPurchaseActions() {
  const itemsList = document.querySelector("#itemsList");
  if (!itemsList) return;

  itemsList.addEventListener("click", event => {
    const sendButton = event.target.closest(".purchase-send-btn");
    if (sendButton) {
      sendToPurchases(sendButton.dataset.id, sendButton);
      return;
    }

    const cancelButton = event.target.closest(".purchase-cancel-btn");
    if (cancelButton) {
      cancelPurchase(cancelButton.dataset.id, cancelButton);
      return;
    }

    const receivedButton = event.target.closest(".purchase-received-btn");
    if (receivedButton) {
      markAsReceived(receivedButton.dataset.id, receivedButton);
    }
  });

  itemsList.addEventListener("change", event => {
    const select = event.target.closest(".purchase-priority-select");
    if (select) updatePriority(select.dataset.id, select);
  });
}

function cleanXlsxText(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[\uD800-\uDFFF]/g, "")
    .trim();
}

function cleanXlsxNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function xlsxMoneyFormat(currency = "MXN") {
  const code = String(currency || "MXN").trim().toUpperCase();
  if (code === "USD") return '"US$"#,##0.00';
  if (code === "EUR") return '"€"#,##0.00';
  if (code === "MXN") return '"$"#,##0.00';
  return '#,##0.00';
}

function setXlsxNumericCell(ws, cellRef, numberFormat = "") {
  const cell = ws?.[cellRef];
  if (!cell) return;
  cell.t = "n";
  if (numberFormat) cell.z = numberFormat;
}

function applyXlsxMoneyFormat(ws, rowCount, moneyColumns, currencyColumn, startRow = 2) {
  for (let r = startRow; r < startRow + rowCount; r++) {
    const currency = ws?.[`${currencyColumn}${r}`]?.v || "MXN";
    const format = xlsxMoneyFormat(currency);
    for (const col of moneyColumns) setXlsxNumericCell(ws, `${col}${r}`, format);
  }
}

function itemAreaCode(item) {
  return item.locationCode || item.areaCode || item.subzoneId || "";
}

function inventoryReportRows(rows) {
  return rows.map(item => ({
    zona: item.zoneName || "",
    subzona: item.subzoneName || "",
    area_codigo: itemAreaCode(item),
    area: item.locationName || "",
    sku: item.sku || "",
    tipo: item.tipo || "",
    nombre: item.nombre || "",
    descripcion: item.descripcion || "",
    estado_compra: purchaseStatusLabel(item),
    prioridad: itemPriority(item),
    inventario_actual: currentInventory(item),
    inventario_deseado: num(item.inventarioDeseado),
    cantidad_a_comprar: quantityToBuy(item),
    precio_unitario: num(item.precioUnitario),
    moneda: item.moneda || "MXN",
    subtotal: quantityToBuy(item) * num(item.precioUnitario),
    liga_compra: item.purchaseUrl || "",
  }));
}

function exportVisibleXlsx(rows) {
  if (!window.XLSX) {
    alert("No se pudo cargar la librería XLSX. Revisa tu conexión a internet o la consola del navegador.");
    return;
  }
  if (!rows.length) {
    alert("No hay elementos para exportar con el filtro seleccionado.");
    return;
  }

  const data = inventoryReportRows(rows);
  const headers = [
    "Zona", "Subzona", "Código de área", "Área", "SKU", "Tipo", "Nombre", "Descripción",
    "Estado de compra", "Prioridad", "Inventario actual", "Inventario deseado", "Cantidad a comprar",
    "Precio unitario", "Moneda", "Subtotal", "Liga de compra",
  ];
  const aoa = [headers, ...data.map(row => [
    cleanXlsxText(row.zona), cleanXlsxText(row.subzona), cleanXlsxText(row.area_codigo), cleanXlsxText(row.area),
    cleanXlsxText(row.sku), cleanXlsxText(row.tipo), cleanXlsxText(row.nombre), cleanXlsxText(row.descripcion),
    cleanXlsxText(row.estado_compra), cleanXlsxNumber(row.prioridad), cleanXlsxNumber(row.inventario_actual),
    cleanXlsxNumber(row.inventario_deseado), cleanXlsxNumber(row.cantidad_a_comprar), cleanXlsxNumber(row.precio_unitario),
    cleanXlsxText(row.moneda), cleanXlsxNumber(row.subtotal), cleanXlsxText(row.liga_compra),
  ])];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 18 }, { wch: 24 }, { wch: 16 }, { wch: 28 }, { wch: 12 }, { wch: 16 }, { wch: 36 }, { wch: 36 },
    { wch: 24 }, { wch: 10 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 16 }, { wch: 40 },
  ];
  for (let r = 2; r <= data.length + 1; r++) {
    ["J", "K", "L", "M"].forEach(col => setXlsxNumericCell(ws, `${col}${r}`));
  }
  applyXlsxMoneyFormat(ws, data.length, ["N", "P"], "O");
  ws["!autofilter"] = { ref: `A1:Q${data.length + 1}` };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Inventario filtrado");
  const date = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `inventario_compras_filtrado_${date}.xlsx`, { bookType: "xlsx", compression: true });
}

function flattenMoneyTotals(totals) {
  const entries = Object.entries(totals || {}).sort(([a], [b]) => String(a).localeCompare(String(b), "es"));
  return entries.length ? entries : [["MXN", 0]];
}

function exportPurchaseReportXlsx(rows) {
  if (!window.XLSX) {
    alert("No se pudo cargar la librería XLSX. Revisa tu conexión a internet o la consola del navegador.");
    return;
  }
  if (!rows.length) {
    alert("No hay elementos dentro del filtro actual.");
    return;
  }

  const categorySummary = buildCategorySummary(rows);
  const categoryAoa = [
    ["Categoría", "Items", "Piezas sugeridas", "Moneda", "Total"],
    ...categorySummary.flatMap(cat => flattenMoneyTotals(cat.totals).map(([currency, total]) => [
      cleanXlsxText(cat.category), cleanXlsxNumber(cat.items), cleanXlsxNumber(cat.qty), cleanXlsxText(currency), cleanXlsxNumber(total),
    ])),
  ];

  const breakdown = buildBreakdown(rows);
  const breakdownAoa = [
    ["Zona", "Nombre zona", "Subzona", "Nombre subzona", "Categoría", "Items", "Piezas sugeridas", "Moneda", "Total"],
    ...breakdown.flatMap(zone => zone.subzones.flatMap(subzone => subzone.categories.flatMap(cat =>
      flattenMoneyTotals(cat.totals).map(([currency, total]) => [
        cleanXlsxText(zone.zoneId), cleanXlsxText(zone.zoneName), cleanXlsxText(subzone.subzoneId), cleanXlsxText(subzone.subzoneName),
        cleanXlsxText(cat.category), cleanXlsxNumber(cat.items), cleanXlsxNumber(cat.qty), cleanXlsxText(currency), cleanXlsxNumber(total),
      ])
    ))),
  ];

  const detail = inventoryReportRows(rows);
  const detailAoa = [
    ["Zona", "Subzona", "Código de área", "Área", "SKU", "Tipo", "Nombre", "Estado de compra", "Prioridad", "Inventario actual", "Inventario deseado", "Cantidad a comprar", "Precio unitario", "Moneda", "Subtotal", "Liga de compra"],
    ...detail.map(row => [
      cleanXlsxText(row.zona), cleanXlsxText(row.subzona), cleanXlsxText(row.area_codigo), cleanXlsxText(row.area), cleanXlsxText(row.sku),
      cleanXlsxText(row.tipo), cleanXlsxText(row.nombre), cleanXlsxText(row.estado_compra), cleanXlsxNumber(row.prioridad),
      cleanXlsxNumber(row.inventario_actual), cleanXlsxNumber(row.inventario_deseado), cleanXlsxNumber(row.cantidad_a_comprar),
      cleanXlsxNumber(row.precio_unitario), cleanXlsxText(row.moneda), cleanXlsxNumber(row.subtotal), cleanXlsxText(row.liga_compra),
    ]),
  ];

  const wb = XLSX.utils.book_new();
  const wsCategories = XLSX.utils.aoa_to_sheet(categoryAoa);
  wsCategories["!cols"] = [{ wch: 44 }, { wch: 10 }, { wch: 18 }, { wch: 10 }, { wch: 16 }];
  applyXlsxMoneyFormat(wsCategories, categoryAoa.length - 1, ["E"], "D");

  const wsBreakdown = XLSX.utils.aoa_to_sheet(breakdownAoa);
  wsBreakdown["!cols"] = [{ wch: 10 }, { wch: 28 }, { wch: 12 }, { wch: 30 }, { wch: 44 }, { wch: 10 }, { wch: 18 }, { wch: 10 }, { wch: 16 }];
  applyXlsxMoneyFormat(wsBreakdown, breakdownAoa.length - 1, ["I"], "H");

  const wsDetail = XLSX.utils.aoa_to_sheet(detailAoa);
  wsDetail["!cols"] = [
    { wch: 20 }, { wch: 24 }, { wch: 16 }, { wch: 28 }, { wch: 12 }, { wch: 16 }, { wch: 36 }, { wch: 24 },
    { wch: 10 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 16 }, { wch: 40 },
  ];
  applyXlsxMoneyFormat(wsDetail, detailAoa.length - 1, ["M", "O"], "N");

  XLSX.utils.book_append_sheet(wb, wsCategories, "Totales categoria");
  XLSX.utils.book_append_sheet(wb, wsBreakdown, "Zona subzona categoria");
  XLSX.utils.book_append_sheet(wb, wsDetail, "Detalle items");

  const date = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `reporte_compras_fablab_${date}.xlsx`, { bookType: "xlsx", compression: true });
}

function bindExportOverrides() {
  document.addEventListener("click", event => {
    const exportInventory = event.target.closest("#exportXlsx");
    const exportReport = event.target.closest("#exportPurchaseReport");
    const exportPdf = event.target.closest("#exportPurchasePdf");
    if (!exportInventory && !exportReport && !exportPdf) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (exportPdf) {
      exportPurchaseReportPdf();
      return;
    }

    const rows = effectiveRows();
    if (exportInventory) exportVisibleXlsx(rows);
    else exportPurchaseReportXlsx(rows);
  }, true);
}

function observePurchaseCards() {
  const itemsList = document.querySelector("#itemsList");
  if (!itemsList) return;
  observer = new MutationObserver(() => queueEnhancements());
  observer.observe(itemsList, { childList: true, subtree: true });
}

async function loadPurchaseItems() {
  const snapshot = await getDocs(query(collection(db, "items"), where("activo", "==", true)));
  itemsById.clear();
  snapshot.docs.forEach(itemDoc => {
    itemsById.set(itemDoc.id, { id: itemDoc.id, ...itemDoc.data() });
  });
}

async function initPurchaseWorkflow() {
  injectStyles();

  // Primero validamos únicamente la sesión y el rol.
  const user = await waitForUser();
  if (!user) {
    window.location.replace("login.html");
    return;
  }

  const profile = await getUserProfile(user.uid);
  currentAccessRole = profile?.appRole || profile?.role || "";

  if (!ALLOWED_ROLES.has(currentAccessRole)) {
    alert("La sección de Compras está disponible únicamente para Administrador y Supervisor.");
    window.location.replace("index.html");
    return;
  }

  // Una vez validado el acceso, mostramos inmediatamente la página.
  // La consulta adicional de items puede terminar en segundo plano sin
  // mantener al usuario frente a una pantalla blanca.
  revealPage();

  // La interfaz base no necesita esperar la consulta completa de Firestore.
  addFilters();
  addPrioritySortOption();
  addLegend();
  addPdfReportButton();
  bindPurchaseActions();
  bindExportOverrides();

  // Cargamos los datos adicionales de Compras con la página ya visible.
  await loadPurchaseItems();

  // Finalmente decoramos tarjetas, prioridades, estados y reportes.
  observePurchaseCards();
  queueEnhancements();
}

initPurchaseWorkflow().catch(error => {
  console.error("No se pudo inicializar el flujo de Compras:", error);
  alert(`No se pudo abrir Compras: ${error.message}`);
  window.location.replace("index.html");
});
