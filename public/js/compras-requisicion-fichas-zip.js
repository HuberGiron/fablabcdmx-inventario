/*
 * FabLab IBERO CDMX — Fichas individuales por REQUISICIÓN (ZIP, PDF por línea)
 * Lectura exclusivamente. No cambia solicitudes, inventario ni presupuesto.
 * Requiere jsPDF 2.5.2 y JSZip 3.10.1 (cargados en compras.html).
 */
import { auth, db } from "./firebase-app.js";
import { apiFetch, fileViewUrl, getUserProfile, waitForUser } from "./common.js";
import { doc, getDoc, getDocs, query, collection, where, limit } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const ALLOWED = new Set(["admin", "supervisor"]);
const RED = [199, 16, 46];
const FONT = "helvetica";
const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
const MARGIN = 16;
const FOOTER_TOP = PAGE_HEIGHT - 35;
let busy = false;
let rolePromise = null;

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

async function loadCatalogFallback(lines) {
  // IMPORTANTE: reproducir la misma política que Fichas ZIP de SC, que sí
  // incorpora fotografías. El snapshot de la solicitud es la primera fuente.
  const catalog = new Map();
  const linesToLookup = lines.filter(line =>
    !text(line.imageFileId) || !validHttpUrl(line.purchaseUrl) || !line.descripcion || !line.nombre
  );
  const ids = [...new Set(linesToLookup.map(line => text(line.itemId || line.id)).filter(Boolean))];
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

// Recuperación excepcional cuando una SC histórica guarda un ID antiguo de
// artículo, pero el SKU sí existe en el catálogo. Sólo lectura, sin escribir.
async function catalogBySku(line, catalog, bySkuCache) {
  const sku = text(line.sku);
  if (!sku) return null;
  if (!bySkuCache.has(sku)) {
    bySkuCache.set(sku, (async () => {
      const result = await getDocs(query(collection(db, "items"), where("sku", "==", sku), limit(2)));
      if (result.empty) return null;
      if (result.size > 1) throw new Error(`SKU duplicado en catálogo: ${sku}`);
      return result.docs[0].data();
    })().catch(error => { console.warn(`No se pudo resolver la foto por SKU ${sku}:`, error); return null; }));
  }
  return await bySkuCache.get(sku);
}

function fichaData(request, line, catalog) {
  const current = catalog.get(text(line.itemId || line.id)) || {};
  const requested = number(line.quantityRequested);
  // Los datos de identidad/cantidad de la solicitud prevalecen sobre el catálogo.
  // Liga, imagen y descripción se completan con el inventario si faltan en la SC.
  return {
    requisition: text(line.requisitionNumber || line.externalRequisitionNumber || "Sin número"),
    institutionStatus: plain(line.externalReportedStatus || "Sin reporte institucional"),
    expectedDelivery: plain(line.externalExpectedDeliveryDate || "Sin fecha registrada"),
    purchaseOrder: plain(line.externalPurchaseOrderNumber || "Sin orden registrada"),
    actualSpent: number(line.actualCostTotal ?? (number(line.quantityReceived)*number(line.lastActualUnitCost ?? line.unitPrice))),
    folio: text(request.folio || request.id),
    alias: plain(request.alias),
    name: plain(line.nombre || current.nombre || "Artículo sin nombre"),
    sku: text(line.sku || current.sku || line.id),
    type: plain(line.tipo || current.tipo),
    description: plain(line.descripcion || current.descripcion || "No se registró una descripción técnica."),
    purchaseUrl: validHttpUrl(line.purchaseUrl) || validHttpUrl(current.purchaseUrl),
    infoUrl: validHttpUrl(line.infoUrl) || validHttpUrl(current.infoUrl),
    // Preferir la imagen vigente del inventario; conservar el snapshot como
    // segunda opción si el archivo actual no está accesible.
    // Prioridad idéntica a Fichas ZIP de SC: snapshot original -> catálogo.
    imageFileId: text(line.imageFileId || current.imageFileId),
    imageFallbackId: text(current.imageFileId) && text(current.imageFileId) !== text(line.imageFileId) ? text(current.imageFileId) : "",
    quantity: requested,
    received: number(line.quantityReceived),
    cancelled: number(line.quantityCancelled),
    pending: pendingQuantity(line),
    currency: text(line.currency || current.moneda || "MXN").toUpperCase(),
    estimatedUnitPrice: number(line.requisitionUnitCost ?? line.unitPrice ?? current.precioUnitario),
    zone: plain(line.zoneName || current.zoneName),
    subzone: plain(line.subzoneName || current.subzoneName),
    area: plain([line.locationCode || current.locationCode, line.locationName || current.locationName].filter(Boolean).join(" · ")),
    status: statusLabel(line),
  };
}

function imageMime(bytes, declared) {
  // Algunas instalaciones de FastAPI devuelven la foto como octet-stream;
  // comprobar su firma binaria antes de descartar un fichero válido.
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0,4)) === "RIFF" && String.fromCharCode(...b.slice(8,12)) === "WEBP") return "image/webp";
  if (b.length >= 6 && String.fromCharCode(...b.slice(0,3)) === "GIF") return "image/gif";
  const mime = String(declared || "").toLowerCase().split(";")[0].trim();
  return ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime) ? mime : "";
}

