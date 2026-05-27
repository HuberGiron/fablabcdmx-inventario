import { db } from "./firebase-app.js";
import { setupNav, $, fileViewUrl, downloadProtectedFile, uploadItemAsset, waitForUser, getUserProfile } from "./common.js";
import {
  collection, getDocs, addDoc, serverTimestamp, query, where, doc, updateDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

setupNav();

const ITEM_TYPES = ["Máquina", "Herramienta", "Consumible","Cómputo", "Material", "Refacción", "Accesorio", "Equipo auxiliar", "Equipo de seguridad", "Mobiliario", "Kit", "Otro", "Maquina"];

const LOCATION_TYPES = [
  ["machine", "Máquina"],
  ["workstation", "Estación de trabajo"],
  ["table", "Mesa"],
  ["cabinet", "Gabinete"],
  ["drawer", "Gaveta"],
  ["shelf", "Repisa"],
  ["rack", "Rack"],
  ["vitrine", "Vitrina"],
  ["storage", "Almacén"],
  ["cart", "Carrito"],
  ["wall_panel", "Panel de herramientas"],
  ["safety_station", "Estación de seguridad"],
  ["general", "General"],
  ["other", "Otro"],
];

const LOCATION_TYPE_LABELS = Object.fromEntries(LOCATION_TYPES);

let zones = [];
let subzones = [];
let weeks = [];
let locations = [];
let items = [];
let filtered = [];
let currentUser = null;
let currentProfile = null;
let currentRole = "public";
let isStaff = false;

function cart() {
  return JSON.parse(localStorage.getItem("fablab_cart") || "[]");
}

function saveCart(data) {
  localStorage.setItem("fablab_cart", JSON.stringify(data));
  renderCartCount();
}

function renderCartCount() {
  const n = cart().reduce((a, b) => a + Number(b.cantidad || 0), 0);
  const el = $("#cartCount");
  if (el) el.textContent = n;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeDomId(value) {
  return encodeURIComponent(String(value || "id")).replaceAll("%", "_");
}

function isAdmin() {
  return currentRole === "admin";
}

function sortLocations(arr) {
  return [...arr].sort((a,b)=>
    String(a.subzoneId || "").localeCompare(String(b.subzoneId || ""), undefined, {numeric:true}) ||
    Number(a.order || 999) - Number(b.order || 999) ||
    String(a.name || "").localeCompare(String(b.name || ""), "es")
  );
}

function locationOption(l) {
  return `<option value="${esc(l.locationId)}">${esc(locationOptionLabel(l, true))}</option>`;
}

function locationById(id) {
  return locations.find(l => String(l.locationId) === String(id) || String(l.id) === String(id));
}

function locationDisplayCode(l) {
  return l?.areaCode || l?.locationCode || l?.subzoneId || "";
}

function itemLocationCode(it) {
  return it?.locationCode || locationById(it?.locationId)?.areaCode || locationById(it?.locationId)?.locationCode || it?.subzoneId || "";
}

function formatCurrency(value, currency = "MXN") {
  const n = Number(value || 0);
  const code = currency || "MXN";
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

function currencyOptions(selected = "MXN") {
  const currencies = ["MXN", "USD", "EUR"];
  return currencies.map(c => `<option value="${esc(c)}" ${String(c) === String(selected || "MXN") ? "selected" : ""}>${esc(c)}</option>`).join("");
}

function adminPriceBlock(it) {
  if (!isAdmin()) return "";
  const currency = it.moneda || "MXN";
  const price = Number(it.precioUnitario || 0);
  return `
    <div class="admin-price-pill mt-2">
      <span class="admin-price-label">Precio unitario</span>
      <span class="admin-price-value">${esc(formatCurrency(price, currency))}</span>
    </div>`;
}

function locationOptionLabel(l, includeType = true) {
  const code = locationDisplayCode(l);
  const label = LOCATION_TYPE_LABELS[l.type] || l.type || "";
  const typeText = includeType && label ? ` (${label})` : "";
  return `${code ? `${code} · ` : ""}${l.name || "Sin nombre"}${typeText}`;
}

function zoneOptions(selected = "") {
  return zones.map(z => `<option value="${esc(z.zoneId)}" ${String(z.zoneId) === String(selected) ? "selected" : ""}>${esc(z.zoneId)} · ${esc(z.name)}</option>`).join("");
}

function subzoneOptions(zoneId = "", selected = "") {
  return subzones
    .filter(s => !zoneId || String(s.zoneId) === String(zoneId))
    .map(s => `<option value="${esc(s.subzoneId)}" ${String(s.subzoneId) === String(selected) ? "selected" : ""}>${esc(s.subzoneId)} · ${esc(s.name)}</option>`)
    .join("");
}

function locationsFor(zoneId = "", subzoneId = "") {
  return sortLocations(locations.filter(l =>
    l.active !== false &&
    (!zoneId || String(l.zoneId) === String(zoneId)) &&
    (!subzoneId || String(l.subzoneId) === String(subzoneId))
  ));
}

function locationOptionsFor(zoneId = "", subzoneId = "", selected = "", includeEmpty = true) {
  const opts = locationsFor(zoneId, subzoneId).map(l =>
    `<option value="${esc(l.locationId)}" ${String(l.locationId) === String(selected) ? "selected" : ""}>${esc(locationOptionLabel(l, true))}</option>`
  ).join("");
  return `${includeEmpty ? '<option value="">Sin ubicación específica</option>' : ""}${opts}`;
}

function machineOptionsFor(zoneId = "", subzoneId = "", selected = "", includeEmpty = true) {
  const opts = locationsFor(zoneId, subzoneId).filter(l => l.type === "machine").map(l =>
    `<option value="${esc(l.locationId)}" ${String(l.locationId) === String(selected) ? "selected" : ""}>${esc(locationOptionLabel(l, false))}</option>`
  ).join("");
  return `${includeEmpty ? '<option value="">Ninguna</option>' : ""}${opts}`;
}

function parentLocationOptionsFor(zoneId = "", subzoneId = "", selected = "", currentLocationId = "") {
  const opts = locationsFor(zoneId, subzoneId)
    .filter(l => String(l.locationId) !== String(currentLocationId))
    .map(l => `<option value="${esc(l.locationId)}" ${String(l.locationId) === String(selected) ? "selected" : ""}>${esc(locationOptionLabel(l, true))}</option>`)
    .join("");
  return `<option value="">Sin ubicación padre</option>${opts}`;
}

function itemTypeOptions(selected = "") {
  return ITEM_TYPES.map(t => `<option value="${esc(t)}" ${String(t) === String(selected) ? "selected" : ""}>${esc(t)}</option>`).join("");
}

function locationTypeOptions(selected = "") {
  return LOCATION_TYPES.map(([value, label]) => `<option value="${esc(value)}" ${String(value) === String(selected) ? "selected" : ""}>${esc(label)}</option>`).join("");
}

function weekOptions(selectedIds = []) {
  const ids = (selectedIds || []).map(String);
  return weeks.map(w => `<option value="${esc(w.weekId)}" ${ids.includes(String(w.weekId)) ? "selected" : ""}>${esc(w.weekId)} · ${esc(w.name)}</option>`).join("");
}

function namesForWeeks(ids) {
  return ids.map(id => weeks.find(w => Number(w.weekId) === Number(id))?.name || String(id));
}

async function loadCurrentUserContext() {
  currentUser = await waitForUser();
  currentProfile = currentUser ? await getUserProfile(currentUser.uid) : null;
  currentRole = currentProfile?.role || (currentUser ? "alumno" : "public");
  isStaff = currentRole === "admin" || currentRole === "tecnico";

  const cartBtn = $("#openCart");
  if (cartBtn) cartBtn.classList.toggle("d-none", isStaff);

}

async function loadBase() {
  await loadCurrentUserContext();

  const itemsQuery = isStaff
    ? query(collection(db, "items"), where("activo", "==", true))
    : query(collection(db, "items"), where("activo", "==", true), where("visibleParaAlumno", "==", true));

  const [zSnap, sSnap, wSnap, lSnap, iSnap] = await Promise.all([
    getDocs(collection(db, "zones")),
    getDocs(collection(db, "subzones")),
    getDocs(collection(db, "fabacademyWeeks")),
    getDocs(query(collection(db, "locations"), where("active", "==", true))),
    getDocs(itemsQuery),
  ]);

  zones = zSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b)=>a.zoneId-b.zoneId);
  subzones = sSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b)=>String(a.subzoneId).localeCompare(String(b.subzoneId), undefined, {numeric:true}));
  weeks = wSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b)=>a.weekId-b.weekId);
  locations = sortLocations(lSnap.docs.map(d => ({ id: d.id, ...d.data() })));
  items = iSnap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function fillSelects() {
  const zone = $("#filterZone");
  const sub = $("#filterSubzone");
  const week = $("#filterWeek");
  const tipo = $("#filterTipo");
  const loc = $("#filterLocation");
  const rel = $("#filterRelatedMachine");

  if (tipo) tipo.innerHTML = '<option value="">Todos los tipos</option>' + ITEM_TYPES.map(t => `<option>${esc(t)}</option>`).join("");
  if (zone) zone.innerHTML = '<option value="">Todas las zonas</option>' + zones.map(z => `<option value="${esc(z.zoneId)}">${esc(z.zoneId)} · ${esc(z.name)}</option>`).join("");
  if (sub) sub.innerHTML = '<option value="">Todas las subzonas</option>' + subzones.map(s => `<option value="${esc(s.subzoneId)}" data-zone="${esc(s.zoneId)}">${esc(s.subzoneId)} · ${esc(s.name)}</option>`).join("");
  if (week) week.innerHTML = '<option value="">Todas las semanas FabAcademy</option>' + weeks.map(w => `<option value="${esc(w.weekId)}">${esc(w.weekId)} · ${esc(w.name)}</option>`).join("");
  if (loc) loc.innerHTML = '<option value="">Todas las ubicaciones</option>' + locations.map(locationOption).join("");
  if (rel) rel.innerHTML = '<option value="">Todas las máquinas relacionadas</option>' + locations.filter(l => l.type === "machine").map(locationOption).join("");
}

