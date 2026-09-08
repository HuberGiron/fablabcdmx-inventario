import { db } from "./firebase-app.js";
import { setupNav, requireRole, $, apiFetch, fileViewUrl } from "./common.js";
import {
  collection, doc, getDocs, setDoc, updateDoc, deleteDoc, serverTimestamp, query, where
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

setupNav();

let zones = [];
let subzones = [];
let weeks = [];
let locations = [];
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
  "Máquina",
  "Mobiliario",
  "Cómputo",
  "Herramienta",
  "Consumible",
  "Material",
  "Refacción",
  "Accesorio",
  "Equipo auxiliar",
  "Equipo de seguridad",
  "Kit",
  "Otro",
];

const ITEM_DEFAULTS = {
  "Máquina": { visibleParaAlumno: true, prestamoHabilitado: false, reservaHabilitada: true, requiereAsistencia: true },
  "Herramienta": { visibleParaAlumno: true, prestamoHabilitado: true, reservaHabilitada: false, requiereAsistencia: false },
  "Consumible": { visibleParaAlumno: true, prestamoHabilitado: true, reservaHabilitada: false, requiereAsistencia: false },
  "Cómputo": { visibleParaAlumno: true, prestamoHabilitado: false, reservaHabilitada: true, requiereAsistencia: false },
  "Material": { visibleParaAlumno: true, prestamoHabilitado: true, reservaHabilitada: false, requiereAsistencia: false },
  "Refacción": { visibleParaAlumno: false, prestamoHabilitado: false, reservaHabilitada: false, requiereAsistencia: false },
  "Accesorio": { visibleParaAlumno: true, prestamoHabilitado: false, reservaHabilitada: false, requiereAsistencia: false },
  "Equipo auxiliar": { visibleParaAlumno: true, prestamoHabilitado: false, reservaHabilitada: false, requiereAsistencia: false },
  "Equipo de seguridad": { visibleParaAlumno: true, prestamoHabilitado: true, reservaHabilitada: false, requiereAsistencia: false },
  "Mobiliario": { visibleParaAlumno: false, prestamoHabilitado: false, reservaHabilitada: false, requiereAsistencia: false },
  "Kit": { visibleParaAlumno: true, prestamoHabilitado: true, reservaHabilitada: false, requiereAsistencia: false },
  "Otro": { visibleParaAlumno: true, prestamoHabilitado: false, reservaHabilitada: false, requiereAsistencia: false },
};

const zoneModal = () => bootstrap.Modal.getOrCreateInstance(document.getElementById("zoneModal"));
const subzoneModal = () => bootstrap.Modal.getOrCreateInstance(document.getElementById("subzoneModal"));
const locationModal = () => bootstrap.Modal.getOrCreateInstance(document.getElementById("locationModal"));
const itemModal = () => bootstrap.Modal.getOrCreateInstance(document.getElementById("itemModal"));

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeForCompare(value) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeTipo(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Otro";
  const comparable = normalizeForCompare(raw);
  if (comparable === "maquina") return "Máquina";
  return ITEM_TYPES.find(t => normalizeForCompare(t) === comparable) || raw;
}