// Método de descarga, decodificación y JPEG tomado del generador probado de
// Solicitudes de compra; conservamos además la detección de tipos genéricos.
async function getImage(fileId, cache) {
  if (!fileId) return null;
  if (cache.has(fileId)) return cache.get(fileId);
  const promise = (async () => {
    const res = await apiFetch(`/api/files/${encodeURIComponent(fileId)}/view`);
    const blob = await res.blob();
    const signature = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
    const mime = imageMime(signature, blob.type);
    if (!mime) throw new Error(`El archivo no es una imagen compatible (${blob.type || "sin tipo"}).`);
    const url = URL.createObjectURL(new Blob([blob], {type: mime}));
    try {
      const img = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("No se pudo decodificar la imagen."));
        element.src = url;
      });
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1200 / img.naturalWidth, 800 / img.naturalHeight);
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("El navegador no pudo crear el lienzo de imagen.");
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      return {url: canvas.toDataURL("image/jpeg", 0.83), width:canvas.width, height:canvas.height};
    } finally {
      URL.revokeObjectURL(url);
    }
  })().catch(async error => {
    // Respaldo de la versión anterior: la misma dirección usada por la tarjeta
    // HTML del inventario. Sólo funciona cuando el servidor permite leer los
    // píxeles en canvas (mismo origen o CORS habilitado).
    try {
      const src = fileViewUrl(fileId);
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        if (new URL(src, document.baseURI).origin !== location.origin) element.crossOrigin = "anonymous";
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("El enlace de imagen no pudo cargarse."));
        element.src = src;
      });
      const canvas = document.createElement("canvas");
      const scale = Math.min(1,1200/image.naturalWidth,800/image.naturalHeight);
      canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));
      canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
      const ctx=canvas.getContext("2d");
      ctx.fillStyle="white";ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
      return {url:canvas.toDataURL("image/jpeg",0.83),width:canvas.width,height:canvas.height};
    } catch (fallbackError) {
      console.warn(`No se pudo integrar fotografía ID ${fileId}:`, error, fallbackError);
      return null;
    }
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
  pdf.text(continuation ? "FICHA DE REQUISICIÓN (CONTINUACIÓN)" : "FICHA INDIVIDUAL DE COMPRA", MARGIN, 28);
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
  pdf.setFontSize(10);
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
  pdf.setFontSize(10);
  pdf.setTextColor(...RED);
  pdf.text(label.toUpperCase(), MARGIN, y);
  y += 6;
  pdf.setFont(FONT, "normal");
  pdf.setFontSize(10.5);
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
  pdf.text(`Requisición: ${ficha.requisition}     Cantidad recibida: ${ficha.received}     Cancelada: ${ficha.cancelled}`, MARGIN, y, { maxWidth: PAGE_WIDTH - 2 * MARGIN });
  y += 6;
  pdf.text(`Costo unitario vigente: $${formatMoney(ficha.estimatedUnitPrice, ficha.currency)}`, MARGIN, y, { maxWidth: PAGE_WIDTH - 2 * MARGIN });
  y += 11;

  // Liga prioritaria, de alto contraste y clicable (antes de fotografía y descripción).
  const urlLines = pdf.splitTextToSize(ficha.purchaseUrl || "No registrada", PAGE_WIDTH - MARGIN * 2 - 12);
  const urlHeight = Math.max(21, 12 + urlLines.length*5.2);
  y = ensureRoom(pdf, ficha, y, urlHeight+5);
  pdf.setFillColor(234,244,255);pdf.setDrawColor(75,130,192);
  pdf.roundedRect(MARGIN, y-6, PAGE_WIDTH-2*MARGIN, urlHeight, 2, 2, 'FD');
  y = addUrl(pdf, ficha, "Liga de compra · clic para abrir", ficha.purchaseUrl, y+2);

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

  y = addWrapped(pdf, ficha, "Seguimiento de Compras", `Estado institucional: ${ficha.institutionStatus} | Fecha estimada: ${ficha.expectedDelivery} | Orden de compra: ${ficha.purchaseOrder}`, y, {fontSize:9});
  y = addWrapped(pdf, ficha, "Situación en FabLab", `Estado: ${ficha.status} | Recibido: ${ficha.received} | Pendiente: ${ficha.pending} | Gasto real recibido: $${formatMoney(ficha.actualSpent,ficha.currency)}`, y, {fontSize:9});
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


