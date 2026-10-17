/*
 * FabLab IBERO CDMX — Fichas individuales de compra (PDF por SKU en un ZIP)
 * Lectura exclusivamente. No cambia solicitudes, inventario ni presupuesto.
 * Requiere jsPDF 2.5.2 y JSZip 3.10.1 (cargados en compras.html).
 */
import { auth, db } from "./firebase-app.js";
import { apiFetch, getUserProfile, waitForUser } from "./common.js";
import { collection, doc, getDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const HISTORY_BUTTON_CLASS = "request-history-individual-sheets";
const DETAIL_BUTTON_ID = "purchaseRequestIndividualSheets";
const ALLOWED = new Set(["admin", "supervisor"]);
const RED = [199, 16, 46];
const FONT = "helvetica";
const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
const MARGIN = 16;
const FOOTER_TOP = PAGE_HEIGHT - 35;
let busy = false;
let rolePromise = null;
let queued = false;

const text = value => String(value ?? "").trim();
const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const pendingQuantity = line => Math.max(0, number(line.quantityRequested) - number(line.quantityReceived) - number(line.quantityCancelled));
const validHttpUrl = value => {
  try {
    const parsed = new URL(text(value));
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
  } catch (_) { return ""; }
};
const safeFilename = value => text(value).normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-zA-Z0-9_-]+/g, "_")
  .replace(/^_+|_+$/g, "")
  .slice(0, 68) || "producto";

function formatMoney(amount, currency) {
  const code = text(currency).toUpperCase() || "MXN";
  return `${new Intl.NumberFormat("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number(amount))} ${code}`;
}

async function canReadPurchases() {
  if (!rolePromise) {
    rolePromise = (async () => {
      const user = auth.currentUser || await waitForUser();
      if (!user) return false;
      const profile = await getUserProfile(user.uid);
      return ALLOWED.has(profile?.appRole || profile?.role);
    })().catch(error => { console.error(error); return false; });
  }
  return rolePromise;
}

function statusLabel(line) {
  const pending = pendingQuantity(line);
  if (pending <= 0 && number(line.quantityReceived) > 0) return "Recibido";
  if (pending <= 0) return "Cancelado";
  if (line.requisitionStatus === "requisitioned") return "En requisición";
  return "En compras";
}

function plain(value) {
  // Evita controles invisibles que jsPDF no representa correctamente.
  return text(value).replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ");
}

async function loadBundle(requestId) {
  const requestRef = doc(db, "purchaseRequests", requestId);
  const [requestSnap, lineSnap] = await Promise.all([
    getDoc(requestRef),
    getDocs(collection(db, "purchaseRequests", requestId, "items")),
  ]);
  if (!requestSnap.exists()) throw new Error("La solicitud de compra ya no existe.");
  const request = { id: requestId, ...requestSnap.data() };
  const lines = lineSnap.docs.map(snapshot => ({ id: snapshot.id, ...snapshot.data() }));
  if (!lines.length) throw new Error("La solicitud no contiene artículos.");
  return { request, lines };
}

async function loadCatalogFallback(lines) {
  // Una sola ficha es suficientemente autónoma gracias al snapshot de la SC,
  // pero se consultan datos vigentes si la SC no tiene foto, liga o descripción.
  const catalog = new Map();
  const ids = [...new Set(lines
    .filter(line => !line.imageFileId || !validHttpUrl(line.purchaseUrl) || !line.descripcion || !line.nombre)
    .map(line => text(line.itemId || line.id))
    .filter(Boolean))];
  let index = 0;
  const workers = Array.from({ length: Math.min(6, ids.length) }, async () => {
    while (index < ids.length) {
      const id = ids[index++];
      try {
        const snap = await getDoc(doc(db, "items", id));
        if (snap.exists()) catalog.set(id, snap.data());
      } catch (error) {
        console.warn(`No se pudo consultar el catálogo para ${id}:`, error);
      }
    }
  });
  await Promise.all(workers);
  return catalog;
}