function defaultsForType(tipo) {
  return ITEM_DEFAULTS[normalizeTipo(tipo)] || ITEM_DEFAULTS["Otro"];
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

function normalizeId(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function displayMeta(rawCode, rawName) {
  const code = String(rawCode ?? "").trim();
  const name = String(rawName ?? "").trim();
  const match = name.match(/^(\d+(?:\.\d+)*)(?:\.)?\s+(.+)$/);
  if (match) {
    return {
      code: match[1],
      name: match[2].trim(),
      aliased: match[1] !== code,
    };
  }
  return { code, name, aliased: false };
}

function zoneDisplay(z) {
  return displayMeta(z?.zoneId, z?.name);
}

function subzoneDisplay(s) {
  return displayMeta(s?.subzoneId, s?.name);
}

function subzoneDisplayById(subzoneId, fallbackName = "") {
  const live = subzones.find(s => String(s.subzoneId) === String(subzoneId));
  return subzoneDisplay(live || { subzoneId, name: fallbackName });
}

function locationDisplay(l) {
  if (!l) return { code: "", name: "", aliased: false };
  const rawCode = String(l.areaCode || l.locationCode || l.subzoneId || "").trim();
  const parsed = displayMeta(rawCode, l.name || "");
  if (parsed.aliased) return parsed;

  const sd = subzoneDisplayById(l.subzoneId, l.subzoneName || "");
  const rawSubzoneId = String(l.subzoneId || "");

  if (sd.code && rawSubzoneId && sd.code !== rawSubzoneId) {
    if (rawCode.startsWith(`${rawSubzoneId}.`)) {
      return {
        code: `${sd.code}${rawCode.slice(rawSubzoneId.length)}`,
        name: parsed.name || l.name || "",
        aliased: true,
      };
    }
    if (l.type === "general") {
      return {
        code: `${sd.code}.0`,
        name: parsed.name || l.name || "",
        aliased: true,
      };
    }
  }
  return parsed;
}

function technicalBadge(technical, display) {
  if (!technical || String(technical) === String(display)) return "";
  return `<span class="badge-technical">ID ${esc(technical)}</span>`;
}

function inactiveBadge(active) {
  return active === false ? '<span class="badge-inactive">Inactiva</span>' : "";
}

function adminZoneOptionLabel(z) {
  const d = zoneDisplay(z);
  const technical = String(z?.zoneId ?? "");
  const suffix = technical && technical !== d.code ? ` [ID técnico ${technical}]` : "";
  return `${d.code} · ${d.name}${suffix}`;
}

function adminSubzoneOptionLabel(s) {
  const d = subzoneDisplay(s);
  const technical = String(s?.subzoneId ?? "");
  const suffix = technical && technical !== d.code ? ` [ID técnico ${technical}]` : "";
  return `${d.code} · ${d.name}${suffix}`;
}

function typeLabel(type) {
  return LOCATION_TYPES.find(x => x[0] === type)?.[1] || type || "";
}

function adminLocationOptionLabel(l, includeType = true) {
  const d = locationDisplay(l);
  const rawCode = String(l?.areaCode || l?.locationCode || l?.subzoneId || "").trim();
  const typeText = includeType ? ` (${typeLabel(l?.type)})` : "";
  const suffix = rawCode && rawCode !== d.code ? ` [código técnico ${rawCode}]` : "";
  return `${d.code ? `${d.code} · ` : ""}${d.name || "Sin nombre"}${suffix}${typeText}`;
}

function sortZones(arr) {
  return [...arr].sort((a, b) => {
    const da = zoneDisplay(a), db = zoneDisplay(b);
    return Number(da.code || 999) - Number(db.code || 999) ||
      Number(a.zoneId || 999) - Number(b.zoneId || 999);
  });
}

function sortSubzones(arr) {
  return [...arr].sort((a, b) => {
    const da = subzoneDisplay(a), db = subzoneDisplay(b);
    return String(da.code).localeCompare(String(db.code), "es", { numeric: true }) ||
      String(a.subzoneId || "").localeCompare(String(b.subzoneId || ""), "es", { numeric: true });
  });
}

function sortLocations(arr) {
  return [...arr].sort((a, b) => {
    const da = locationDisplay(a), db = locationDisplay(b);
    return String(da.code || "").localeCompare(String(db.code || ""), "es", { numeric: true }) ||
      Number(a.order || 999) - Number(b.order || 999) ||
      String(da.name || "").localeCompare(String(db.name || ""), "es");
  });
}

function locationById(id) {
  return locations.find(l => String(l.locationId) === String(id) || String(l.id) === String(id));
}

function locationDisplayCode(l) {
  return l?.areaCode || l?.locationCode || l?.subzoneId || "";
}

function optionLocation(l) {
  return `<option value="${esc(l.locationId)}">${esc(adminLocationOptionLabel(l, true))}</option>`;
}

function filterSubzones(zoneId, activeOnly = false) {
  return sortSubzones(subzones.filter(s =>
    (!zoneId || Number(s.zoneId) === Number(zoneId)) &&
    (!activeOnly || s.active !== false)
  ));
}

function filterLocations(zoneId, subzoneId, activeOnly = true) {
  return sortLocations(locations.filter(l =>
    (!zoneId || Number(l.zoneId) === Number(zoneId)) &&
    (!subzoneId || String(l.subzoneId) === String(subzoneId)) &&
    (!activeOnly || l.active !== false)
  ));
}

function selectedOptions(selectId) {
  return [...$(selectId).selectedOptions].map(o => Number(o.value));
}

function namesForWeeks(ids) {
  return ids.map(id => weeks.find(w => Number(w.weekId) === Number(id))?.name || String(id));
}

function normalizeSku(value) {
  return String(value || "").trim().toUpperCase();
}

function currentItemMatchesText(it, search) {
  if (!search) return true;
  const loc = locationById(it.locationId);
  const zd = zoneDisplay(zones.find(z => Number(z.zoneId) === Number(it.zoneId)) || { zoneId: it.zoneId, name: it.zoneName });
  const sd = subzoneDisplay(subzones.find(s => String(s.subzoneId) === String(it.subzoneId)) || { subzoneId: it.subzoneId, name: it.subzoneName });
  const ld = locationDisplay(loc || { areaCode: it.locationCode, name: it.locationName, subzoneId: it.subzoneId, subzoneName: it.subzoneName });
  const haystack = [
    it.sku, it.nombre, it.descripcion, normalizeTipo(it.tipo),
    it.zoneId, it.zoneName, zd.code, zd.name,
    it.subzoneId, it.subzoneName, sd.code, sd.name,
    it.locationId, it.locationCode, it.locationName, ld.code, ld.name,
    it.relatedMachineName
  ].filter(Boolean).join(" ");
  return normalizeForCompare(haystack).includes(search);
}

function updateStats() {
  $("#statZones").textContent = zones.filter(z => z.active !== false).length;
  $("#statSubzones").textContent = subzones.filter(s => s.active !== false).length;
  $("#statLocations").textContent = locations.filter(l => l.active !== false).length;
  $("#statItems").textContent = adminItemsCache.length;
}

function fillZoneSelect(selectId, includeEmpty = false, activeOnly = false, selected = "") {
  const el = $(selectId);
  if (!el) return;
  const list = sortZones(zones.filter(z => !activeOnly || z.active !== false));
  el.innerHTML =
    (includeEmpty ? '<option value="">Todas las zonas</option>' : "") +
    list.map(z => `<option value="${esc(z.zoneId)}">${esc(adminZoneOptionLabel(z))}</option>`).join("");
  if (selected !== "" && [...el.options].some(o => o.value === String(selected))) el.value = String(selected);
}

function fillSubzoneSelect(selectId, zoneId, includeEmpty = false, activeOnly = false, selected = "") {
  const el = $(selectId);
  if (!el) return;
  el.innerHTML =
    (includeEmpty ? '<option value="">Todas las subzonas</option>' : "") +
    filterSubzones(zoneId, activeOnly)
      .map(s => `<option value="${esc(s.subzoneId)}">${esc(adminSubzoneOptionLabel(s))}</option>`)
      .join("");
  if (selected !== "" && [...el.options].some(o => o.value === String(selected))) el.value = String(selected);
}

function fillLocationSelect(selectId, zoneId, subzoneId, includeEmpty = true, selected = "", machineOnly = false) {
  const el = $(selectId);
  if (!el) return;
  let list = filterLocations(zoneId, subzoneId, true);
  if (machineOnly) list = list.filter(l => l.type === "machine");
  el.innerHTML =
    (includeEmpty ? `<option value="">${machineOnly ? "Ninguna" : "Sin ubicación específica"}</option>` : "") +
    list.map(optionLocation).join("");
  if (selected !== "" && [...el.options].some(o => o.value === String(selected))) el.value = String(selected);
}

function refreshAllSelectors() {
  const itemZoneCurrent = $("#itemZone")?.value || "";
  const locationZoneCurrent = $("#locationZone")?.value || "";
  const subzoneZoneCurrent = $("#subzoneZone")?.value || "";
  const structureZoneCurrent = $("#structureZoneFilter")?.value || "";
  const itemFilterZoneCurrent = $("#itemFilterZone")?.value || "";

  fillZoneSelect("#itemZone", false, true, itemZoneCurrent);
  fillZoneSelect("#locationZone", false, true, locationZoneCurrent);
  fillZoneSelect("#subzoneZone", false, true, subzoneZoneCurrent);
  fillZoneSelect("#structureZoneFilter", true, false, structureZoneCurrent);
  fillZoneSelect("#itemFilterZone", true, false, itemFilterZoneCurrent);

  refreshItemFormSubzonesAndLocations();
  refreshLocationFormSubzonesAndParents();
  refreshItemFilterDependents();
}

function refreshItemFormSubzonesAndLocations(selectedSubzone = "", selectedLocation = "", selectedMachine = "") {
  const zoneId = $("#itemZone")?.value || "";
  const currentSub = selectedSubzone || $("#itemSubzone")?.value || "";
  fillSubzoneSelect("#itemSubzone", zoneId, false, true, currentSub);
  const subzoneId = $("#itemSubzone")?.value || "";
  fillLocationSelect("#itemLocation", zoneId, subzoneId, true, selectedLocation || $("#itemLocation")?.value || "");
  fillLocationSelect("#itemRelatedMachine", zoneId, subzoneId, true, selectedMachine || $("#itemRelatedMachine")?.value || "", true);
}

function refreshLocationFormSubzonesAndParents(selectedSubzone = "", selectedParent = "") {
  const zoneId = $("#locationZone")?.value || "";
  const currentSub = selectedSubzone || $("#locationSubzone")?.value || "";
  fillSubzoneSelect("#locationSubzone", zoneId, false, true, currentSub);
  const subzoneId = $("#locationSubzone")?.value || "";
  const currentLocationId = $("#locationId")?.value || "";
  const parent = $("#locationParent");
  if (!parent) return;
  const parents = filterLocations(zoneId, subzoneId, true).filter(l => String(l.locationId) !== String(currentLocationId));
  parent.innerHTML = '<option value="">Sin ubicación padre</option>' + parents.map(optionLocation).join("");
  const wanted = selectedParent || parent.value || "";
  if (wanted && [...parent.options].some(o => o.value === String(wanted))) parent.value = String(wanted);
}

function refreshItemFilterDependents() {
  const zoneId = $("#itemFilterZone")?.value || "";
  const subCurrent = $("#itemFilterSubzone")?.value || "";
  fillSubzoneSelect("#itemFilterSubzone", zoneId, true, false, subCurrent);
  const subzoneId = $("#itemFilterSubzone")?.value || "";
  const loc = $("#itemFilterLocation");
  if (loc) {
    const current = loc.value || "";
    const list = filterLocations(zoneId, subzoneId, false);
    loc.innerHTML = '<option value="">Todas las áreas</option>' +
      list.map(l => `<option value="${esc(l.locationId)}">${esc(adminLocationOptionLabel(l, false))}</option>`).join("");
    if (current && [...loc.options].some(o => o.value === current)) loc.value = current;
  }
}

async function loadBase() {
  const [z, s, w, l] = await Promise.all([
    getDocs(collection(db, "zones")),
    getDocs(collection(db, "subzones")),
    getDocs(collection(db, "fabacademyWeeks")),
    getDocs(collection(db, "locations")),
  ]);

  zones = sortZones(z.docs.map(d => ({ id: d.id, ...d.data() })));
  subzones = sortSubzones(s.docs.map(d => ({ id: d.id, ...d.data() })));
  weeks = w.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => Number(a.weekId) - Number(b.weekId));
  locations = sortLocations(l.docs.map(d => ({ id: d.id, ...d.data() })));

  $("#itemTipo").innerHTML = ITEM_TYPES.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
  $("#itemFilterType").innerHTML = '<option value="">Todos</option>' + ITEM_TYPES.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
  $("#locationType").innerHTML = LOCATION_TYPES.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
  $("#itemWeeks").innerHTML = weeks.map(x => `<option value="${esc(x.weekId)}">${esc(x.weekId)} · ${esc(x.name)}</option>`).join("");

  refreshAllSelectors();
}

async function loadItems() {
  const snap = await getDocs(query(collection(db, "items"), where("activo", "==", true)));
  adminItemsCache = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.sku || "").localeCompare(String(b.sku || ""), "es", { numeric: true }));
  updateStats();
}

