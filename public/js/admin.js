import { db } from "./firebase-app.js";
import { setupNav, requireRole, $, apiFetch, fileViewUrl } from "./common.js";
import {
  collection, doc, getDocs, setDoc, updateDoc, deleteDoc, serverTimestamp, query, where
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

setupNav();
let zones = [], subzones = [], weeks = [], locations = [];
let adminItemsCache = [];

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

const ITEM_TYPES = [
  "Máquina", "Herramienta", "Consumible", "Material", "Refacción", "Accesorio",
  "Equipo auxiliar", "Equipo de seguridad", "Mobiliario", "Kit", "Otro",
  // Compatibilidad con datos V1:
  "Maquina"
];

const ITEM_DEFAULTS = {
  "Máquina": { visibleParaAlumno: true, prestamoHabilitado: false, reservaHabilitada: true, requiereAsistencia: true },
  "Maquina": { visibleParaAlumno: true, prestamoHabilitado: false, reservaHabilitada: true, requiereAsistencia: true },
  "Herramienta": { visibleParaAlumno: true, prestamoHabilitado: true, reservaHabilitada: false, requiereAsistencia: false },
  "Consumible": { visibleParaAlumno: true, prestamoHabilitado: true, reservaHabilitada: false, requiereAsistencia: false },
  "Material": { visibleParaAlumno: true, prestamoHabilitado: true, reservaHabilitada: false, requiereAsistencia: false },
  "Refacción": { visibleParaAlumno: false, prestamoHabilitado: false, reservaHabilitada: false, requiereAsistencia: false },
  "Accesorio": { visibleParaAlumno: true, prestamoHabilitado: false, reservaHabilitada: false, requiereAsistencia: false },
  "Equipo auxiliar": { visibleParaAlumno: true, prestamoHabilitado: false, reservaHabilitada: false, requiereAsistencia: false },
  "Equipo de seguridad": { visibleParaAlumno: true, prestamoHabilitado: true, reservaHabilitada: false, requiereAsistencia: false },
  "Mobiliario": { visibleParaAlumno: false, prestamoHabilitado: false, reservaHabilitada: false, requiereAsistencia: false },
  "Kit": { visibleParaAlumno: true, prestamoHabilitado: true, reservaHabilitada: false, requiereAsistencia: false },
  "Otro": { visibleParaAlumno: true, prestamoHabilitado: false, reservaHabilitada: false, requiereAsistencia: false },
};

function defaultsForType(tipo) {
  return ITEM_DEFAULTS[tipo] || ITEM_DEFAULTS["Otro"];
}

function applyDefaultsForSelectedType(force = false) {
  const isEditing = Boolean($("#itemId")?.value);
  if (isEditing && !force) return;
  const d = defaultsForType($("#itemTipo")?.value || "Otro");
  $("#itemVisibleAlumno").checked = d.visibleParaAlumno;
  $("#itemPrestable").checked = d.prestamoHabilitado;
  $("#itemReservable").checked = d.reservaHabilitada;
  $("#itemAsistencia").checked = d.requiereAsistencia;
}

function boolBadge(value, label, onClass="text-bg-success", offClass="text-bg-secondary") {
  return `<span class="badge ${value ? onClass : offClass}">${label}: ${value ? "Sí" : "No"}</span>`;
}

function normalizeId(text) {
  return String(text || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function sortLocations(arr) {
  return [...arr].sort((a,b)=>
    String(a.subzoneId || "").localeCompare(String(b.subzoneId || ""), undefined, {numeric:true}) ||
    Number(a.order || 999) - Number(b.order || 999) ||
    String(a.name || "").localeCompare(String(b.name || ""), "es")
  );
}

function typeLabel(type) {
  return LOCATION_TYPES.find(x => x[0] === type)?.[1] || type || "";
}

function locationById(id) {
  return locations.find(l => String(l.locationId) === String(id) || String(l.id) === String(id));
}

function locationDisplayCode(l) {
  return l?.areaCode || l?.locationCode || l?.subzoneId || "";
}

function optionLocation(l) {
  const code = locationDisplayCode(l);
  return `<option value="${l.locationId}">${code ? `${code} · ` : ""}${l.name} (${typeLabel(l.type)})</option>`;
}

function filterSubzones(zoneId) {
  return subzones.filter(s => !zoneId || Number(s.zoneId) === Number(zoneId));
}

function filterLocations(zoneId, subzoneId) {
  return sortLocations(locations.filter(l =>
    (!zoneId || Number(l.zoneId) === Number(zoneId)) &&
    (!subzoneId || String(l.subzoneId) === String(subzoneId)) &&
    l.active !== false
  ));
}

function fillZoneSelects() {
  const zoneOptions = zones.map(x => `<option value="${x.zoneId}">${x.zoneId} · ${x.name}</option>`).join("");
  $("#itemZone").innerHTML = zoneOptions;
  $("#locationZone").innerHTML = zoneOptions;
}

function refreshSubzoneSelect(selectId, zoneId, selected="") {
  const opts = filterSubzones(zoneId).map(x => `<option value="${x.subzoneId}">${x.subzoneId} · ${x.name}</option>`).join("");
  $(selectId).innerHTML = opts;
  if (selected) $(selectId).value = selected;
}

function refreshLocationSelects() {
  const itemZone = $("#itemZone")?.value || "";
  const itemSubzone = $("#itemSubzone")?.value || "";
  const locs = filterLocations(itemZone, itemSubzone);
  $("#itemLocation").innerHTML = '<option value="">Sin ubicación específica</option>' + locs.map(optionLocation).join("");
  const machines = locs.filter(l => l.type === "machine");
  $("#itemRelatedMachine").innerHTML = '<option value="">Ninguna</option>' + machines.map(optionLocation).join("");

  const locZone = $("#locationZone")?.value || "";
  const locSubzone = $("#locationSubzone")?.value || "";
  const parentLocs = filterLocations(locZone, locSubzone).filter(l => l.locationId !== $("#locationId").value);
  $("#locationParent").innerHTML = '<option value="">Sin ubicación padre</option>' + parentLocs.map(optionLocation).join("");
}

function fillReportFilterSelects() {
  const zone = $("#reportZone");
  const subzone = $("#reportSubzone");
  const location = $("#reportLocation");

  if (zone) {
    const current = zone.value || "";
    zone.innerHTML = '<option value="">Todas las zonas</option>' +
      zones.map(z => `<option value="${z.zoneId}">${z.zoneId} · ${z.name}</option>`).join("");
    if ([...zone.options].some(o => o.value === current)) zone.value = current;
  }

  refreshReportFilterOptions();
}

function refreshReportFilterOptions() {
  const zoneId = $("#reportZone")?.value || "";
  const subzoneId = $("#reportSubzone")?.value || "";
  const subzone = $("#reportSubzone");
  const location = $("#reportLocation");

  if (subzone) {
    const current = subzone.value || "";
    subzone.innerHTML = '<option value="">Todas las subzonas</option>' +
      subzones
        .filter(s => !zoneId || Number(s.zoneId) === Number(zoneId))
        .map(s => `<option value="${s.subzoneId}">${s.subzoneId} · ${s.name}</option>`)
        .join("");
    if ([...subzone.options].some(o => o.value === current)) {
      subzone.value = current;
    }
  }

  const effectiveSubzoneId = $("#reportSubzone")?.value || "";
  if (location) {
    const current = location.value || "";
    const locs = filterLocations(zoneId, effectiveSubzoneId);
    location.innerHTML = '<option value="">Todas las áreas</option>' + locs.map(optionLocation).join("");
    if ([...location.options].some(o => o.value === current)) {
      location.value = current;
    }
  }

  updatePurchaseReportSummary(adminItemsCache);
}

function getReportFilters() {
  return {
    zoneId: $("#reportZone")?.value || "",
    subzoneId: $("#reportSubzone")?.value || "",
    locationId: $("#reportLocation")?.value || "",
  };
}

function applyReportFilters(rows) {
  const { zoneId, subzoneId, locationId } = getReportFilters();

  return rows.filter(it => {
    if (zoneId && String(it.zoneId) !== String(zoneId)) return false;
    if (subzoneId && String(it.subzoneId) !== String(subzoneId)) return false;
    if (locationId && String(it.locationId || "") !== String(locationId)) return false;
    return true;
  });
}

function clearReportFilters() {
  if ($("#reportZone")) $("#reportZone").value = "";
  if ($("#reportSubzone")) $("#reportSubzone").value = "";
  if ($("#reportLocation")) $("#reportLocation").value = "";
  refreshReportFilterOptions();
}


async function loadBase() {
  const [z, s, w, l] = await Promise.all([
    getDocs(collection(db, "zones")),
    getDocs(collection(db, "subzones")),
    getDocs(collection(db, "fabacademyWeeks")),
    getDocs(query(collection(db, "locations"), where("active", "==", true))),
  ]);
  zones = z.docs.map(d => ({id: d.id, ...d.data()})).sort((a,b)=>a.zoneId-b.zoneId);
  subzones = s.docs.map(d => ({id: d.id, ...d.data()})).sort((a,b)=>String(a.subzoneId).localeCompare(String(b.subzoneId), undefined, {numeric:true}));
  weeks = w.docs.map(d => ({id: d.id, ...d.data()})).sort((a,b)=>a.weekId-b.weekId);
  locations = sortLocations(l.docs.map(d => ({id: d.id, ...d.data()})));

  fillZoneSelects();
  $("#itemTipo").innerHTML = ITEM_TYPES.map(x => `<option>${x}</option>`).join("");
  applyDefaultsForSelectedType(true);
  $("#locationType").innerHTML = LOCATION_TYPES.map(([v,t]) => `<option value="${v}">${t}</option>`).join("");
  $("#itemWeeks").innerHTML = weeks.map(x => `<option value="${x.weekId}">${x.weekId} · ${x.name}</option>`).join("");
  refreshSubzoneSelect("#itemSubzone", $("#itemZone").value);
  refreshSubzoneSelect("#locationSubzone", $("#locationZone").value);
  refreshLocationSelects();
}

async function uploadFile(inputId, fileType, itemId) {
  const input = $(inputId);
  if (!input?.files?.length) return "";
  const form = new FormData();
  form.append("file", input.files[0]);
  form.append("fileType", fileType);
  form.append("itemId", itemId);
  const res = await apiFetch("/api/files/upload", { method: "POST", body: form });
  const data = await res.json();
  return data.fileId;
}

function selectedOptions(selectId) {
  return [...$(selectId).selectedOptions].map(o => Number(o.value));
}

function namesForWeeks(ids) {
  return ids.map(id => weeks.find(w => Number(w.weekId) === Number(id))?.name || String(id));
}

async function saveLocation(e) {
  e.preventDefault();
  const zoneId = Number($("#locationZone").value);
  const subzoneId = $("#locationSubzone").value;
  const name = $("#locationName").value.trim();
  if (!name) return alert("Escribe el nombre de la ubicación.");

  const editingId = $("#locationEditingId").value;
  let locationId = $("#locationId").value.trim();
  if (!locationId) locationId = `${subzoneId}-${normalizeId(name)}`;
  const zone = zones.find(z => Number(z.zoneId) === zoneId);
  const subzone = subzones.find(s => String(s.subzoneId) === String(subzoneId));
  const parentId = $("#locationParent").value || "";
  const parent = parentId ? locationById(parentId) : null;

  const data = {
    locationId,
    areaCode: $("#locationAreaCode")?.value?.trim() || "",
    name,
    type: $("#locationType").value,
    zoneId,
    zoneName: zone?.name || "",
    subzoneId,
    subzoneName: subzone?.name || "",
    parentLocationId: parentId || null,
    parentLocationName: parent?.name || "",
    description: $("#locationDescription").value.trim(),
    active: true,
    order: Number($("#locationOrder").value || 1),
    updatedAt: serverTimestamp(),
  };
  if (!editingId) data.createdAt = serverTimestamp();
  const docId = editingId || locationId;
  await setDoc(doc(db, "locations", docId), data, { merge: true });
  alert("Ubicación guardada.");
  clearLocationForm();
  await reloadLocationsAndRender();
}

function clearLocationForm() {
  $("#locationForm").reset();
  $("#locationEditingId").value = "";
  $("#locationId").disabled = false;
  refreshSubzoneSelect("#locationSubzone", $("#locationZone").value);
  refreshLocationSelects();
}

async function reloadLocationsAndRender() {
  const l = await getDocs(query(collection(db, "locations"), where("active", "==", true)));
  locations = sortLocations(l.docs.map(d => ({id: d.id, ...d.data()})));
  refreshLocationSelects();
  await renderLocations();
  await renderItems();
}

async function renderLocations() {
  const rows = sortLocations(locations);
  $("#locationCount").textContent = `${rows.length} ubicación(es)`;
  $("#adminLocations").innerHTML = rows.map(l => `
    <tr>
      <td><code>${l.locationId || l.id}</code></td>
      <td>${l.areaCode ? `<span class="badge text-bg-light border me-1">${l.areaCode}</span>` : ""}${l.name || ""}</td>
      <td>${typeLabel(l.type)}</td>
      <td><span class="small">${l.zoneName || ""} / ${l.subzoneName || ""}</span></td>
      <td><span class="small text-muted">${l.parentLocationName || l.parentLocationId || ""}</span></td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-outline-primary edit-location" data-id="${l.id}">Editar</button>
        <button class="btn btn-sm btn-outline-warning deactivate-location" data-id="${l.id}">Desactivar</button>
        <button class="btn btn-sm btn-outline-danger delete-location" data-id="${l.id}">Eliminar</button>
      </td>
    </tr>`).join("");
  document.querySelectorAll(".edit-location").forEach(btn => btn.addEventListener("click", () => {
    const data = rows.find(x => x.id === btn.dataset.id);
    fillLocationForm(data);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }));
  document.querySelectorAll(".deactivate-location").forEach(btn => btn.addEventListener("click", async () => {
    if (!confirm("¿Desactivar esta ubicación? Los items existentes conservarán su referencia, pero ya no aparecerá para nuevas capturas.")) return;
    await updateDoc(doc(db, "locations", btn.dataset.id), { active: false, updatedAt: serverTimestamp() });
    await reloadLocationsAndRender();
  }));

  document.querySelectorAll(".delete-location").forEach(btn => btn.addEventListener("click", async () => {
    await deleteLocationFromAdmin(btn.dataset.id);
  }));
}

async function deleteLocationFromAdmin(locationDocId) {
  const location = locations.find(l => String(l.id) === String(locationDocId));
  if (!location) return alert("No se encontró la ubicación.");

  const locationId = location.locationId || location.id;
  const itemsSnap = await getDocs(collection(db, "items"));
  const linkedItems = itemsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(it => String(it.locationId || "") === String(locationId) || String(it.relatedMachineId || "") === String(locationId));

  const locationsSnap = await getDocs(collection(db, "locations"));
  const childLocations = locationsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(l => String(l.parentLocationId || "") === String(locationId));

  if (linkedItems.length || childLocations.length) {
    alert(
      `No se puede eliminar esta área porque todavía tiene referencias.\n\n` +
      `Items asociados o relacionados: ${linkedItems.length}\n` +
      `Sububicaciones hijas: ${childLocations.length}\n\n` +
      `Primero reasigna, elimina o desactiva esos elementos.`
    );
    return;
  }

  if (!confirm(`¿Eliminar definitivamente el área "${location.areaCode ? location.areaCode + " · " : ""}${location.name || locationId}"?\n\nEsta acción no se puede deshacer.`)) return;

  await deleteDoc(doc(db, "locations", locationDocId));
  await reloadLocationsAndRender();
}

function fillLocationForm(l) {
  $("#locationEditingId").value = l.id;
  $("#locationId").value = l.locationId || l.id;
  $("#locationId").disabled = true;
  if ($("#locationAreaCode")) $("#locationAreaCode").value = l.areaCode || l.locationCode || "";
  $("#locationZone").value = l.zoneId || "";
  refreshSubzoneSelect("#locationSubzone", $("#locationZone").value, l.subzoneId || "");
  $("#locationName").value = l.name || "";
  $("#locationType").value = l.type || "general";
  $("#locationOrder").value = l.order || 1;
  $("#locationDescription").value = l.description || "";
  refreshLocationSelects();
  $("#locationParent").value = l.parentLocationId || "";
}

async function saveItem(e) {
  e.preventDefault();
  const itemId = $("#itemId").value || doc(collection(db, "items")).id;
  const zoneId = Number($("#itemZone").value);
  const subzoneId = $("#itemSubzone").value;
  const locationId = $("#itemLocation").value || "";
  const relatedMachineId = $("#itemRelatedMachine").value || "";
  const location = locationId ? locationById(locationId) : null;
  const relatedMachine = relatedMachineId ? locationById(relatedMachineId) : null;
  const fabIds = selectedOptions("#itemWeeks");

  const [imageFileId, pdfFileId, datasheetFileId] = await Promise.all([
    uploadFile("#itemImage", "image", itemId),
    uploadFile("#itemPdf", "pdf", itemId),
    uploadFile("#itemDatasheet", "datasheet", itemId),
  ]);

  const zone = zones.find(z => Number(z.zoneId) === zoneId);
  const subzone = subzones.find(s => String(s.subzoneId) === String(subzoneId));
  const base = {
    sku: $("#itemSku").value.trim(),
    nombre: $("#itemNombre").value.trim(),
    descripcion: $("#itemDescripcion").value.trim(),
    tipo: $("#itemTipo").value,
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
    infoUrl: $("#itemInfoUrl").value.trim(),
    purchaseUrl: $("#itemPurchaseUrl").value.trim(),
    stockAlmacen: Number($("#itemStock").value || 0),
    stockPrestadoTemporal: Number($("#itemPrestado").value || 0),
    stockLargoPlazo: Number($("#itemLargo").value || 0),
    stockDanado: Number($("#itemDanado").value || 0),
    stockPerdido: Number($("#itemPerdido").value || 0),
    inventarioDeseado: Number($("#itemDeseado").value || 0),
    precioUnitario: Number($("#itemPrecioUnitario")?.value || 0),
    moneda: $("#itemMoneda")?.value || "MXN",
    visibleParaAlumno: $("#itemVisibleAlumno").checked,
    prestamoHabilitado: $("#itemPrestable").checked,
    reservaHabilitada: $("#itemReservable").checked,
    requiereAsistencia: $("#itemAsistencia").checked,
    activo: true,
    updatedAt: serverTimestamp(),
  };
  if (!$("#itemId").value) base.createdAt = serverTimestamp();
  if (imageFileId) base.imageFileId = imageFileId;
  if (pdfFileId) base.pdfFileId = pdfFileId;
  if (datasheetFileId) base.datasheetFileId = datasheetFileId;

  await setDoc(doc(db, "items", itemId), base, { merge: true });
  alert("Elemento guardado.");
  clearItemForm();
  await renderItems();
}

function clearItemForm() {
  $("#itemForm").reset();
  $("#itemId").value = "";
  refreshSubzoneSelect("#itemSubzone", $("#itemZone").value);
  refreshLocationSelects();
  applyDefaultsForSelectedType(true);
}

async function renderItems() {
  const snap = await getDocs(query(collection(db, "items"), where("activo", "==", true)));
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b)=>String(a.sku||"").localeCompare(String(b.sku||"")));
  adminItemsCache = rows;
  updatePurchaseReportSummary(rows);
  $("#itemCount").textContent = `${rows.length} elemento(s)`;
  $("#adminItems").innerHTML = rows.map(it => `
    <tr>
      <td><img src="${fileViewUrl(it.imageFileId)}" class="thumb"></td>
      <td>${it.sku || ""}</td>
      <td>${it.nombre || ""}</td>
      <td>${it.tipo || ""}</td>
      <td><span class="small">${it.zoneName || ""}<br>${it.subzoneName || ""}<br><strong>${it.locationCode ? `${it.locationCode} · ` : ""}${it.locationName || "Sin ubicación"}</strong>${it.relatedMachineName ? `<br><span class="text-muted">Rel.: ${it.relatedMachineName}</span>` : ""}</span></td>
      <td><div class="d-flex flex-column gap-1 align-items-start">${boolBadge(it.visibleParaAlumno !== false, "Alumno")}${boolBadge(it.prestamoHabilitado === true, "Préstamo", "text-bg-primary")}${boolBadge(it.reservaHabilitada === true, "Reserva", "text-bg-warning", "text-bg-secondary")}</div></td>
      <td>${it.stockAlmacen || 0}</td>
      <td>${it.inventarioDeseado || 0}</td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-outline-primary edit-item" data-id="${it.id}">Editar</button>
        <button class="btn btn-sm btn-outline-warning deactivate-item" data-id="${it.id}">Desactivar</button>
        <button class="btn btn-sm btn-outline-danger delete-item" data-id="${it.id}">Eliminar</button>
      </td>
    </tr>`).join("");
  document.querySelectorAll(".deactivate-item").forEach(btn => btn.addEventListener("click", async () => {
    if (!confirm("¿Desactivar este elemento?")) return;
    await updateDoc(doc(db, "items", btn.dataset.id), { activo: false, updatedAt: serverTimestamp() });
    await renderItems();
  }));

  document.querySelectorAll(".delete-item").forEach(btn => btn.addEventListener("click", async () => {
    await deleteItemFromAdmin(btn.dataset.id);
  }));

  document.querySelectorAll(".edit-item").forEach(btn => btn.addEventListener("click", async () => {
    const data = rows.find(x => x.id === btn.dataset.id);
    fillItemForm(data);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }));
}

async function deleteItemFromAdmin(itemId) {
  const item = adminItemsCache.find(x => String(x.id) === String(itemId));
  const label = item ? `${item.sku || item.id} · ${item.nombre || ""}` : itemId;

  if (!confirm(`¿Eliminar definitivamente el item "${label}"?\n\nEsta acción no se puede deshacer.`)) return;

  await deleteDoc(doc(db, "items", itemId));
  await renderItems();
}

function fillItemForm(it) {
  $("#itemId").value = it.id;
  $("#itemSku").value = it.sku || "";
  $("#itemNombre").value = it.nombre || "";
  $("#itemDescripcion").value = it.descripcion || "";
  $("#itemTipo").value = it.tipo || "Herramienta";
  $("#itemZone").value = it.zoneId || "";
  refreshSubzoneSelect("#itemSubzone", $("#itemZone").value, it.subzoneId || "");
  refreshLocationSelects();
  $("#itemLocation").value = it.locationId || "";
  $("#itemRelatedMachine").value = it.relatedMachineId || "";
  [...$("#itemWeeks").options].forEach(o => o.selected = (it.fabacademyWeeks || []).map(String).includes(o.value));
  $("#itemInfoUrl").value = it.infoUrl || "";
  $("#itemPurchaseUrl").value = it.purchaseUrl || "";
  $("#itemStock").value = it.stockAlmacen || 0;
  $("#itemPrestado").value = it.stockPrestadoTemporal || 0;
  $("#itemLargo").value = it.stockLargoPlazo || 0;
  $("#itemDanado").value = it.stockDanado || 0;
  $("#itemPerdido").value = it.stockPerdido || 0;
  $("#itemDeseado").value = it.inventarioDeseado || 0;
  if ($("#itemPrecioUnitario")) $("#itemPrecioUnitario").value = it.precioUnitario ?? it.precio ?? 0;
  if ($("#itemMoneda")) $("#itemMoneda").value = it.moneda || "MXN";
  const defaults = defaultsForType(it.tipo || "Otro");
  $("#itemVisibleAlumno").checked = it.visibleParaAlumno ?? defaults.visibleParaAlumno;
  $("#itemPrestable").checked = it.prestamoHabilitado ?? defaults.prestamoHabilitado;
  $("#itemReservable").checked = it.reservaHabilitada ?? defaults.reservaHabilitada;
  $("#itemAsistencia").checked = it.requiereAsistencia ?? defaults.requiereAsistencia;
}


function num(value) {
  return Number(value || 0);
}

function inventarioActualOperativo(it) {
  // Inventario actual operativo: lo que está en almacén + lo prestado temporalmente.
  // No incluye largo plazo porque ya no se considera disponible para resurtido operativo.
  return num(it.stockAlmacen) + num(it.stockPrestadoTemporal);
}

function cantidadAComprar(it) {
  return Math.max(num(it.inventarioDeseado) - inventarioActualOperativo(it), 0);
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function formatMoney(value) {
  return Number(value || 0).toFixed(2);
}

function buildPurchaseReportRows(rows, onlyShortage = true) {
  const reportRows = rows.map(it => {
    const cantidad = cantidadAComprar(it);
    const precio = num(it.precioUnitario);
    const subtotal = cantidad * precio;
    const location = locationById(it.locationId || "");

    return {
      zona: it.zoneName || "",
      subzona: it.subzoneName || "",
      area_codigo: it.locationCode || locationDisplayCode(location),
      area: it.locationName || "",
      sku: it.sku || "",
      nombre: it.nombre || "",
      tipo: it.tipo || "",
      inventario_actual: inventarioActualOperativo(it),
      inventario_deseado: num(it.inventarioDeseado),
      cantidad_a_comprar: cantidad,
      precio_unitario: precio,
      moneda: it.moneda || "MXN",
      subtotal: subtotal,
      descripcion: it.descripcion || "",
      liga_compra: it.purchaseUrl || "",
    };
  });

  return onlyShortage
    ? reportRows.filter(row => row.cantidad_a_comprar > 0)
    : reportRows;
}

function updatePurchaseReportSummary(rows) {
  const el = $("#purchaseReportSummary");
  if (!el) return;

  const filteredItems = applyReportFilters(rows);
  const purchaseRows = buildPurchaseReportRows(filteredItems, true);

  const totalsByCurrency = purchaseRows.reduce((acc, row) => {
    const currency = row.moneda || "MXN";
    acc[currency] = (acc[currency] || 0) + Number(row.subtotal || 0);
    return acc;
  }, {});

  const totalsText = Object.entries(totalsByCurrency)
    .map(([currency, total]) => `${currency} ${formatMoney(total)}`)
    .join(" · ");

  el.textContent = purchaseRows.length
    ? `${filteredItems.length} elemento(s) en el filtro. ${purchaseRows.length} requieren compra. Total estimado: ${totalsText}`
    : `${filteredItems.length} elemento(s) en el filtro. No hay elementos con faltante para compra.`;
}


function cleanXlsxText(value) {
  if (value === null || value === undefined) return "";

  return String(value)
    .normalize("NFC")
    // Caracteres de control inválidos en XML 1.0, excepto tab, salto de línea y retorno.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    // Evita pares sustitutos sueltos que pueden romper el XML interno del XLSX.
    .replace(/[\uD800-\uDFFF]/g, "")
    .trim();
}

function cleanXlsxNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function exportReportXlsx({ onlyShortage, sheetName, filePrefix }) {
  const filteredItems = applyReportFilters(adminItemsCache);
  const rows = buildPurchaseReportRows(filteredItems, onlyShortage);

  if (!rows.length) {
    alert(onlyShortage
      ? "No hay elementos con faltante para compra en el filtro seleccionado."
      : "No hay elementos para exportar con el filtro seleccionado."
    );
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
    { wch: 16 }, // A · Zona
    { wch: 24 }, // B · Subzona
    { wch: 16 }, // C · Código de área
    { wch: 30 }, // D · Área
    { wch: 12 }, // E · SKU
    { wch: 16 }, // F · Tipo
    { wch: 36 }, // G · Nombre
    { wch: 36 }, // H · Descripción
    { wch: 8 }, // I · Inventario actual
    { wch: 8 }, // J · Inventario deseado
    { wch: 8 }, // K · Cantidad a comprar
    { wch: 8 }, // L · Precio unitario
    { wch: 8 }, // M · Moneda
    { wch: 12 }, // N · Subtotal
    { wch: 40 }, // O · Liga de compra
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
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const date = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `${filePrefix}_${date}.xlsx`, { bookType: "xlsx", compression: true });
}

function exportPurchaseReportXlsx() {
  exportReportXlsx({
    onlyShortage: true,
    sheetName: "Reporte de compra",
    filePrefix: "reporte_compra_fablab",
  });
}

function exportInventoryReportXlsx() {
  exportReportXlsx({
    onlyShortage: false,
    sheetName: "Inventario filtrado",
    filePrefix: "inventario_filtrado_fablab",
  });
}


async function createTechnician(e) {
  e.preventDefault();
  const body = {
    nombre: $("#tecNombre").value.trim(),
    correo: $("#tecCorreo").value.trim(),
    password: $("#tecPassword").value,
  };
  const res = await apiFetch("/api/users/technicians", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await res.json();
  alert("Técnico creado.");
  $("#technicianForm").reset();
}

async function importCsv(e) {
  e.preventDefault();
  const form = new FormData();
  if (!$("#csvFile").files.length) return alert("Selecciona un CSV.");
  form.append("csv_file", $("#csvFile").files[0]);
  if ($("#assetsZip").files.length) form.append("assets_zip", $("#assetsZip").files[0]);
  const res = await apiFetch("/api/import/inventory-csv", { method: "POST", body: form });
  const data = await res.json();
  $("#importResult").textContent = JSON.stringify(data, null, 2);
  await renderItems();
}

async function init() {
  await requireRole(["admin"]);
  await loadBase();
  fillReportFilterSelects();
  await renderLocations();
  await renderItems();

  $("#itemZone").addEventListener("change", () => { refreshSubzoneSelect("#itemSubzone", $("#itemZone").value); refreshLocationSelects(); });
  $("#itemSubzone").addEventListener("change", refreshLocationSelects);
  $("#itemTipo").addEventListener("change", () => applyDefaultsForSelectedType(false));
  $("#locationZone").addEventListener("change", () => { refreshSubzoneSelect("#locationSubzone", $("#locationZone").value); refreshLocationSelects(); });
  $("#locationSubzone").addEventListener("change", refreshLocationSelects);

  $("#locationForm").addEventListener("submit", saveLocation);
  $("#clearLocationForm").addEventListener("click", clearLocationForm);
  $("#itemForm").addEventListener("submit", saveItem);
  $("#clearItemForm").addEventListener("click", clearItemForm);
  $("#technicianForm").addEventListener("submit", createTechnician);
  $("#importForm").addEventListener("submit", importCsv);
  $("#reportZone")?.addEventListener("change", () => {
    if ($("#reportSubzone")) $("#reportSubzone").value = "";
    if ($("#reportLocation")) $("#reportLocation").value = "";
    refreshReportFilterOptions();
  });
  $("#reportSubzone")?.addEventListener("change", () => {
    if ($("#reportLocation")) $("#reportLocation").value = "";
    refreshReportFilterOptions();
  });
  $("#reportLocation")?.addEventListener("change", () => updatePurchaseReportSummary(adminItemsCache));
  $("#clearReportFilters")?.addEventListener("click", clearReportFilters);
  $("#exportPurchaseReport")?.addEventListener("click", exportPurchaseReportXlsx);
  $("#exportInventoryReport")?.addEventListener("click", exportInventoryReportXlsx);
}

init().catch(err => alert(err.message));