function fichaData(request, line, catalog) {
  const current = catalog.get(text(line.itemId || line.id)) || {};
  const requested = number(line.quantityRequested);
  // Los datos de identidad/cantidad de la solicitud prevalecen sobre el catálogo.
  // Liga, imagen y descripción se completan con el inventario si faltan en la SC.
  return {
    folio: text(request.folio || request.id),
    alias: plain(request.alias),
    name: plain(line.nombre || current.nombre || "Artículo sin nombre"),
    sku: text(line.sku || current.sku || line.id),
    type: plain(line.tipo || current.tipo),
    description: plain(line.descripcion || current.descripcion || "No se registró una descripción técnica."),
    purchaseUrl: validHttpUrl(line.purchaseUrl) || validHttpUrl(current.purchaseUrl),
    infoUrl: validHttpUrl(line.infoUrl) || validHttpUrl(current.infoUrl),
    imageFileId: text(line.imageFileId || current.imageFileId),
    imageFallbackId: text(current.imageFileId) !== text(line.imageFileId) ? text(current.imageFileId) : "",
    quantity: requested,
    received: number(line.quantityReceived),
    cancelled: number(line.quantityCancelled),
    pending: pendingQuantity(line),
    currency: text(line.currency || current.moneda || "MXN").toUpperCase(),
    estimatedUnitPrice: number(line.unitPrice ?? current.precioUnitario),
    zone: plain(line.zoneName || current.zoneName),
    subzone: plain(line.subzoneName || current.subzoneName),
    area: plain([line.locationCode || current.locationCode, line.locationName || current.locationName].filter(Boolean).join(" · ")),
    status: statusLabel(line),
  };
}

async function getImage(fileId, cache) {
  if (!fileId) return null;
  if (cache.has(fileId)) return cache.get(fileId);
  const promise = (async () => {
    // El endpoint real de fotos usa el backend FastAPI del inventario;
    // apiFetch agrega el token de Firebase cuando es necesario.
    const result = await apiFetch(`/api/files/${encodeURIComponent(fileId)}/view`);
    const blob = await result.blob();
    if (!blob.type.startsWith("image/")) throw new Error("El archivo no es una imagen.");
    const url = URL.createObjectURL(blob);
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("No se pudo decodificar la imagen."));
        element.src = url;
      });
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1200 / image.naturalWidth, 800 / image.naturalHeight);
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("El navegador no pudo crear el lienzo de imagen.");
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return { url: canvas.toDataURL("image/jpeg", 0.83), width: canvas.width, height: canvas.height };
    } finally {
      URL.revokeObjectURL(url);
    }
  })().catch(error => {
    console.warn(`La fotografía ${fileId} no pudo integrarse:`, error);
    return null;
  });
  cache.set(fileId, promise);
  return promise;
}

function addHeading(pdf, ficha, continuation = false) {
  pdf.setFillColor(...RED);
  pdf.rect(0, 0, PAGE_WIDTH, 6, "F");
  pdf.setFont(FONT, "bold");
  pdf.setFontSize(9);
  pdf.setTextColor(...RED);
  pdf.text("UNIVERSIDAD IBEROAMERICANA CIUDAD DE MÉXICO  ·  FABLAB", MARGIN, 16);
  pdf.setFontSize(17);
  pdf.setTextColor(22, 27, 34);
  pdf.text(continuation ? "FICHA DE PRODUCTO (CONTINUACIÓN)" : "FICHA INDIVIDUAL DE COMPRA", MARGIN, 28);
  // El folio de la SC, su alias y el SKU son referencias internas:
  // sólo deben aparecer en el pie, nunca en la cabecera comercial.
  return 38;
}