function structureItemCounts() {
  const byZone = new Map();
  const bySubzone = new Map();
  const byLocation = new Map();

  for (const it of adminItemsCache) {
    const zoneKey = String(it.zoneId ?? "");
    const subKey = String(it.subzoneId ?? "");
    const locKey = String(it.locationId ?? "");
    byZone.set(zoneKey, (byZone.get(zoneKey) || 0) + 1);
    bySubzone.set(subKey, (bySubzone.get(subKey) || 0) + 1);
    if (locKey) byLocation.set(locKey, (byLocation.get(locKey) || 0) + 1);
  }
  return { byZone, bySubzone, byLocation };
}

function structureNodeText(z, subzoneRows, locationRows) {
  const zd = zoneDisplay(z);
  return normalizeForCompare([
    z.zoneId, z.name, zd.code, zd.name, z.description,
    ...subzoneRows.flatMap(s => {
      const sd = subzoneDisplay(s);
      return [s.subzoneId, s.name, sd.code, sd.name, s.description];
    }),
    ...locationRows.flatMap(l => {
      const ld = locationDisplay(l);
      return [l.locationId, l.areaCode, l.name, ld.code, ld.name, l.type, typeLabel(l.type), l.description];
    })
  ].filter(Boolean).join(" "));
}

function renderStructure() {
  const search = normalizeForCompare($("#structureSearch")?.value || "");
  const filterZone = $("#structureZoneFilter")?.value || "";
  const counts = structureItemCounts();
  const cards = [];

  for (const z of sortZones(zones)) {
    if (filterZone && String(z.zoneId) !== String(filterZone)) continue;

    const zoneSubs = sortSubzones(subzones.filter(s => Number(s.zoneId) === Number(z.zoneId)));
    const zoneLocs = sortLocations(locations.filter(l => Number(l.zoneId) === Number(z.zoneId)));

    if (search && !structureNodeText(z, zoneSubs, zoneLocs).includes(search)) continue;

    const zd = zoneDisplay(z);
    const subHtml = zoneSubs.map(s => {
      const sd = subzoneDisplay(s);
      const subLocs = sortLocations(zoneLocs.filter(l => String(l.subzoneId) === String(s.subzoneId)));
      const locHtml = subLocs.length ? subLocs.map(l => {
        const ld = locationDisplay(l);
        const rawCode = l.areaCode || l.locationCode || "";
        return `
          <div class="structure-location ${l.active === false ? "is-inactive" : ""}">
            <div>
              <div class="structure-location-code">${esc(ld.code || rawCode || "s/c")}</div>
              ${rawCode && String(rawCode) !== String(ld.code) ? `<div class="structure-technical">téc. ${esc(rawCode)}</div>` : ""}
            </div>
            <div>
              <div class="structure-location-name">${esc(ld.name || l.name || "Sin nombre")}</div>
              <div class="structure-count">${counts.byLocation.get(String(l.locationId)) || 0} elemento(s) ${inactiveBadge(l.active)}</div>
            </div>
            <div class="structure-location-type">${esc(typeLabel(l.type))}</div>
            <div class="structure-node-actions">
              <button class="btn btn-sm btn-outline-primary" type="button" data-action="edit-location" data-id="${esc(l.id)}">Editar</button>
              <button class="btn btn-sm btn-outline-danger" type="button" data-action="delete-location" data-id="${esc(l.id)}">Eliminar</button>
            </div>
          </div>`;
      }).join("") : '<div class="structure-empty">Sin áreas registradas.</div>';

      return `
        <div class="structure-subzone ${s.active === false ? "is-inactive" : ""}">
          <div class="structure-subzone-header">
            <div class="structure-subzone-main">
              <div class="structure-subzone-title">
                <span>${esc(sd.code)} · ${esc(sd.name || "Sin nombre")}</span>
                ${technicalBadge(s.subzoneId, sd.code)}
                ${inactiveBadge(s.active)}
              </div>
              <div class="structure-count">
                ${subLocs.length} área(s) · ${counts.bySubzone.get(String(s.subzoneId)) || 0} elemento(s)
              </div>
            </div>
            <div class="structure-node-actions">
              <button class="btn btn-sm btn-outline-primary" type="button" data-action="edit-subzone" data-id="${esc(s.id)}">Editar</button>
              <button class="btn btn-sm btn-outline-dark" type="button" data-action="new-location" data-zone="${esc(z.zoneId)}" data-subzone="${esc(s.subzoneId)}">+ Área</button>
              <button class="btn btn-sm btn-outline-danger" type="button" data-action="delete-subzone" data-id="${esc(s.id)}">Eliminar</button>
            </div>
          </div>
          <div class="structure-locations">${locHtml}</div>
        </div>`;
    }).join("");

    cards.push(`
      <article class="structure-zone ${z.active === false ? "is-inactive" : ""}">
        <div class="structure-zone-header">
          <div class="structure-zone-title">
            <span class="structure-code">${esc(zd.code)}</span>
            <div>
              <div class="structure-zone-name">${esc(zd.name || "Sin nombre")} ${technicalBadge(z.zoneId, zd.code)} ${inactiveBadge(z.active)}</div>
              <div class="structure-count">${zoneSubs.length} subzona(s) · ${zoneLocs.length} área(s) · ${counts.byZone.get(String(z.zoneId)) || 0} elemento(s)</div>
            </div>
          </div>
          <div class="structure-node-actions">
            <button class="btn btn-sm btn-outline-primary" type="button" data-action="edit-zone" data-id="${esc(z.id)}">Editar</button>
            <button class="btn btn-sm btn-outline-dark" type="button" data-action="new-subzone" data-zone="${esc(z.zoneId)}">+ Subzona</button>
            <button class="btn btn-sm btn-outline-danger" type="button" data-action="delete-zone" data-id="${esc(z.id)}">Eliminar</button>
          </div>
        </div>
        <div class="structure-zone-body">
          ${subHtml || '<div class="structure-empty">Sin subzonas registradas.</div>'}
        </div>
      </article>`);
  }

  $("#structureTree").innerHTML = cards.length
    ? cards.join("")
    : '<div class="structure-no-results">No se encontraron nodos con esos filtros.</div>';

  $("#structureSummary").textContent = `${cards.length} zona(s) mostrada(s) de ${zones.length}.`;
}

