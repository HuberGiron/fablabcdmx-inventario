/*
 * ============================================================================
 * COMPRAS · COLORES DE ESTADO EN PDF DE SOLICITUDES
 * ============================================================================
 *
 * Corrige de forma no invasiva los PDF extendido y agrupado.
 * La clasificación usa el estado REAL de cada línea:
 *
 *   amarillo = en compras (pendiente, todavía sin requisición activa)
 *   azul     = en requisición (pendiente con requisición activa)
 *   verde    = recibido completo
 *   rojo     = cancelado / resuelto sin recibir todo lo solicitado
 *
 * No modifica Firestore ni las solicitudes guardadas.
 * ============================================================================
 */

const PDF_BUTTON_SELECTOR = [
  "#purchaseRequestDetailPdf",
  "#purchaseRequestDetailPdfGrouped",
  ".request-history-pdf",
  ".request-history-pdf-grouped",
].join(", ");

const STYLE_ID = "purchasePdfStatusColorFix";
const STATE_CLASSES = [
  "pdf-state-purchase",
  "pdf-state-requisition",
  "pdf-state-received",
  "pdf-state-cancelled",
];

let pdfOpenArmedUntil = 0;

const STATE_LABELS = {
  purchase: "En compras",
  requisition: "En requisición",
  received: "Recibido",
  cancelled: "Cancelado / faltante",
};
const nativeWindowOpen = window.open.bind(window);

function num(value) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function classifyLine({ requested = 0, received = 0, cancelled = 0, pending = 0, requisition = false } = {}) {
  const qRequested = Math.max(num(requested), 0);
  const qReceived = Math.max(num(received), 0);
  const qCancelled = Math.max(num(cancelled), 0);
  const qPending = Math.max(num(pending), 0);

  // Un renglón cerrado sólo es verde si TODO lo solicitado llegó.
  // Cualquier cancelación o faltante resuelto sin recepción completa es rojo.
  if (qPending <= 0) {
    if (qRequested > 0 && qReceived >= qRequested && qCancelled <= 0) {
      return "received";
    }
    return "cancelled";
  }

  if (requisition) return "requisition";
  return "purchase";
}

function groupState(states) {
  const values = new Set(states);

  // Mientras exista algo activo, mostramos la etapa operativa más avanzada.
  if (values.has("requisition")) return "requisition";
  if (values.has("purchase")) return "purchase";

  // Una agrupación cerrada sólo es verde si todas sus líneas llegaron completas.
  if (values.size === 1 && values.has("received")) return "received";
  return "cancelled";
}

function stateClass(state) {
  return `pdf-state-${state}`;
}

function applyStateClass(element, state) {
  if (!element) return;
  element.classList.remove(...STATE_CLASSES);
  element.classList.add(stateClass(state));
  element.dataset.pdfPurchaseState = state;
}

function stateBadgeHtml(state) {
  return `<span class="pdf-state-badge ${stateClass(state)}">${STATE_LABELS[state] || state}</span>`;
}

function extractExtendedQuantities(card) {
  const text = card.querySelector(".status-band")?.textContent || card.textContent || "";
  const value = label => {
    const match = text.match(new RegExp(`${label}\\s*:\\s*([0-9]+(?:[.,][0-9]+)?)`, "i"));
    return match ? num(match[1].replace(",", ".")) : 0;
  };

  return {
    requested: value("Solicitado"),
    received: value("Recibido"),
    cancelled: value("Cancelado"),
    pending: value("Pendiente"),
    requisition:
      card.classList.contains("request-report-requisition")
      || /en requisici[oó]n/i.test(card.textContent || ""),
  };
}