function addFooter(pdf, ficha) {
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    pdf.setPage(page);
    pdf.setDrawColor(216, 222, 229);
    pdf.line(MARGIN, FOOTER_TOP, PAGE_WIDTH - MARGIN, FOOTER_TOP);
    pdf.setFont(FONT, "bold");
    pdf.setFontSize(8);
    pdf.setTextColor(91, 101, 112);
    pdf.text("INFORMACIÓN INTERNA DEL FABLAB", MARGIN, FOOTER_TOP + 6);
    pdf.setFont(FONT, "normal");
    pdf.setFontSize(8);
    pdf.text(`Solicitud de compra (SC): ${ficha.folio}`, MARGIN, FOOTER_TOP + 13, {
      maxWidth: PAGE_WIDTH - 2 * MARGIN,
    });
    pdf.text(`SKU interno: ${ficha.sku}`, MARGIN, FOOTER_TOP + 20, {
      maxWidth: PAGE_WIDTH - 2 * MARGIN,
    });
    if (ficha.alias) {
      const alias = pdf.splitTextToSize(`Alias interno: ${ficha.alias}`, PAGE_WIDTH - 2 * MARGIN - 20);
      pdf.text(alias[0] || "", MARGIN, FOOTER_TOP + 27);
    }
    pdf.text(`${page}/${pages}`, PAGE_WIDTH - MARGIN, FOOTER_TOP + 27, { align: "right" });
  }
}

function ensureRoom(pdf, ficha, y, height) {
  if (y + height <= FOOTER_TOP - 7) return y;
  pdf.addPage();
  return addHeading(pdf, ficha, true) + 3;
}

function addWrapped(pdf, ficha, label, content, y, { fontSize = 10, color = [43, 49, 57], lineHeight = 5 } = {}) {
  y = ensureRoom(pdf, ficha, y, 12);
  pdf.setFont(FONT, "bold");
  pdf.setFontSize(9);
  pdf.setTextColor(...RED);
  pdf.text(label.toUpperCase(), MARGIN, y);
  y += 6;
  pdf.setFont(FONT, "normal");
  pdf.setTextColor(...color);
  pdf.setFontSize(fontSize);
  const wrapped = pdf.splitTextToSize(content || "No registrado", PAGE_WIDTH - MARGIN * 2);
  for (const line of wrapped) {
    y = ensureRoom(pdf, ficha, y, lineHeight + 1);
    pdf.text(line, MARGIN, y);
    y += lineHeight;
  }
  return y + 4;
}

function addUrl(pdf, ficha, label, url, y) {
  y = ensureRoom(pdf, ficha, y, 13);
  pdf.setFont(FONT, "bold");
  pdf.setFontSize(9);
  pdf.setTextColor(...RED);
  pdf.text(label.toUpperCase(), MARGIN, y);
  y += 6;
  pdf.setFont(FONT, "normal");
  pdf.setFontSize(9);
  if (!url) {
    pdf.setTextColor(145, 76, 52);
    pdf.text("No se registró una liga válida.", MARGIN, y);
    return y + 10;
  }
  pdf.setTextColor(10, 87, 173);
  const wrapped = pdf.splitTextToSize(url, PAGE_WIDTH - MARGIN * 2);
  for (const line of wrapped) {
    y = ensureRoom(pdf, ficha, y, 6);
    pdf.text(line, MARGIN, y);
    const width = Math.min(PAGE_WIDTH - MARGIN * 2, pdf.getTextWidth(line));
    pdf.link(MARGIN, y - 4.2, width, 5.7, { url });
    y += 4.7;
  }
  return y + 5;
}