function renderItems() {
  const search = normalizeForCompare($("#itemSearch")?.value || "");
  const zoneId = $("#itemFilterZone")?.value || "";
  const subzoneId = $("#itemFilterSubzone")?.value || "";
  const locationId = $("#itemFilterLocation")?.value || "";
  const tipo = $("#itemFilterType")?.value || "";

  const rows = adminItemsCache.filter(it => {
    if (zoneId && String(it.zoneId) !== String(zoneId)) return false;
    if (subzoneId && String(it.subzoneId) !== String(subzoneId)) return false;
    if (locationId && String(it.locationId || "") !== String(locationId)) return false;
    if (tipo && normalizeTipo(it.tipo) !== tipo) return false;
    return currentItemMatchesText(it, search);
  });

  $("#itemCount").textContent = `${rows.length} de ${adminItemsCache.length} elemento(s) activos.`;

  $("#adminItems").innerHTML = rows.length ? rows.map(it => {
    const z = zones.find(x => Number(x.zoneId) === Number(it.zoneId));
    const s = subzones.find(x => String(x.subzoneId) === String(it.subzoneId));
    const l = locationById(it.locationId);
    const zd = zoneDisplay(z || { zoneId: it.zoneId, name: it.zoneName });
    const sd = subzoneDisplay(s || { subzoneId: it.subzoneId, name: it.subzoneName });
    const ld = locationDisplay(l || { areaCode: it.locationCode, name: it.locationName, subzoneId: it.subzoneId, subzoneName: it.subzoneName });
    const img = it.imageFileId
      ? `<img src="${esc(fileViewUrl(it.imageFileId))}" class="admin-thumb" alt="">`
      : '<div class="admin-thumb-placeholder">—</div>';

    return `
      <tr>
        <td>${img}</td>
        <td><code>${esc(it.sku || "")}</code></td>
        <td><div class="admin-item-name">${esc(it.nombre || "Sin nombre")}</div></td>
        <td>${esc(normalizeTipo(it.tipo))}</td>
        <td>
          <div class="admin-route">
            <strong>${esc(zd.code)} · ${esc(zd.name || it.zoneName || "")}</strong><br>
            ${esc(sd.code)} · ${esc(sd.name || it.subzoneName || "")}<br>
            ${ld.code ? `<span>${esc(ld.code)} · ${esc(ld.name || it.locationName || "")}</span>` : '<span>Sin área específica</span>'}
          </div>
        </td>
        <td>${Number(it.stockAlmacen || 0)}</td>
        <td>${Number(it.inventarioDeseado || 0)}</td>
        <td>
          <div class="admin-item-actions">
            <button class="btn btn-sm btn-outline-primary" type="button" data-item-action="edit" data-id="${esc(it.id)}">Editar</button>
            <button class="btn btn-sm btn-outline-warning" type="button" data-item-action="deactivate" data-id="${esc(it.id)}">Desactivar</button>
            <button class="btn btn-sm btn-outline-danger" type="button" data-item-action="delete" data-id="${esc(it.id)}">Eliminar</button>
          </div>
        </td>
      </tr>`;
  }).join("") : `
    <tr>
      <td colspan="8" class="text-center text-muted py-5">No se encontraron elementos con esos filtros.</td>
    </tr>`;
}