function colorExtendedCards(doc) {
  const cards = [...doc.querySelectorAll(".request-report-card")];

  cards.forEach(card => {
    const state = classifyLine(extractExtendedQuantities(card));
    applyStateClass(card, state);

    const band = card.querySelector(".status-band");
    applyStateClass(band, state);

    const headText = card.querySelector(".request-report-head > div:first-child");
    if (headText) {
      let wrap = headText.querySelector(".pdf-state-badge-wrap");
      if (!wrap) {
        wrap = doc.createElement("div");
        wrap.className = "pdf-state-badge-wrap mt-1";
        const existingReq = headText.querySelector(".req-badge")?.parentElement;
        if (existingReq) existingReq.replaceWith(wrap);
        else headText.appendChild(wrap);
      }
      wrap.innerHTML = stateBadgeHtml(state);
    }
  });

  return cards.length;
}

function groupedRowQuantities(row) {
  const cells = [...row.querySelectorAll("td")];
  if (cells.length < 9) return null;

  return {
    requested: num(cells[5]?.textContent),
    received: num(cells[6]?.textContent),
    cancelled: num(cells[7]?.textContent),
    pending: num(cells[8]?.textContent),
    requisition: /requisici[oó]n/i.test(cells[4]?.textContent || ""),
  };
}

function colorGroupedCards(doc) {
  const groups = [...doc.querySelectorAll(".group-card")];

  groups.forEach(card => {
    const rows = [...card.querySelectorAll(".pdf-breakdown-table tbody tr")];
    const states = [];

    rows.forEach(row => {
      const quantities = groupedRowQuantities(row);
      if (!quantities) return;
      const state = classifyLine(quantities);
      states.push(state);
      applyStateClass(row, state);
      if (row.children[4]) row.children[4].innerHTML = stateBadgeHtml(state);
    });

    if (states.length) {
      const state = groupState(states);
      applyStateClass(card, state);

      const headText = card.querySelector(".group-head > div:first-child");
      if (headText) {
        let badge = headText.querySelector(".pdf-group-state");
        if (!badge) {
          badge = doc.createElement("div");
          badge.className = "pdf-group-state";
          headText.appendChild(badge);
        }
        badge.innerHTML = stateBadgeHtml(state);
      }
    }
  });

  return groups.length;
}