function buildPdf(ficha, image) {
  const PDF = window.jspdf?.jsPDF;
  if (!PDF) throw new Error("No se cargó jsPDF. Comprueba tu conexión y vuelve a cargar Compras.");
  const pdf = new PDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  let y = addHeading(pdf, ficha);
  pdf.setFont(FONT, "bold");
  pdf.setFontSize(14);
  pdf.setTextColor(25, 28, 34);
  const titleLines = pdf.splitTextToSize(ficha.name, PAGE_WIDTH - MARGIN * 2);
  for (const line of titleLines) {
    y = ensureRoom(pdf, ficha, y, 7);
    pdf.text(line, MARGIN, y);
    y += 6.7;
  }
  y += 2;
  pdf.setFontSize(9);
  pdf.setFont(FONT, "normal");
  pdf.setTextColor(73, 82, 93);
  const quantities = `Cantidad solicitada: ${ficha.quantity}     Pendiente: ${ficha.pending}`;
  pdf.text(quantities, MARGIN, y, { maxWidth: PAGE_WIDTH - 2 * MARGIN });
  y += 6;
  pdf.text(`Estado: ${ficha.status}     Precio unitario de referencia: $${formatMoney(ficha.estimatedUnitPrice, ficha.currency)}`, MARGIN, y, { maxWidth: PAGE_WIDTH - 2 * MARGIN });
  y += 11;

  // El vínculo es el dato prioritario del comprador: siempre aparece antes de la foto.
  y = addUrl(pdf, ficha, "Liga de compra (clic para abrir)", ficha.purchaseUrl, y);

  if (image) {
    y = ensureRoom(pdf, ficha, y, 76);
    const box = { x: MARGIN, y, width: PAGE_WIDTH - 2 * MARGIN, height: 68 };
    pdf.setDrawColor(227, 232, 238);
    pdf.setFillColor(251, 251, 252);
    pdf.roundedRect(box.x, box.y, box.width, box.height, 2, 2, "FD");
    const ratio = Math.min((box.width - 8) / image.width, (box.height - 8) / image.height);
    const width = image.width * ratio;
    const height = image.height * ratio;
    pdf.addImage(image.url, "JPEG", box.x + (box.width - width) / 2, box.y + (box.height - height) / 2, width, height, undefined, "FAST");
    y += 73;
  } else {
    y = ensureRoom(pdf, ficha, y, 25);
    pdf.setDrawColor(227, 232, 238);
    pdf.setFillColor(249, 250, 252);
    pdf.roundedRect(MARGIN, y, PAGE_WIDTH - 2 * MARGIN, 17, 2, 2, "FD");
    pdf.setFontSize(9);
    pdf.setTextColor(125, 131, 143);
    pdf.text("Fotografía no disponible en el inventario", PAGE_WIDTH / 2, y + 10, { align: "center" });
    y += 23;
  }

  y = addWrapped(pdf, ficha, "Descripción técnica / identificación", ficha.description, y);
  if (ficha.type) y = addWrapped(pdf, ficha, "Categoría", ficha.type, y, { fontSize: 9 });
  const zone = [ficha.zone, ficha.subzone, ficha.area].filter(Boolean).join(" · ");
  if (zone) y = addWrapped(pdf, ficha, "Área solicitante", zone, y, { fontSize: 9 });
  if (ficha.infoUrl && ficha.infoUrl !== ficha.purchaseUrl) {
    y = addUrl(pdf, ficha, "Información técnica adicional", ficha.infoUrl, y);
  }
  addFooter(pdf, ficha);
  return pdf.output("arraybuffer");
}

// La señal visual de progreso pertenece EXCLUSIVAMENTE al botón pulsado.
// El resto de solicitudes conserva sus etiquetas y su apariencia original.
function setBusyButton(button, isBusy, label = "") {
  if (!button) return;
  button.disabled = isBusy;
  if (isBusy) {
    if (!button.dataset.originalFichasLabel) {
      button.dataset.originalFichasLabel = button.textContent;
    }
    button.textContent = label || "Generando fichas…";
    button.setAttribute("aria-busy", "true");
  } else {
    if (button.dataset.originalFichasLabel) {
      button.textContent = button.dataset.originalFichasLabel;
      delete button.dataset.originalFichasLabel;
    }
    button.removeAttribute("aria-busy");
  }
}

function ensureButtons() {
  if (!document.querySelector("#purchaseRequestsPanel")) return;
  document.querySelectorAll(".request-history-pdf[data-request-id]").forEach(pdfButton => {
    const container = pdfButton.parentElement;
    if (!container || container.querySelector(`.${HISTORY_BUTTON_CLASS}`)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn btn-outline-primary btn-sm ${HISTORY_BUTTON_CLASS}`;
    button.dataset.requestId = pdfButton.dataset.requestId;
    button.textContent = "Fichas ZIP";
    button.title = "Descargar un PDF individual por cada SKU de esta solicitud";
    pdfButton.insertAdjacentElement("afterend", button);
  });
  const detailPdf = document.querySelector("#purchaseRequestDetailPdf");
  const footer = detailPdf?.parentElement;
  if (footer && !footer.querySelector(`#${DETAIL_BUTTON_ID}`)) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = DETAIL_BUTTON_ID;
    button.className = "btn btn-outline-primary";
    button.textContent = "Fichas individuales (ZIP)";
    button.title = "Descargar todos los productos de la solicitud en archivos PDF separados";
    detailPdf.insertAdjacentElement("afterend", button);
  }
  const detailButton = document.querySelector(`#${DETAIL_BUTTON_ID}`);
  if (detailButton && detailPdf) {
    detailButton.dataset.requestId = detailPdf.dataset.requestId || "";
    detailButton.classList.toggle("d-none", !detailButton.dataset.requestId || detailPdf.classList.contains("d-none"));
  }
}

function refreshButtonsSoon() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; ensureButtons(); });
}