function refreshDependentFilters() {
  const zoneId = $("#filterZone")?.value || "";
  const subzoneId = $("#filterSubzone")?.value || "";
  const sub = $("#filterSubzone");
  const loc = $("#filterLocation");
  const rel = $("#filterRelatedMachine");

  if (sub) {
    const current = sub.value;
    sub.innerHTML = '<option value="">Todas las subzonas</option>' + subzones
      .filter(s => !zoneId || String(s.zoneId) === String(zoneId))
      .map(s => `<option value="${esc(s.subzoneId)}" data-zone="${esc(s.zoneId)}">${esc(s.subzoneId)} · ${esc(s.name)}</option>`).join("");
    if ([...sub.options].some(o => o.value === current)) sub.value = current;
  }

  const locs = locations.filter(l =>
    (!zoneId || String(l.zoneId) === String(zoneId)) &&
    (!subzoneId || String(l.subzoneId) === String(subzoneId))
  );

  if (loc) {
    const current = loc.value;
    loc.innerHTML = '<option value="">Todas las ubicaciones</option>' + locs.map(locationOption).join("");
    if ([...loc.options].some(o => o.value === current)) loc.value = current;
  }
  if (rel) {
    const current = rel.value;
    rel.innerHTML = '<option value="">Todas las máquinas relacionadas</option>' + locs.filter(l => l.type === "machine").map(locationOption).join("");
    if ([...rel.options].some(o => o.value === current)) rel.value = current;
  }
}