function ensurePdfStyles(doc) {
  if (!doc?.head || doc.getElementById(STYLE_ID)) return;

  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* Amarillo · en compras */
    .request-report-card.pdf-state-purchase,
    .group-card.pdf-state-purchase {
      border-color:#e0b12f !important;
      border-left:2mm solid #e0b12f !important;
      background:#fffdf5 !important;
    }
    .status-band.pdf-state-purchase {
      background:#fff3cd !important;
      border-left-color:#e0b12f !important;
    }

    /* Azul · en requisición */
    .request-report-card.pdf-state-requisition,
    .group-card.pdf-state-requisition {
      border-color:#0d6efd !important;
      border-left:2mm solid #0d6efd !important;
      background:#f5f9ff !important;
    }
    .status-band.pdf-state-requisition {
      background:#e7f1ff !important;
      border-left-color:#0d6efd !important;
    }

    /* Verde · recibido completo */
    .request-report-card.pdf-state-received,
    .group-card.pdf-state-received {
      border-color:#198754 !important;
      border-left:2mm solid #198754 !important;
      background:#f3fbf6 !important;
    }
    .status-band.pdf-state-received {
      background:#d1e7dd !important;
      border-left-color:#198754 !important;
    }

    /* Rojo · cancelado / faltante cerrado */
    .request-report-card.pdf-state-cancelled,
    .group-card.pdf-state-cancelled {
      border-color:#dc3545 !important;
      border-left:2mm solid #dc3545 !important;
      background:#fff6f7 !important;
    }
    .status-band.pdf-state-cancelled {
      background:#f8d7da !important;
      border-left-color:#dc3545 !important;
    }

    .pdf-state-badge-wrap,
    .pdf-group-state {
      margin-top:1mm;
    }
    .pdf-state-badge {
      display:inline-block;
      border-radius:99px;
      padding:1mm 2mm;
      font-size:7.5pt;
      font-weight:700;
      border:1px solid transparent;
    }
    .pdf-state-badge.pdf-state-purchase {
      background:#fff3cd !important;
      border-color:#e0b12f !important;
      color:#664d03 !important;
    }
    .pdf-state-badge.pdf-state-requisition {
      background:#0d6efd !important;
      border-color:#0d6efd !important;
      color:#fff !important;
    }
    .pdf-state-badge.pdf-state-received {
      background:#198754 !important;
      border-color:#198754 !important;
      color:#fff !important;
    }
    .pdf-state-badge.pdf-state-cancelled {
      background:#dc3545 !important;
      border-color:#dc3545 !important;
      color:#fff !important;
    }

    /* Desglose por SKU del PDF agrupado. */
    .pdf-breakdown-table tbody tr.pdf-state-purchase > td {
      background:#fff3cd !important;
    }
    .pdf-breakdown-table tbody tr.pdf-state-requisition > td {
      background:#e7f1ff !important;
    }
    .pdf-breakdown-table tbody tr.pdf-state-received > td {
      background:#d1e7dd !important;
    }
    .pdf-breakdown-table tbody tr.pdf-state-cancelled > td {
      background:#f8d7da !important;
    }

    @media print {
      .request-report-card,
      .group-card,
      .status-band,
      .pdf-breakdown-table td {
        -webkit-print-color-adjust:exact !important;
        print-color-adjust:exact !important;
      }
    }
  `;
  doc.head.appendChild(style);
}

function applyPdfColors(popup) {
  try {
    const doc = popup?.document;
    if (!doc?.documentElement) return false;

    const extendedCount = doc.querySelectorAll(".request-report-card").length;
    const groupedCount = doc.querySelectorAll(".group-card").length;
    if (!extendedCount && !groupedCount) return false;

    ensurePdfStyles(doc);
    if (extendedCount) colorExtendedCards(doc);
    if (groupedCount) colorGroupedCards(doc);
    return true;
  } catch (_) {
    return false;
  }
}

function attachToPdfPopup(popup) {
  if (!popup) return;

  // Garantía final: justo antes de abrir el diálogo de impresión volvemos a
  // clasificar y colorear. Esto evita carreras con document.write()/load.
  try {
    const nativePrint = popup.print.bind(popup);
    let insidePrint = false;

    popup.print = function patchedPrint() {
      if (!insidePrint) {
        insidePrint = true;
        try {
          applyPdfColors(popup);
        } finally {
          insidePrint = false;
        }
      }
      return nativePrint();
    };
  } catch (_) {
    // El sondeo de abajo sigue siendo suficiente si el navegador no deja
    // sustituir window.print.
  }

  const started = Date.now();
  const timer = window.setInterval(() => {
    if (popup.closed || Date.now() - started > 15000) {
      window.clearInterval(timer);
      return;
    }

    if (applyPdfColors(popup)) {
      // Dejamos unas pasadas extra porque el generador puede volver a escribir
      // el documento mientras termina de cargar imágenes.
      window.setTimeout(() => applyPdfColors(popup), 80);
      window.setTimeout(() => applyPdfColors(popup), 220);
      window.setTimeout(() => window.clearInterval(timer), 500);
    }
  }, 40);
}

// Se arma en fase de captura para ejecutarse ANTES de los handlers que abren
// la ventana del PDF en compras-status.js / compras-request-grouping.js.
document.addEventListener("click", event => {
  if (!event.target?.closest?.(PDF_BUTTON_SELECTOR)) return;
  pdfOpenArmedUntil = performance.now() + 60000;
}, true);

window.open = function patchedOpen(...args) {
  const popup = nativeWindowOpen(...args);

  if (popup && performance.now() <= pdfOpenArmedUntil) {
    pdfOpenArmedUntil = 0;
    attachToPdfPopup(popup);
  }

  return popup;
};