async function downloadFichasZip(requestId, sourceButton) {
  if (busy) return;
  if (!(await canReadPurchases())) {
    alert("Sólo el administrador y el supervisor pueden descargar fichas de las solicitudes.");
    return;
  }
  if (!window.JSZip || !window.jspdf?.jsPDF) {
    alert("No se cargaron las bibliotecas para PDF y ZIP. Verifica tu conexión y recarga Compras.");
    return;
  }
  busy = true;
  setBusyButton(sourceButton, true, "Preparando fichas…");
  try {
    const { request, lines } = await loadBundle(requestId);
    const catalog = await loadCatalogFallback(lines);
    const zip = new window.JSZip();
    const photos = new Map();
    const folio = safeFilename(request.folio || requestId);
    let missingPhotos = 0;
    let missingLinks = 0;
    const ordered = [...lines].sort((a, b) => text(a.sku).localeCompare(text(b.sku), "es", { numeric: true }));

    for (const [index, line] of ordered.entries()) {
      const ficha = fichaData(request, line, catalog);
      let photo = await getImage(ficha.imageFileId, photos);
      if (!photo && ficha.imageFallbackId) photo = await getImage(ficha.imageFallbackId, photos);
      if (!photo) missingPhotos += 1;
      if (!ficha.purchaseUrl) missingLinks += 1;
      const pdf = buildPdf(ficha, photo);
      const filename = `${folio}_${String(index + 1).padStart(3, "0")}_${safeFilename(ficha.sku)}_${safeFilename(ficha.name).slice(0, 32)}.pdf`;
      zip.file(filename, pdf);
      setBusyButton(sourceButton, true, `Fichas ${index + 1}/${ordered.length}…`);
      // Cede el turno al navegador para actualizar el contador en solicitudes grandes.
      if (index % 5 === 4) await new Promise(resolve => requestAnimationFrame(resolve));
    }

    setBusyButton(sourceButton, true, "Empaquetando ZIP…");
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${folio}_FICHAS_INDIVIDUALES.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    const notes = [];
    if (missingPhotos) notes.push(`${missingPhotos} sin fotografía descargable`);
    if (missingLinks) notes.push(`${missingLinks} sin liga de compra registrada`);
    if (notes.length) {
      alert(`Se generaron ${ordered.length} fichas individuales. Revisar: ${notes.join("; ")}.`);
    }
  } catch (error) {
    console.error("No se pudieron generar las fichas de compra:", error);
    alert(`No se pudieron generar las fichas: ${error.message}`);
  } finally {
    busy = false;
    setBusyButton(sourceButton, false);
  }
}

document.addEventListener("click", event => {
  const button = event.target.closest(`.${HISTORY_BUTTON_CLASS}, #${DETAIL_BUTTON_ID}`);
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const requestId = text(button.dataset.requestId || document.querySelector("#purchaseRequestDetailPdf")?.dataset.requestId);
  if (requestId) void downloadFichasZip(requestId, button);
});

document.addEventListener("purchase-request-detail-rendered", refreshButtonsSoon);
document.addEventListener("shown.bs.modal", event => {
  if (event.target?.id === "purchaseRequestDetailModal") refreshButtonsSoon();
});
new MutationObserver(refreshButtonsSoon).observe(document.body, { childList: true, subtree: true });
refreshButtonsSoon();