function openZoneForm(z = null) {
  $("#zoneForm").reset();
  $("#zoneEditingDocId").value = z?.id || "";
  $("#zoneId").disabled = Boolean(z);
  $("#zoneId").value = z?.zoneId ?? "";
  $("#zoneName").value = z?.name || "";
  $("#zoneOrder").value = z?.order ?? z?.zoneId ?? 1;
  $("#zoneDescription").value = z?.description || "";
  $("#zoneActive").checked = z?.active !== false;
  $("#zoneModalTitle").textContent = z ? "Editar zona" : "Nueva zona";
  zoneModal().show();
}

function openSubzoneForm(s = null, presetZoneId = "") {
  $("#subzoneForm").reset();
  $("#subzoneEditingDocId").value = s?.id || "";
  fillZoneSelect("#subzoneZone", false, true, s?.zoneId || presetZoneId || "");
  $("#subzoneZone").disabled = Boolean(s);
  $("#subzoneId").disabled = Boolean(s);
  $("#subzoneId").value = s?.subzoneId || "";
  $("#subzoneName").value = s?.name || "";
  $("#subzoneOrder").value = s?.order ?? 1;
  $("#subzoneDescription").value = s?.description || "";
  $("#subzoneActive").checked = s?.active !== false;
  $("#subzoneModalTitle").textContent = s ? "Editar subzona" : "Nueva subzona";
  subzoneModal().show();
}

function clearLocationForm() {
  $("#locationForm").reset();
  $("#locationEditingId").value = "";
  $("#locationId").disabled = false;
  $("#locationZone").disabled = false;
  $("#locationSubzone").disabled = false;
  fillZoneSelect("#locationZone", false, true);
  refreshLocationFormSubzonesAndParents();
  $("#locationOrder").value = 1;
}

function openLocationForm(l = null, presetZoneId = "", presetSubzoneId = "") {
  clearLocationForm();
  $("#locationEditingId").value = l?.id || "";

  if (l) {
    $("#locationId").value = l.locationId || l.id;
    $("#locationId").disabled = true;
    fillZoneSelect("#locationZone", false, true, l.zoneId || "");
    $("#locationZone").disabled = true;
    fillSubzoneSelect("#locationSubzone", l.zoneId, false, true, l.subzoneId || "");
    $("#locationSubzone").disabled = true;
    $("#locationAreaCode").value = l.areaCode || l.locationCode || "";
    $("#locationName").value = l.name || "";
    $("#locationType").value = l.type || "general";
    $("#locationOrder").value = l.order || 1;
    $("#locationDescription").value = l.description || "";
    refreshLocationFormSubzonesAndParents(l.subzoneId || "", l.parentLocationId || "");
    $("#locationModalTitle").textContent = "Editar área";
  } else {
    fillZoneSelect("#locationZone", false, true, presetZoneId || "");
    refreshLocationFormSubzonesAndParents(presetSubzoneId || "");
    if (presetSubzoneId) $("#locationSubzone").value = presetSubzoneId;
    refreshLocationFormSubzonesAndParents(presetSubzoneId || "");
    $("#locationModalTitle").textContent = "Nueva área";
  }

  locationModal().show();
}

function clearItemForm() {
  $("#itemForm").reset();
  $("#itemId").value = "";
  fillZoneSelect("#itemZone", false, true);
  refreshItemFormSubzonesAndLocations();
  $("#itemTipo").value = "Otro";
  $("#itemMoneda").value = "MXN";
  $("#itemPrecioUnitario").value = 0;
  applyDefaultsForSelectedType(true);
}

function openItemForm(it = null) {
  clearItemForm();
  if (!it) {
    $("#itemModalTitle").textContent = "Nuevo elemento";
    itemModal().show();
    return;
  }

  $("#itemId").value = it.id;
  $("#itemSku").value = it.sku || "";
  $("#itemNombre").value = it.nombre || "";
  $("#itemDescripcion").value = it.descripcion || "";
  $("#itemTipo").value = normalizeTipo(it.tipo || "Otro");

  fillZoneSelect("#itemZone", false, true, it.zoneId || "");
  refreshItemFormSubzonesAndLocations(it.subzoneId || "", it.locationId || "", it.relatedMachineId || "");
  $("#itemSubzone").value = it.subzoneId || "";
  refreshItemFormSubzonesAndLocations(it.subzoneId || "", it.locationId || "", it.relatedMachineId || "");

  [...$("#itemWeeks").options].forEach(o => {
    o.selected = (it.fabacademyWeeks || []).map(String).includes(o.value);
  });

  $("#itemInfoUrl").value = it.infoUrl || "";
  $("#itemPurchaseUrl").value = it.purchaseUrl || "";
  $("#itemStock").value = it.stockAlmacen || 0;
  $("#itemPrestado").value = it.stockPrestadoTemporal || 0;
  $("#itemLargo").value = it.stockLargoPlazo || 0;
  $("#itemDanado").value = it.stockDanado || 0;
  $("#itemPerdido").value = it.stockPerdido || 0;
  $("#itemDeseado").value = it.inventarioDeseado || 0;
  $("#itemPrecioUnitario").value = it.precioUnitario ?? it.precio ?? 0;
  $("#itemMoneda").value = it.moneda || "MXN";

  const defaults = defaultsForType(normalizeTipo(it.tipo || "Otro"));
  $("#itemVisibleAlumno").checked = it.visibleParaAlumno ?? defaults.visibleParaAlumno;
  $("#itemPrestable").checked = it.prestamoHabilitado ?? defaults.prestamoHabilitado;
  $("#itemReservable").checked = it.reservaHabilitada ?? defaults.reservaHabilitada;
  $("#itemAsistencia").checked = it.requiereAsistencia ?? defaults.requiereAsistencia;

  $("#itemModalTitle").textContent = "Editar elemento";
  itemModal().show();
}