// Sólo lectura. Se alimenta de la vista agrupada por requisición, que ya ha
// consultado todas las SC relacionadas. No escribe nada en Firestore.
function busyButton(button, on, message=''){
 if(!button)return;
 if(on){if(!button.dataset.originalReqZipLabel)button.dataset.originalReqZipLabel=button.textContent;
  button.disabled=true;button.textContent=message||'Preparando fichas…';button.setAttribute('aria-busy','true');}
 else {button.disabled=false;button.textContent=button.dataset.originalReqZipLabel||'Fichas ZIP';delete button.dataset.originalReqZipLabel;button.removeAttribute('aria-busy');}
}
async function downloadRequisitionSheets(event){
 if(busy)return;
 if(!await canReadPurchases()){alert('Solo administradores y supervisores pueden descargar fichas.');return;}
 if(!window.JSZip||!window.jspdf?.jsPDF){alert('No se cargaron jsPDF o JSZip. Actualiza la página y comprueba las bibliotecas.');return;}
 const {group,button}=event.detail||{};
 if(!group||!Array.isArray(group.lines)||!group.lines.length){alert('No se pudieron obtener los productos de esta requisición. Actualiza el listado.');return;}
 busy=true;busyButton(button,true);
 try{
  const lines=[...group.lines].sort((a,b)=>String(a.sku||'').localeCompare(String(b.sku||''),'es',{numeric:true}));
  const catalog=await loadCatalogFallback(lines);
  const zip=new window.JSZip(),photoCache=new Map(),bySkuCache=new Map();
  let missingLinks=0,missingPhotos=0;
  const missingPhotoSkus=[];
  const reqNumber=text(group.folio||'SIN-NUMERO');
  for(let i=0;i<lines.length;i++){
   const line=lines[i],req={id:line.requestId,folio:line.requestFolio,alias:line.requestAlias};
   const ficha=fichaData(req,line,catalog);
   // Las primeras dos rutas SON las mismas que usa Fichas ZIP de SC.
   let photo=await getImage(ficha.imageFileId,photoCache);
   if(!photo&&ficha.imageFallbackId)photo=await getImage(ficha.imageFallbackId,photoCache);
   // Sólo para SC antiguas sin imagen funcional: resolver ID vigente por SKU.
   if(!photo){
     const current = await catalogBySku(line,catalog,bySkuCache);
     if(current?.imageFileId)photo=await getImage(text(current.imageFileId),photoCache);
   }
   if(!photo){missingPhotos++;missingPhotoSkus.push(ficha.sku); }
   if(!ficha.purchaseUrl)missingLinks++;
   const bytes=buildPdf(ficha,photo);
   zip.file(`${safeFilename(reqNumber)}_${String(i+1).padStart(3,'0')}_${safeFilename(ficha.sku)}_${safeFilename(ficha.name).slice(0,32)}.pdf`,bytes);
   busyButton(button,true,`Fichas ${i+1}/${lines.length}…`);
   if(i%4===3)await new Promise(resolve=>requestAnimationFrame(resolve));
  }
  busyButton(button,true,'Empaquetando ZIP…');
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`REQUISICION_${safeFilename(reqNumber)}_FICHAS_INDIVIDUALES.zip`;
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  if(missingLinks||missingPhotos){
    const examples = missingPhotoSkus.length ? `\nSin fotografía: ${missingPhotoSkus.slice(0,12).join(', ')}${missingPhotoSkus.length>12?'…':''}` : '';
    alert(`Se generaron ${lines.length} fichas. Datos faltantes: ${missingLinks} ligas de compra y ${missingPhotos} fotografías.\nLas fotos no disponibles pueden deberse a ausencia de imageFileId o error de acceso; revisa la consola del navegador.${examples}`);
  }
 }catch(error){console.error('ZIP fichas de requisición:',error);alert('No se pudieron descargar las fichas: '+error.message);}
 finally{busy=false;busyButton(button,false);}
}
document.addEventListener('ibero:requisition-sheets',event=>{void downloadRequisitionSheets(event);});