function applyFilters() {
  const search = ($("#search")?.value || "").toLowerCase();
  const zoneId = $("#filterZone")?.value || "";
  const subzoneId = $("#filterSubzone")?.value || "";
  const locationId = $("#filterLocation")?.value || "";
  const relatedMachineId = $("#filterRelatedMachine")?.value || "";
  const weekId = $("#filterWeek")?.value || "";
  const tipo = $("#filterTipo")?.value || "";

  filtered = items.filter(it => {
    if (zoneId && String(it.zoneId) !== zoneId) return false;
    if (subzoneId && String(it.subzoneId) !== subzoneId) return false;
    if (locationId && String(it.locationId || "") !== locationId) return false;
    if (relatedMachineId && String(it.relatedMachineId || "") !== relatedMachineId) return false;
    if (weekId && !(it.fabacademyWeeks || []).map(String).includes(weekId)) return false;
    if (tipo && it.tipo !== tipo) return false;
    if (search) {
      const hay = `${it.sku || ""} ${it.nombre || ""} ${it.descripcion || ""} ${it.zoneName || ""} ${it.subzoneName || ""} ${it.locationName || ""} ${it.relatedMachineName || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  renderItems();
}

function statusBadges(it) {
  const badges = [];
  if (isStaff && it.visibleParaAlumno === false) badges.push(`<span class="badge text-bg-secondary">Oculto alumno</span>`);
  if (it.prestamoHabilitado === true) badges.push(`<span class="badge text-bg-primary">Prestable</span>`);
  else badges.push(`<span class="badge text-bg-light border">No prestable</span>`);
  if (it.reservaHabilitada === true) badges.push(`<span class="badge text-bg-warning">Reservable/asistencia</span>`);
  if (it.requiereAsistencia === true) badges.push(`<span class="badge text-bg-info">Requiere técnico</span>`);
  return badges.join(" ");
}

function pathCards(it) {
  const zoneText = `${it.zoneId || ""}${it.zoneName ? ` · ${it.zoneName}` : ""}`.trim();
  const subzoneText = `${it.subzoneId || ""}${it.subzoneName ? ` · ${it.subzoneName}` : ""}`.trim();
  const areaCode = itemLocationCode(it) || "s/c";
  const areaText = it.locationName || "Sin ubicación";
  return `
    <div class="path-compact my-2">
      <span><strong>Zona:</strong> ${esc(zoneText || "Sin zona")}</span>
      <span><strong>Subzona:</strong> ${esc(subzoneText || "Sin subzona")}</span>
      <span><strong>Área:</strong> <span class="area-code-chip">${esc(areaCode)}</span> ${esc(areaText)}</span>
    </div>`;
}

function actionControls(it, disponible) {
  if (isStaff) return "";

  if (it.prestamoHabilitado === true) {
    return `
      <input type="number" min="1" max="${disponible}" value="1" class="form-control form-control-sm qty-input" id="qty-${esc(it.id)}" ${disponible <= 0 ? 'disabled' : ''}>
      <button class="btn btn-sm btn-primary add-cart" data-id="${esc(it.id)}" ${disponible <= 0 ? 'disabled' : ''}>Agregar al carrito</button>
      ${disponible <= 0 ? '<span class="small text-danger">Sin stock disponible</span>' : ''}`;
  }

  if (it.reservaHabilitada === true) {
    return `<button class="btn btn-sm btn-outline-primary reserve-assistance" data-id="${esc(it.id)}">Reservar / pedir asistencia</button>`;
  }

  return `<span class="small text-muted">Elemento solo de consulta.</span>`;
}

function adminControls(it) {
  if (!isAdmin()) return "";
  const hasLocation = Boolean(it.locationId);
  return `
    <div class="admin-card-actions mt-3 pt-3 border-top">
      <div class="d-flex flex-wrap gap-2">
        <button class="btn btn-sm btn-outline-primary admin-edit-item" data-id="${esc(it.id)}">Editar item</button>
        <button class="btn btn-sm btn-outline-dark admin-edit-location" data-id="${esc(it.id)}" ${hasLocation ? "" : "disabled"}>Editar área</button>
        <button class="btn btn-sm btn-outline-warning admin-deactivate-item" data-id="${esc(it.id)}">Desactivar</button>
        <button class="btn btn-sm btn-outline-danger admin-delete-item" data-id="${esc(it.id)}">Eliminar</button>
      </div>
      <div id="admin-panel-${safeDomId(it.id)}" class="inline-admin-panel mt-3"></div>
    </div>`;
}


function documentationButton(it) {
  const fileId = it.documentationFileId || it.pdfFileId || "";
  if (!fileId) return "";
  const filename = it.documentationFilename || it.pdfFilename || `${it.nombre || "documentacion"}.pdf`;
  return `<button class="btn btn-sm btn-outline-secondary file-download" data-file="${esc(fileId)}" data-name="${esc(filename)}">Descargar documentación</button>`;
}

function renderItems() {
  const target = $("#itemsList");
  if (!target) return;

  $("#resultCount").textContent = `${filtered.length} resultado(s)`;

  target.innerHTML = filtered.map(it => {
    const disponible = Number(it.stockAlmacen || 0);
    const weeksText = (it.fabacademyWeekNames || []).join(", ");
    return `
      <div class="item-card card shadow-sm mb-3" data-item-id="${esc(it.id)}">
        <div class="row g-0">
          <div class="col-md-2 image-wrap">
            <img src="${fileViewUrl(it.imageFileId)}" onerror="this.src='assets/placeholder.svg'" class="img-fluid rounded-start item-image" alt="${esc(it.nombre || '')}">
          </div>
          <div class="col-md-10">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-start gap-2 flex-wrap">
                <div>
                  <h5 class="card-title mb-1">${esc(it.nombre || "Sin nombre")}</h5>
                  <div class="text-muted small">${esc(it.sku || "")} · ${esc(it.tipo || "")} · Disponible: <strong>${disponible}</strong> · Deseado: <strong>${Number(it.inventarioDeseado || 0)}</strong></div>
                  <div class="mt-1">${statusBadges(it)}</div>
                  ${adminPriceBlock(it)}
                </div>
              </div>
              ${pathCards(it)}
              <p class="card-text mt-2">${esc(it.descripcion || "")}</p>
              ${it.relatedMachineName ? `<div class="small mb-1"><strong>Máquina relacionada:</strong> ${esc(it.relatedMachineName)}</div>` : ""}
              <div class="small mb-2"><strong>FabAcademy:</strong> ${esc(weeksText || "Sin clasificación")}</div>
              <div class="d-flex flex-wrap gap-2 align-items-center">
                ${it.infoUrl ? `<a class="btn btn-sm btn-outline-primary" href="${esc(it.infoUrl)}" target="_blank" rel="noopener">Más info</a>` : ''}
                ${documentationButton(it)}
                ${it.datasheetFileId ? `<button class="btn btn-sm btn-outline-secondary file-download" data-file="${esc(it.datasheetFileId)}" data-name="${esc(it.datasheetFilename || it.nombre || 'ficha-tecnica')}">Ficha técnica</button>` : ''}
                ${actionControls(it, disponible)}
              </div>
              ${adminControls(it)}
            </div>
          </div>
        </div>
      </div>`;
  }).join("");

  bindCardActions();
}

function bindCardActions() {
  document.querySelectorAll(".add-cart").forEach(btn => btn.addEventListener("click", () => addToCart(btn.dataset.id)));
  document.querySelectorAll(".reserve-assistance").forEach(btn => btn.addEventListener("click", () => requestAssistance(btn.dataset.id)));
  document.querySelectorAll(".file-download").forEach(btn => btn.addEventListener("click", () => downloadProtectedFile(btn.dataset.file, btn.dataset.name)));

  if (!isAdmin()) return;

  document.querySelectorAll(".admin-edit-item").forEach(btn => btn.addEventListener("click", () => openItemEditor(btn.dataset.id)));
  document.querySelectorAll(".admin-edit-location").forEach(btn => btn.addEventListener("click", () => openLocationEditorForItem(btn.dataset.id)));
  document.querySelectorAll(".admin-deactivate-item").forEach(btn => btn.addEventListener("click", () => deactivateItem(btn.dataset.id)));
  document.querySelectorAll(".admin-delete-item").forEach(btn => btn.addEventListener("click", () => deleteItem(btn.dataset.id)));
}

function panelForItem(itemId) {
  return document.getElementById(`admin-panel-${safeDomId(itemId)}`);
}

function closeAllPanelsExcept(itemId) {
  document.querySelectorAll(".inline-admin-panel").forEach(panel => {
    if (panel.id !== `admin-panel-${safeDomId(itemId)}`) panel.innerHTML = "";
  });
}

function openItemEditor(itemId) {
  const it = items.find(x => x.id === itemId);
  if (!it) return;
  closeAllPanelsExcept(itemId);
  const panel = panelForItem(itemId);
  if (!panel) return;
  if (panel.dataset.mode === "item") {
    panel.innerHTML = "";
    panel.dataset.mode = "";
    return;
  }
  panel.dataset.mode = "item";
  panel.innerHTML = renderItemEditor(it);
  bindInlineItemForm(panel, itemId);
}

function renderItemEditor(it) {
  return `
    <div class="quick-edit-card">
      <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
        <div>
          <h6 class="mb-1">Edición rápida del item</h6>
          <div class="small text-muted">Edita datos básicos y carga imagen/documentación del item.</div>
        </div>
        <button type="button" class="btn btn-sm btn-outline-secondary close-inline-panel">Cerrar</button>
      </div>
      <form class="quick-edit-item-form" data-id="${esc(it.id)}">
        <div class="row g-2">
          <div class="col-md-3">
            <label class="form-label small">SKU</label>
            <input name="sku" class="form-control form-control-sm" value="${esc(it.sku || "")}" required>
          </div>
          <div class="col-md-5">
            <label class="form-label small">Nombre</label>
            <input name="nombre" class="form-control form-control-sm" value="${esc(it.nombre || "")}" required>
          </div>
          <div class="col-md-4">
            <label class="form-label small">Tipo</label>
            <select name="tipo" class="form-select form-select-sm">${itemTypeOptions(it.tipo || "Otro")}</select>
          </div>

          <div class="col-md-12">
            <label class="form-label small">Descripción</label>
            <textarea name="descripcion" class="form-control form-control-sm" rows="3">${esc(it.descripcion || "")}</textarea>
          </div>

          <div class="col-md-3">
            <label class="form-label small">Zona</label>
            <select name="zoneId" class="form-select form-select-sm qe-zone">${zoneOptions(it.zoneId)}</select>
          </div>
          <div class="col-md-3">
            <label class="form-label small">Subzona</label>
            <select name="subzoneId" class="form-select form-select-sm qe-subzone">${subzoneOptions(it.zoneId, it.subzoneId)}</select>
          </div>
          <div class="col-md-3">
            <label class="form-label small">Área / ubicación</label>
            <select name="locationId" class="form-select form-select-sm qe-location">${locationOptionsFor(it.zoneId, it.subzoneId, it.locationId)}</select>
          </div>
          <div class="col-md-3">
            <label class="form-label small">Máquina relacionada</label>
            <select name="relatedMachineId" class="form-select form-select-sm qe-machine">${machineOptionsFor(it.zoneId, it.subzoneId, it.relatedMachineId)}</select>
          </div>

          <div class="col-md-4">
            <label class="form-label small">Semanas FabAcademy</label>
            <select name="fabacademyWeeks" class="form-select form-select-sm" multiple size="5">${weekOptions(it.fabacademyWeeks || [])}</select>
          </div>
          <div class="col-md-8">
            <label class="form-label small">Visibilidad y acciones</label>
            <div class="quick-switch-grid">
              <label class="form-check"><input class="form-check-input" type="checkbox" name="visibleParaAlumno" ${it.visibleParaAlumno !== false ? "checked" : ""}> Visible para alumnos</label>
              <label class="form-check"><input class="form-check-input" type="checkbox" name="prestamoHabilitado" ${it.prestamoHabilitado === true ? "checked" : ""}> Se puede prestar</label>
              <label class="form-check"><input class="form-check-input" type="checkbox" name="reservaHabilitada" ${it.reservaHabilitada === true ? "checked" : ""}> Reservable/asistencia</label>
              <label class="form-check"><input class="form-check-input" type="checkbox" name="requiereAsistencia" ${it.requiereAsistencia === true ? "checked" : ""}> Requiere técnico</label>
            </div>
          </div>

          <div class="col-md-2">
            <label class="form-label small">Stock almacén</label>
            <input name="stockAlmacen" type="number" class="form-control form-control-sm" value="${Number(it.stockAlmacen || 0)}">
          </div>
          <div class="col-md-2">
            <label class="form-label small">Deseado</label>
            <input name="inventarioDeseado" type="number" class="form-control form-control-sm" value="${Number(it.inventarioDeseado || 0)}">
          </div>
          <div class="col-md-2">
            <label class="form-label small">Prestado</label>
            <input name="stockPrestadoTemporal" type="number" class="form-control form-control-sm" value="${Number(it.stockPrestadoTemporal || 0)}">
          </div>
          <div class="col-md-2">
            <label class="form-label small">Largo plazo</label>
            <input name="stockLargoPlazo" type="number" class="form-control form-control-sm" value="${Number(it.stockLargoPlazo || 0)}">
          </div>
          <div class="col-md-2">
            <label class="form-label small">Dañado</label>
            <input name="stockDanado" type="number" class="form-control form-control-sm" value="${Number(it.stockDanado || 0)}">
          </div>
          <div class="col-md-2">
            <label class="form-label small">Perdido</label>
            <input name="stockPerdido" type="number" class="form-control form-control-sm" value="${Number(it.stockPerdido || 0)}">
          </div>

          <div class="col-md-4">
            <label class="form-label small">Precio unitario</label>
            <input name="precioUnitario" type="number" step="0.01" min="0" class="form-control form-control-sm" value="${Number(it.precioUnitario || 0)}">
          </div>
          <div class="col-md-2">
            <label class="form-label small">Moneda</label>
            <select name="moneda" class="form-select form-select-sm">${currencyOptions(it.moneda || "MXN")}</select>
          </div>
          <div class="col-md-6">
            <label class="form-label small">Liga de compra</label>
            <input name="purchaseUrl" class="form-control form-control-sm" value="${esc(it.purchaseUrl || "")}">
          </div>

          <div class="col-md-12">
            <label class="form-label small">Más info URL</label>
            <input name="infoUrl" class="form-control form-control-sm" value="${esc(it.infoUrl || "")}">
          </div>

          <div class="col-md-6">
            <label class="form-label small">Imagen del item</label>
            <input name="imageFile" type="file" accept="image/*" class="form-control form-control-sm">
            <div class="form-text">${it.imageFileId ? `Actual: ${esc(it.imageFilename || it.imageFileId)}` : "Sin imagen cargada"}</div>
          </div>
          <div class="col-md-6">
            <label class="form-label small">Documentación / manual / ficha</label>
            <input name="documentationFile" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,application/pdf" class="form-control form-control-sm">
            <div class="form-text">${it.documentationFileId || it.pdfFileId ? `Actual: ${esc(it.documentationFilename || it.pdfFilename || it.documentationFileId || it.pdfFileId)}` : "Sin documento cargado"}</div>
          </div>
        </div>

        <div class="alert alert-warning py-2 mt-3 mb-2 small">
          Estás editando el inventario real. Para altas masivas nuevas, el stock debe iniciar en 0 y solo debe cambiarse manualmente cuando se reciba físicamente.
        </div>

        <div class="d-flex flex-wrap gap-2 mt-2">
          <button class="btn btn-sm btn-primary">Guardar cambios</button>
          <button type="button" class="btn btn-sm btn-outline-secondary close-inline-panel">Cancelar</button>
        </div>
      </form>
    </div>`;
}

function bindInlineItemForm(panel, itemId) {
  panel.querySelectorAll(".close-inline-panel").forEach(btn => btn.addEventListener("click", () => { panel.innerHTML = ""; panel.dataset.mode = ""; }));

  const form = panel.querySelector(".quick-edit-item-form");
  const zoneSel = form.querySelector(".qe-zone");
  const subSel = form.querySelector(".qe-subzone");
  const locSel = form.querySelector(".qe-location");
  const machineSel = form.querySelector(".qe-machine");

  function refreshQuickItemRoute() {
    subSel.innerHTML = subzoneOptions(zoneSel.value, subSel.value);
    locSel.innerHTML = locationOptionsFor(zoneSel.value, subSel.value, locSel.value);
    machineSel.innerHTML = machineOptionsFor(zoneSel.value, subSel.value, machineSel.value);
  }

  zoneSel.addEventListener("change", () => {
    subSel.innerHTML = subzoneOptions(zoneSel.value, "");
    locSel.innerHTML = locationOptionsFor(zoneSel.value, subSel.value, "");
    machineSel.innerHTML = machineOptionsFor(zoneSel.value, subSel.value, "");
  });
  subSel.addEventListener("change", refreshQuickItemRoute);
  form.addEventListener("submit", e => saveInlineItem(e, itemId));
}


async function uploadSelectedAssets(form, itemId) {
  const uploaded = {};
  const image = form.imageFile?.files?.[0];
  const documentation = form.documentationFile?.files?.[0];

  if (image) {
    const result = await uploadItemAsset(itemId, "image", image);
    Object.assign(uploaded, result?.itemFields || {});
  }

  if (documentation) {
    const result = await uploadItemAsset(itemId, "documentation", documentation);
    Object.assign(uploaded, result?.itemFields || {});
  }

  return uploaded;
}

async function saveInlineItem(e, itemId) {
  e.preventDefault();
  const form = e.currentTarget;
  const zoneId = Number(form.zoneId.value);
  const subzoneId = form.subzoneId.value;
  const locationId = form.locationId.value || "";
  const relatedMachineId = form.relatedMachineId.value || "";
  const zone = zones.find(z => Number(z.zoneId) === Number(zoneId));
  const subzone = subzones.find(s => String(s.subzoneId) === String(subzoneId));
  const location = locationId ? locationById(locationId) : null;
  const relatedMachine = relatedMachineId ? locationById(relatedMachineId) : null;
  const fabIds = [...form.fabacademyWeeks.selectedOptions].map(o => Number(o.value));

  const payload = {
    sku: form.sku.value.trim(),
    nombre: form.nombre.value.trim(),
    descripcion: form.descripcion.value.trim(),
    tipo: form.tipo.value,
    zoneId,
    zoneName: zone?.name || "",
    subzoneId,
    subzoneName: subzone?.name || "",
    locationId,
    locationName: location?.name || "",
    locationCode: locationDisplayCode(location),
    locationType: location?.type || "",
    relatedMachineId,
    relatedMachineName: relatedMachine?.name || "",
    relatedMachineCode: locationDisplayCode(relatedMachine),
    fabacademyWeeks: fabIds,
    fabacademyWeekNames: namesForWeeks(fabIds),
    stockAlmacen: Number(form.stockAlmacen.value || 0),
    stockPrestadoTemporal: Number(form.stockPrestadoTemporal.value || 0),
    stockLargoPlazo: Number(form.stockLargoPlazo.value || 0),
    stockDanado: Number(form.stockDanado.value || 0),
    stockPerdido: Number(form.stockPerdido.value || 0),
    inventarioDeseado: Number(form.inventarioDeseado.value || 0),
    precioUnitario: Number(form.precioUnitario?.value || 0),
    moneda: form.moneda?.value || "MXN",
    visibleParaAlumno: form.visibleParaAlumno.checked,
    prestamoHabilitado: form.prestamoHabilitado.checked,
    reservaHabilitada: form.reservaHabilitada.checked,
    requiereAsistencia: form.requiereAsistencia.checked,
    infoUrl: form.infoUrl.value.trim(),
    purchaseUrl: form.purchaseUrl.value.trim(),
    updatedAt: serverTimestamp(),
  };

  await updateDoc(doc(db, "items", itemId), payload);

  let uploadedFields = {};
  try {
    uploadedFields = await uploadSelectedAssets(form, itemId);
  } catch (err) {
    alert(`El item se guardó, pero hubo un error al subir archivos: ${err.message}`);
  }

  items = items.map(x => x.id === itemId ? { ...x, ...payload, ...uploadedFields } : x);
  alert("Item actualizado.");
  applyFilters();
}

function openLocationEditorForItem(itemId) {
  const it = items.find(x => x.id === itemId);
  if (!it?.locationId) return alert("Este item no tiene ubicación específica.");
  const loc = locationById(it.locationId);
  if (!loc) return alert("No encontré la ubicación activa asociada al item.");

  closeAllPanelsExcept(itemId);
  const panel = panelForItem(itemId);
  if (!panel) return;
  if (panel.dataset.mode === "location") {
    panel.innerHTML = "";
    panel.dataset.mode = "";
    return;
  }
  panel.dataset.mode = "location";
  panel.innerHTML = renderLocationEditor(loc, itemId);
  bindInlineLocationForm(panel, loc, itemId);
}

function renderLocationEditor(loc, itemId) {
  return `
    <div class="quick-edit-card location-edit-card">
      <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
        <div>
          <h6 class="mb-1">Edición rápida del área / ubicación</h6>
          <div class="small text-muted">ID estable: <code>${esc(loc.locationId || loc.id)}</code></div>
        </div>
        <button type="button" class="btn btn-sm btn-outline-secondary close-inline-panel">Cerrar</button>
      </div>

      <form class="quick-edit-location-form" data-id="${esc(loc.id)}" data-location-id="${esc(loc.locationId)}">
        <div class="row g-2">
          <div class="col-md-4">
            <label class="form-label small">Zona</label>
            <select name="zoneId" class="form-select form-select-sm qe-location-zone">${zoneOptions(loc.zoneId)}</select>
          </div>
          <div class="col-md-4">
            <label class="form-label small">Subzona</label>
            <select name="subzoneId" class="form-select form-select-sm qe-location-subzone">${subzoneOptions(loc.zoneId, loc.subzoneId)}</select>
          </div>
          <div class="col-md-4">
            <label class="form-label small">Tipo</label>
            <select name="type" class="form-select form-select-sm">${locationTypeOptions(loc.type || "general")}</select>
          </div>

          <div class="col-md-3">
            <label class="form-label small">Código de área</label>
            <input name="areaCode" class="form-control form-control-sm" value="${esc(loc.areaCode || loc.locationCode || "")}" placeholder="Ej. 6.1.1">
          </div>
          <div class="col-md-5">
            <label class="form-label small">Nombre del área</label>
            <input name="name" class="form-control form-control-sm" value="${esc(loc.name || "")}" required>
          </div>
          <div class="col-md-2">
            <label class="form-label small">Orden</label>
            <input name="order" type="number" class="form-control form-control-sm" value="${Number(loc.order || 1)}">
          </div>
          <div class="col-md-4">
            <label class="form-label small">Ubicación padre</label>
            <select name="parentLocationId" class="form-select form-select-sm qe-location-parent">${parentLocationOptionsFor(loc.zoneId, loc.subzoneId, loc.parentLocationId || "", loc.locationId || loc.id)}</select>
          </div>

          <div class="col-md-12">
            <label class="form-label small">Descripción</label>
            <textarea name="description" class="form-control form-control-sm" rows="3">${esc(loc.description || "")}</textarea>
          </div>
        </div>

        <div class="alert alert-info py-2 mt-3 mb-2 small">
          El ID del área no se modifica aquí. El código visible <code>areaCode</code> sí puede cambiarse, por ejemplo <code>6.1.1</code>, y se sincroniza con los items asociados.
        </div>

        <div class="d-flex flex-wrap gap-2 mt-2">
          <button class="btn btn-sm btn-primary">Guardar área</button>
          <button type="button" class="btn btn-sm btn-outline-danger inline-delete-location" data-location-id="${esc(loc.locationId)}" data-item-id="${esc(itemId)}">Eliminar área</button>
          <button type="button" class="btn btn-sm btn-outline-secondary close-inline-panel">Cancelar</button>
        </div>
      </form>
    </div>`;
}

function bindInlineLocationForm(panel, loc, itemId) {
  panel.querySelectorAll(".close-inline-panel").forEach(btn => btn.addEventListener("click", () => { panel.innerHTML = ""; panel.dataset.mode = ""; }));

  const form = panel.querySelector(".quick-edit-location-form");
  const zoneSel = form.querySelector(".qe-location-zone");
  const subSel = form.querySelector(".qe-location-subzone");
  const parentSel = form.querySelector(".qe-location-parent");

  function refreshParentOptions() {
    parentSel.innerHTML = parentLocationOptionsFor(zoneSel.value, subSel.value, parentSel.value, loc.locationId || loc.id);
  }

  zoneSel.addEventListener("change", () => {
    subSel.innerHTML = subzoneOptions(zoneSel.value, "");
    refreshParentOptions();
  });
  subSel.addEventListener("change", refreshParentOptions);

  form.addEventListener("submit", e => saveInlineLocation(e, loc, itemId));
  panel.querySelector(".inline-delete-location")?.addEventListener("click", () => deleteLocationSafely(loc, itemId));
}

async function saveInlineLocation(e, loc, itemId) {
  e.preventDefault();
  const form = e.currentTarget;
  const zoneId = Number(form.zoneId.value);
  const subzoneId = form.subzoneId.value;
  const zone = zones.find(z => Number(z.zoneId) === Number(zoneId));
  const subzone = subzones.find(s => String(s.subzoneId) === String(subzoneId));
  const parentId = form.parentLocationId.value || "";
  const parent = parentId ? locationById(parentId) : null;

  const payload = {
    name: form.name.value.trim(),
    areaCode: form.areaCode.value.trim(),
    type: form.type.value,
    zoneId,
    zoneName: zone?.name || "",
    subzoneId,
    subzoneName: subzone?.name || "",
    parentLocationId: parentId || null,
    parentLocationName: parent?.name || "",
    description: form.description.value.trim(),
    active: true,
    order: Number(form.order.value || 1),
    updatedAt: serverTimestamp(),
  };

  await updateDoc(doc(db, "locations", loc.id), payload);

  const itemUpdates = new Map();
  const directItems = await getDocs(query(collection(db, "items"), where("locationId", "==", loc.locationId)));
  directItems.forEach(d => itemUpdates.set(d.id, {
    zoneId,
    zoneName: payload.zoneName,
    subzoneId,
    subzoneName: payload.subzoneName,
    locationName: payload.name,
    locationCode: payload.areaCode || "",
    locationType: payload.type,
    updatedAt: serverTimestamp(),
  }));

  const relatedItems = await getDocs(query(collection(db, "items"), where("relatedMachineId", "==", loc.locationId)));
  relatedItems.forEach(d => {
    itemUpdates.set(d.id, {
      ...(itemUpdates.get(d.id) || {}),
      relatedMachineName: payload.name,
      updatedAt: serverTimestamp(),
    });
  });

  await Promise.all([...itemUpdates.entries()].map(([id, data]) => updateDoc(doc(db, "items", id), data)));

  locations = locations.map(x => x.id === loc.id ? { ...x, ...payload } : x);
  items = items.map(x => {
    const upd = itemUpdates.get(x.id);
    return upd ? { ...x, ...upd } : x;
  });

  alert(`Área actualizada. Items sincronizados: ${itemUpdates.size}`);
  applyFilters();
}

async function deleteLocationSafely(loc, itemId) {
  if (!loc?.locationId) return;

  const [directItems, relatedItems, children] = await Promise.all([
    getDocs(query(collection(db, "items"), where("locationId", "==", loc.locationId))),
    getDocs(query(collection(db, "items"), where("relatedMachineId", "==", loc.locationId))),
    getDocs(query(collection(db, "locations"), where("parentLocationId", "==", loc.locationId))),
  ]);

  const directCount = directItems.size;
  const relatedCount = relatedItems.size;
  const childrenCount = children.size;

  if (directCount || relatedCount || childrenCount) {
    alert(
      `No se puede eliminar esta área porque aún tiene referencias.\n\n` +
      `Items ubicados aquí: ${directCount}\n` +
      `Items con esta máquina relacionada: ${relatedCount}\n` +
      `Sububicaciones hijas: ${childrenCount}\n\n` +
      `Primero reasigna o elimina esos elementos.`
    );
    return;
  }

  if (!confirm(`¿Eliminar definitivamente el área "${loc.name}"?\n\nEsta acción no se puede deshacer.`)) return;

  await deleteDoc(doc(db, "locations", loc.id));
  locations = locations.filter(x => x.id !== loc.id);
  alert("Área eliminada.");
  applyFilters();
}

async function deactivateItem(itemId) {
  const it = items.find(x => x.id === itemId);
  if (!it) return;
  if (!confirm(`¿Desactivar "${it.nombre}"?\n\nNo se elimina; solo dejará de aparecer como activo.`)) return;
  await updateDoc(doc(db, "items", itemId), { activo: false, updatedAt: serverTimestamp() });
  items = items.filter(x => x.id !== itemId);
  applyFilters();
}

async function deleteItem(itemId) {
  const it = items.find(x => x.id === itemId);
  if (!it) return;
  if (!confirm(`¿Eliminar definitivamente este item?\n\n${it.sku || ""} · ${it.nombre || ""}\n\nEsta acción no se puede deshacer.`)) return;
  await deleteDoc(doc(db, "items", itemId));
  items = items.filter(x => x.id !== itemId);
  applyFilters();
}

function addToCart(itemId) {
  const it = items.find(x => x.id === itemId);
  if (!it || it.prestamoHabilitado !== true) return alert("Este elemento no está habilitado para préstamo.");
  const qty = Number($(`#qty-${itemId}`)?.value || 1);
  if (qty <= 0) return;
  const data = cart();
  const existing = data.find(x => x.itemId === itemId);
  if (existing) existing.cantidad += qty;
  else data.push({ itemId, sku: it.sku, nombre: it.nombre, cantidad: qty, disponible: it.stockAlmacen || 0, locationName: it.locationName || "", locationCode: itemLocationCode(it) || "", relatedMachineName: it.relatedMachineName || "" });
  saveCart(data);
  alert("Agregado al carrito.");
}

function requestAssistance(itemId) {
  const it = items.find(x => x.id === itemId);
  if (!it) return;
  alert(`Solicitud de reserva/asistencia preparada para:\n\n${it.nombre}\n${it.zoneName || ""} / ${it.subzoneName || ""} / ${itemLocationCode(it) ? `${itemLocationCode(it)} · ` : ""}${it.locationName || ""}\n\nEl flujo formal se implementará después con reservationRequests.`);
}

function renderCartModal() {
  const body = $("#cartBody");
  if (!body) return;
  const data = cart();
  body.innerHTML = data.length ? data.map((x, i) => `
    <div class="d-flex justify-content-between align-items-center border-bottom py-2 gap-2">
      <div><strong>${esc(x.nombre)}</strong><br><span class="small text-muted">${esc(x.sku)}${x.locationName ? ` · ${x.locationCode ? `${esc(x.locationCode)} · ` : ""}${esc(x.locationName)}` : ""}</span></div>
      <input class="form-control form-control-sm cart-qty" data-i="${i}" type="number" min="1" value="${Number(x.cantidad || 1)}" style="width: 90px">
      <button class="btn btn-sm btn-outline-danger cart-remove" data-i="${i}">Quitar</button>
    </div>`).join("") : '<p class="text-muted">El carrito está vacío.</p>';
  document.querySelectorAll(".cart-qty").forEach(inp => inp.addEventListener("change", () => {
    const d = cart(); d[Number(inp.dataset.i)].cantidad = Number(inp.value || 1); saveCart(d); renderCartModal();
  }));
  document.querySelectorAll(".cart-remove").forEach(btn => btn.addEventListener("click", () => {
    const d = cart(); d.splice(Number(btn.dataset.i), 1); saveCart(d); renderCartModal();
  }));
}

async function submitLoanRequest() {
  const user = await waitForUser();
  if (!user) {
    alert("Debes iniciar sesión para solicitar material.");
    window.location.href = "login.html";
    return;
  }
  const profile = await getUserProfile(user.uid);
  const data = cart();
  if (!data.length) return alert("El carrito está vacío.");
  const comentariosAlumno = $("#loanComments")?.value || "";
  const request = {
    alumnoUid: user.uid,
    alumnoNombre: profile?.nombre || user.email,
    alumnoCorreo: profile?.correo || user.email,
    numeroCuenta: profile?.numeroCuenta || "",
    status: "pendiente",
    items: data.map(x => ({
      itemId: x.itemId,
      sku: x.sku,
      nombre: x.nombre,
      locationName: x.locationName || "",
      locationCode: x.locationCode || "",
      relatedMachineName: x.relatedMachineName || "",
      cantidadSolicitada: Number(x.cantidad),
      cantidadAprobada: 0,
      cantidadEntregada: 0,
      cantidadDevuelta: 0,
      cantidadLargoPlazo: 0,
    })),
    comentariosAlumno,
    comentariosTecnico: "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  const ref = await addDoc(collection(db, "loanRequests"), request);
  await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js").then(({ updateDoc, doc }) =>
    updateDoc(doc(db, "loanRequests", ref.id), { requestCode: `REQ-${ref.id.slice(0, 8).toUpperCase()}` })
  );
  saveCart([]);
  alert("Solicitud enviada.");
  window.location.href = "alumno.html";
}

function num(value) {
  return Number(value || 0);
}

function inventarioActualOperativo(it) {
  return num(it.stockAlmacen) + num(it.stockPrestadoTemporal);
}

function cantidadAComprar(it) {
  return Math.max(num(it.inventarioDeseado) - inventarioActualOperativo(it), 0);
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

function buildInventoryReportRows(rows) {
  return rows.map(it => ({
    zona: it.zoneName || "",
    subzona: it.subzoneName || "",
    area_codigo: itemLocationCode(it) || "",
    area: it.locationName || "",
    sku: it.sku || "",
    nombre: it.nombre || "",
    tipo: it.tipo || "",
    inventario_actual: inventarioActualOperativo(it),
    inventario_deseado: num(it.inventarioDeseado),
    cantidad_a_comprar: cantidadAComprar(it),
    precio_unitario: num(it.precioUnitario),
    moneda: it.moneda || "MXN",
    subtotal: cantidadAComprar(it) * num(it.precioUnitario),
    descripcion: it.descripcion || "",
    liga_compra: it.purchaseUrl || "",
  }));
}

function exportVisibleXlsx() {
  const rows = buildInventoryReportRows(filtered);

  if (!rows.length) {
    alert("No hay elementos para exportar con el filtro seleccionado.");
    return;
  }

  if (!window.XLSX) {
    alert("No se pudo cargar la librería XLSX. Revisa tu conexión a internet o la consola del navegador.");
    return;
  }

  const headers = [
    "Zona",
    "Subzona",
    "Código de área",
    "Área",
    "SKU",
    "Tipo",
    "Nombre",
    "Descripción",
    "Inventario actual",
    "Inventario deseado",
    "Cantidad a comprar",
    "Precio unitario",
    "Moneda",
    "Subtotal",
    "Liga de compra",
  ];

  const aoa = [
    headers,
    ...rows.map(row => [
      cleanXlsxText(row.zona),
      cleanXlsxText(row.subzona),
      cleanXlsxText(row.area_codigo),
      cleanXlsxText(row.area),
      cleanXlsxText(row.sku),
      cleanXlsxText(row.tipo),
      cleanXlsxText(row.nombre),
      cleanXlsxText(row.descripcion),
      cleanXlsxNumber(row.inventario_actual),
      cleanXlsxNumber(row.inventario_deseado),
      cleanXlsxNumber(row.cantidad_a_comprar),
      cleanXlsxNumber(row.precio_unitario),
      cleanXlsxText(row.moneda),
      cleanXlsxNumber(row.subtotal),
      cleanXlsxText(row.liga_compra),
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 16 },
    { wch: 24 },
    { wch: 16 },
    { wch: 30 },
    { wch: 12 },
    { wch: 16 },
    { wch: 36 },
    { wch: 36 },
    { wch: 8 },
    { wch: 8 },
    { wch: 8 },
    { wch: 8 },
    { wch: 8 },
    { wch: 12 },
    { wch: 40 },
  ];

  const numericColumns = ["I", "J", "K", "L", "N"];
  for (let r = 2; r <= rows.length + 1; r++) {
    for (const col of numericColumns) {
      const cell = ws[`${col}${r}`];
      if (cell) cell.t = "n";
    }
    if (ws[`L${r}`]) ws[`L${r}`].z = "#,##0.00";
    if (ws[`N${r}`]) ws[`N${r}`].z = "#,##0.00";
  }

  ws["!autofilter"] = { ref: `A1:O${rows.length + 1}` };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Inventario filtrado");
  const date = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `inventario_filtrado_fablab_${date}.xlsx`, { bookType: "xlsx", compression: true });
}

async function init() {
  await loadBase();
  fillSelects();
  filtered = [...items];
  renderItems();
  renderCartCount();

  ["#search", "#filterTipo", "#filterWeek", "#filterLocation"].forEach(sel => $(sel)?.addEventListener("input", applyFilters));
  $("#filterZone")?.addEventListener("input", () => { refreshDependentFilters(); applyFilters(); });
  $("#filterSubzone")?.addEventListener("input", () => { refreshDependentFilters(); applyFilters(); });
  $("#clearFilters")?.addEventListener("click", () => { document.querySelectorAll(".filter-input").forEach(x => x.value = ""); refreshDependentFilters(); applyFilters(); });
  $("#exportXlsx")?.addEventListener("click", exportVisibleXlsx);
  $("#openCart")?.addEventListener("click", renderCartModal);
  $("#submitLoan")?.addEventListener("click", submitLoanRequest);
}

init().catch(err => alert(`Error cargando catálogo: ${err.message}`));