async function saveZone(e) {
  e.preventDefault();
  const editingDocId = $("#zoneEditingDocId").value || "";
  const zoneId = Number($("#zoneId").value);
  const name = $("#zoneName").value.trim();

  if (!Number.isInteger(zoneId) || zoneId <= 0) return alert("El ID de zona debe ser un número entero positivo.");
  if (!name) return alert("Escribe el nombre de la zona.");

  if (!editingDocId && zones.some(z => Number(z.zoneId) === zoneId)) {
    return alert(`Ya existe una zona con zoneId ${zoneId}.`);
  }

  if (editingDocId) {
    const current = zones.find(z => String(z.id) === String(editingDocId));
    await updateDoc(doc(db, "zones", editingDocId), {
      name,
      active: $("#zoneActive").checked,
      order: Number($("#zoneOrder").value || zoneId),
      description: $("#zoneDescription").value.trim(),
      updatedAt: serverTimestamp(),
    });

    if (current && current.name !== name) {
      await propagateZoneName(zoneId, name);
    }
  } else {
    const docId = String(zoneId);
    await setDoc(doc(db, "zones", docId), {
      zoneId,
      name,
      active: $("#zoneActive").checked,
      order: Number($("#zoneOrder").value || zoneId),
      description: $("#zoneDescription").value.trim(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  zoneModal().hide();
  await refreshEverything();
}

async function saveSubzone(e) {
  e.preventDefault();
  const editingDocId = $("#subzoneEditingDocId").value || "";
  const zoneId = Number($("#subzoneZone").value);
  const subzoneId = $("#subzoneId").value.trim();
  const name = $("#subzoneName").value.trim();

  if (!zoneId || !subzoneId || !name) return alert("Completa zona, ID de subzona y nombre.");

  if (!editingDocId && subzones.some(s => String(s.subzoneId) === subzoneId)) {
    return alert(`Ya existe una subzona con subzoneId "${subzoneId}".`);
  }

  if (editingDocId) {
    const current = subzones.find(s => String(s.id) === String(editingDocId));
    await updateDoc(doc(db, "subzones", editingDocId), {
      name,
      active: $("#subzoneActive").checked,
      order: Number($("#subzoneOrder").value || 1),
      description: $("#subzoneDescription").value.trim(),
      updatedAt: serverTimestamp(),
    });

    if (current && current.name !== name) {
      await propagateSubzoneName(current.subzoneId, name);
    }
  } else {
    await setDoc(doc(db, "subzones", subzoneId), {
      subzoneId,
      zoneId,
      name,
      active: $("#subzoneActive").checked,
      order: Number($("#subzoneOrder").value || 1),
      description: $("#subzoneDescription").value.trim(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  subzoneModal().hide();
  await refreshEverything();
}

async function saveLocation(e) {
  e.preventDefault();
  const editingId = $("#locationEditingId").value || "";
  const zoneId = Number($("#locationZone").value);
  const subzoneId = $("#locationSubzone").value;
  const name = $("#locationName").value.trim();

  if (!zoneId || !subzoneId || !name) return alert("Completa zona, subzona y nombre del área.");

  let locationId = $("#locationId").value.trim();
  if (!locationId) locationId = `${subzoneId}-${normalizeId(name)}`;

  if (!editingId && locations.some(l => String(l.locationId || l.id) === locationId)) {
    return alert(`Ya existe una ubicación con ID "${locationId}".`);
  }

  const zone = zones.find(z => Number(z.zoneId) === zoneId);
  const subzone = subzones.find(s => String(s.subzoneId) === String(subzoneId));
  const parentId = $("#locationParent").value || "";
  const parent = parentId ? locationById(parentId) : null;

  const data = {
    locationId,
    areaCode: $("#locationAreaCode").value.trim(),
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

  if (editingId) await propagateLocationMetadata(locationId, data);

  locationModal().hide();
  await refreshEverything();
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

async function findDuplicateSku(sku, currentItemId = "") {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku) return null;

  const localDuplicate = adminItemsCache.find(it =>
    normalizeSku(it.sku) === normalizedSku &&
    String(it.id) !== String(currentItemId)
  );
  if (localDuplicate) return localDuplicate;

  const exactSnap = await getDocs(query(collection(db, "items"), where("sku", "==", String(sku || "").trim())));
  return exactSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .find(it => String(it.id) !== String(currentItemId)) || null;
}

async function saveItem(e) {
  e.preventDefault();
  const submitBtn = e.submitter || e.currentTarget.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const currentItemId = $("#itemId").value || "";
    const sku = $("#itemSku").value.trim();
    if (!sku) return alert("El SKU es obligatorio.");

    const duplicate = await findDuplicateSku(sku, currentItemId);
    if (duplicate) {
      return alert(`No se puede guardar: el SKU "${sku}" ya existe en ${duplicate.sku || ""} · ${duplicate.nombre || "otro elemento"}.`);
    }

    const itemId = currentItemId || doc(collection(db, "items")).id;
    const zoneId = Number($("#itemZone").value);
    const subzoneId = $("#itemSubzone").value;
    const locationId = $("#itemLocation").value || "";
    const relatedMachineId = $("#itemRelatedMachine").value || "";
    const location = locationId ? locationById(locationId) : null;
    const relatedMachine = relatedMachineId ? locationById(relatedMachineId) : null;
    const fabIds = selectedOptions("#itemWeeks");
    const zone = zones.find(z => Number(z.zoneId) === zoneId);
    const subzone = subzones.find(s => String(s.subzoneId) === String(subzoneId));

    const [imageFileId, pdfFileId, datasheetFileId] = await Promise.all([
      uploadFile("#itemImage", "image", itemId),
      uploadFile("#itemPdf", "pdf", itemId),
      uploadFile("#itemDatasheet", "datasheet", itemId),
    ]);

    const base = {
      sku,
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
      precioUnitario: Number($("#itemPrecioUnitario").value || 0),
      moneda: $("#itemMoneda").value || "MXN",
      visibleParaAlumno: $("#itemVisibleAlumno").checked,
      prestamoHabilitado: $("#itemPrestable").checked,
      reservaHabilitada: $("#itemReservable").checked,
      requiereAsistencia: $("#itemAsistencia").checked,
      activo: true,
      updatedAt: serverTimestamp(),
    };

    if (!currentItemId) base.createdAt = serverTimestamp();
    if (imageFileId) base.imageFileId = imageFileId;
    if (pdfFileId) base.pdfFileId = pdfFileId;
    if (datasheetFileId) base.datasheetFileId = datasheetFileId;

    await setDoc(doc(db, "items", itemId), base, { merge: true });
    itemModal().hide();
    await loadItems();
    renderItems();
    renderStructure();
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function propagateZoneName(zoneId, newName) {
  const [locSnap, itemSnap] = await Promise.all([
    getDocs(collection(db, "locations")),
    getDocs(collection(db, "items")),
  ]);

  const updates = [];
  locSnap.docs.forEach(d => {
    const data = d.data();
    if (Number(data.zoneId) === Number(zoneId)) {
      updates.push(updateDoc(d.ref, { zoneName: newName, updatedAt: serverTimestamp() }));
    }
  });
  itemSnap.docs.forEach(d => {
    const data = d.data();
    if (Number(data.zoneId) === Number(zoneId)) {
      updates.push(updateDoc(d.ref, { zoneName: newName, updatedAt: serverTimestamp() }));
    }
  });
  await Promise.all(updates);
}

async function propagateSubzoneName(subzoneId, newName) {
  const [locSnap, itemSnap] = await Promise.all([
    getDocs(collection(db, "locations")),
    getDocs(collection(db, "items")),
  ]);

  const updates = [];
  locSnap.docs.forEach(d => {
    const data = d.data();
    if (String(data.subzoneId) === String(subzoneId)) {
      updates.push(updateDoc(d.ref, { subzoneName: newName, updatedAt: serverTimestamp() }));
    }
  });
  itemSnap.docs.forEach(d => {
    const data = d.data();
    if (String(data.subzoneId) === String(subzoneId)) {
      updates.push(updateDoc(d.ref, { subzoneName: newName, updatedAt: serverTimestamp() }));
    }
  });
  await Promise.all(updates);
}

async function propagateLocationMetadata(locationId, data) {
  const itemSnap = await getDocs(collection(db, "items"));
  const updates = [];

  itemSnap.docs.forEach(d => {
    const it = d.data();
    const patch = {};

    if (String(it.locationId || "") === String(locationId)) {
      patch.locationName = data.name || "";
      patch.locationCode = data.areaCode || "";
      patch.locationType = data.type || "";
    }

    if (String(it.relatedMachineId || "") === String(locationId)) {
      patch.relatedMachineName = data.name || "";
      patch.relatedMachineCode = data.areaCode || "";
    }

    if (Object.keys(patch).length) {
      patch.updatedAt = serverTimestamp();
      updates.push(updateDoc(d.ref, patch));
    }
  });

  await Promise.all(updates);
}

async function deleteZone(zoneDocId) {
  const zone = zones.find(z => String(z.id) === String(zoneDocId));
  if (!zone) return alert("No se encontró la zona.");

  const [subsSnap, locSnap, itemSnap] = await Promise.all([
    getDocs(collection(db, "subzones")),
    getDocs(collection(db, "locations")),
    getDocs(collection(db, "items")),
  ]);

  const subCount = subsSnap.docs.filter(d => Number(d.data().zoneId) === Number(zone.zoneId)).length;
  const locCount = locSnap.docs.filter(d => Number(d.data().zoneId) === Number(zone.zoneId)).length;
  const itemCount = itemSnap.docs.filter(d => Number(d.data().zoneId) === Number(zone.zoneId)).length;

  if (subCount || locCount || itemCount) {
    return alert(
      `No se puede eliminar esta zona.\n\n` +
      `Subzonas: ${subCount}\nÁreas: ${locCount}\nElementos: ${itemCount}\n\n` +
      `Primero elimina o migra todas sus referencias.`
    );
  }

  if (!confirm(`¿Eliminar definitivamente la zona "${adminZoneOptionLabel(zone)}"?\n\nEsta acción no se puede deshacer.`)) return;
  await deleteDoc(doc(db, "zones", zoneDocId));
  await refreshEverything();
}

async function deleteSubzone(subzoneDocId) {
  const subzone = subzones.find(s => String(s.id) === String(subzoneDocId));
  if (!subzone) return alert("No se encontró la subzona.");

  const [locSnap, itemSnap] = await Promise.all([
    getDocs(collection(db, "locations")),
    getDocs(collection(db, "items")),
  ]);

  const locCount = locSnap.docs.filter(d => String(d.data().subzoneId) === String(subzone.subzoneId)).length;
  const itemCount = itemSnap.docs.filter(d => String(d.data().subzoneId) === String(subzone.subzoneId)).length;

  if (locCount || itemCount) {
    return alert(
      `No se puede eliminar esta subzona.\n\n` +
      `Áreas: ${locCount}\nElementos: ${itemCount}\n\n` +
      `Primero elimina o migra todas sus referencias.`
    );
  }

  if (!confirm(`¿Eliminar definitivamente la subzona "${adminSubzoneOptionLabel(subzone)}"?\n\nEsta acción no se puede deshacer.`)) return;
  await deleteDoc(doc(db, "subzones", subzoneDocId));
  await refreshEverything();
}

async function deleteLocation(locationDocId) {
  const location = locations.find(l => String(l.id) === String(locationDocId));
  if (!location) return alert("No se encontró el área.");

  const locationId = location.locationId || location.id;
  const [itemsSnap, locationsSnap] = await Promise.all([
    getDocs(collection(db, "items")),
    getDocs(collection(db, "locations")),
  ]);

  const linkedItems = itemsSnap.docs.filter(d => {
    const it = d.data();
    return String(it.locationId || "") === String(locationId) ||
      String(it.relatedMachineId || "") === String(locationId);
  });

  const childLocations = locationsSnap.docs.filter(d =>
    String(d.data().parentLocationId || "") === String(locationId)
  );

  if (linkedItems.length || childLocations.length) {
    return alert(
      `No se puede eliminar esta área.\n\n` +
      `Elementos asociados o relacionados: ${linkedItems.length}\n` +
      `Sububicaciones hijas: ${childLocations.length}\n\n` +
      `Primero reasigna o elimina esas referencias.`
    );
  }

  const d = locationDisplay(location);
  if (!confirm(`¿Eliminar definitivamente el área "${d.code ? d.code + " · " : ""}${d.name || locationId}"?\n\nEsta acción no se puede deshacer.`)) return;

  await deleteDoc(doc(db, "locations", locationDocId));
  await refreshEverything();
}

async function deactivateItem(itemId) {
  const item = adminItemsCache.find(x => String(x.id) === String(itemId));
  if (!item) return;
  if (!confirm(`¿Desactivar "${item.sku || ""} · ${item.nombre || ""}"?`)) return;
  await updateDoc(doc(db, "items", itemId), { activo: false, updatedAt: serverTimestamp() });
  await loadItems();
  renderItems();
  renderStructure();
}

async function deleteItem(itemId) {
  const item = adminItemsCache.find(x => String(x.id) === String(itemId));
  const label = item ? `${item.sku || item.id} · ${item.nombre || ""}` : itemId;
  if (!confirm(`¿Eliminar definitivamente el elemento "${label}"?\n\nEsta acción no se puede deshacer.`)) return;

  await deleteDoc(doc(db, "items", itemId));
  await loadItems();
  renderItems();
  renderStructure();
}

async function refreshEverything() {
  await loadBase();
  await loadItems();
  renderStructure();
  renderItems();
  updateStats();
}

function switchView(view) {
  document.querySelectorAll("[data-admin-view]").forEach(btn => {
    const active = btn.dataset.adminView === view;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  $("#structureView").classList.toggle("active", view === "structure");
  $("#itemsView").classList.toggle("active", view === "items");
}

function bindEvents() {
  document.querySelectorAll("[data-admin-view]").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.adminView));
  });

  $("#newZoneBtn").addEventListener("click", () => openZoneForm());
  $("#newSubzoneBtn").addEventListener("click", () => openSubzoneForm());
  $("#newLocationBtn").addEventListener("click", () => openLocationForm());
  $("#newItemBtn").addEventListener("click", () => openItemForm());

  $("#zoneForm").addEventListener("submit", saveZone);
  $("#subzoneForm").addEventListener("submit", saveSubzone);
  $("#locationForm").addEventListener("submit", saveLocation);
  $("#itemForm").addEventListener("submit", saveItem);

  $("#clearLocationForm").addEventListener("click", clearLocationForm);
  $("#clearItemForm").addEventListener("click", clearItemForm);

  $("#itemTipo").addEventListener("change", () => applyDefaultsForSelectedType(false));
  $("#itemZone").addEventListener("change", () => refreshItemFormSubzonesAndLocations());
  $("#itemSubzone").addEventListener("change", () => refreshItemFormSubzonesAndLocations());
  $("#locationZone").addEventListener("change", () => refreshLocationFormSubzonesAndParents());
  $("#locationSubzone").addEventListener("change", () => refreshLocationFormSubzonesAndParents());

  $("#structureSearch").addEventListener("input", renderStructure);
  $("#structureZoneFilter").addEventListener("change", renderStructure);
  $("#clearStructureFilters").addEventListener("click", () => {
    $("#structureSearch").value = "";
    $("#structureZoneFilter").value = "";
    renderStructure();
  });

  $("#itemSearch").addEventListener("input", renderItems);
  $("#itemFilterZone").addEventListener("change", () => {
    $("#itemFilterSubzone").value = "";
    $("#itemFilterLocation").value = "";
    refreshItemFilterDependents();
    renderItems();
  });
  $("#itemFilterSubzone").addEventListener("change", () => {
    $("#itemFilterLocation").value = "";
    refreshItemFilterDependents();
    renderItems();
  });
  $("#itemFilterLocation").addEventListener("change", renderItems);
  $("#itemFilterType").addEventListener("change", renderItems);
  $("#clearItemFilters").addEventListener("click", () => {
    $("#itemSearch").value = "";
    $("#itemFilterZone").value = "";
    refreshItemFilterDependents();
    $("#itemFilterSubzone").value = "";
    $("#itemFilterLocation").value = "";
    $("#itemFilterType").value = "";
    renderItems();
  });

  $("#structureTree").addEventListener("click", async e => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id || "";

    if (action === "edit-zone") {
      const z = zones.find(x => String(x.id) === String(id));
      if (z) openZoneForm(z);
    } else if (action === "delete-zone") {
      await deleteZone(id);
    } else if (action === "new-subzone") {
      openSubzoneForm(null, btn.dataset.zone || "");
    } else if (action === "edit-subzone") {
      const s = subzones.find(x => String(x.id) === String(id));
      if (s) openSubzoneForm(s);
    } else if (action === "delete-subzone") {
      await deleteSubzone(id);
    } else if (action === "new-location") {
      openLocationForm(null, btn.dataset.zone || "", btn.dataset.subzone || "");
    } else if (action === "edit-location") {
      const l = locations.find(x => String(x.id) === String(id));
      if (l) openLocationForm(l);
    } else if (action === "delete-location") {
      await deleteLocation(id);
    }
  });

  $("#adminItems").addEventListener("click", async e => {
    const btn = e.target.closest("[data-item-action]");
    if (!btn) return;
    const item = adminItemsCache.find(x => String(x.id) === String(btn.dataset.id));
    if (!item) return;

    if (btn.dataset.itemAction === "edit") openItemForm(item);
    if (btn.dataset.itemAction === "deactivate") await deactivateItem(item.id);
    if (btn.dataset.itemAction === "delete") await deleteItem(item.id);
  });
}

async function init() {
  await requireRole(["admin"]);
  await loadBase();
  await loadItems();
  renderStructure();
  renderItems();
  updateStats();
  bindEvents();
}

init().catch(err => {
  console.error(err);
  alert(err?.message || "No se pudo cargar la administración.");
});
