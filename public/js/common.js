import { auth, db } from "./firebase-app.js";
import { API_BASE_URL } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const BACKEND_ENABLED = Boolean(String(API_BASE_URL || "").trim());

export function $(selector) {
  return document.querySelector(selector);
}

export function formatDate(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("es-MX");
}

export function waitForUser() {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user);
    });
  });
}

export async function getUserProfile(uid) {
  if (!uid) return null;
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

export async function requireLogin() {
  const user = await waitForUser();
  if (!user) {
    window.location.href = "login.html";
    return null;
  }
  return user;
}

export async function requireRole(allowedRoles) {
  const user = await requireLogin();
  if (!user) return null;
  const profile = await getUserProfile(user.uid);
  if (!profile || !allowedRoles.includes(profile.role)) {
    alert("No tienes permisos para acceder a esta página.");
    window.location.href = "index.html";
    return null;
  }
  return { user, profile };
}

export async function apiFetch(path, options = {}) {
  if (!BACKEND_ENABLED) {
    throw new Error("Backend no configurado. Define API_BASE_URL en public/js/firebase-config.js.");
  }
  const user = await waitForUser();
  const headers = new Headers(options.headers || {});
  if (user) {
    const token = await user.getIdToken();
    headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    let msg = await res.text();
    try { msg = JSON.parse(msg).detail || msg; } catch (_) {}
    throw new Error(msg || `Error HTTP ${res.status}`);
  }
  return res;
}

export function fileViewUrl(fileId) {
  if (!fileId || !BACKEND_ENABLED) return "assets/placeholder.svg";
  return `${API_BASE_URL}/api/files/${encodeURIComponent(fileId)}/view`;
}

export async function downloadProtectedFile(fileId, filename = "archivo") {
  if (!fileId) return;
  if (!BACKEND_ENABLED) {
    alert("La descarga de archivos estará disponible cuando se active el backend FastAPI.");
    return;
  }
  const res = await apiFetch(`/api/files/${encodeURIComponent(fileId)}/download`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function uploadItemAsset(itemId, assetType, file) {
  if (!file) return null;
  const formData = new FormData();
  formData.append("file", file);
  const res = await apiFetch(`/api/items/${encodeURIComponent(itemId)}/assets/${encodeURIComponent(assetType)}`, {
    method: "POST",
    body: formData,
  });
  return res.json();
}

export async function logout() {
  await signOut(auth);
  window.location.href = "login.html";
}

function roleBadge(role) {
  const label = role === "admin" ? "Vista admin" : role === "tecnico" ? "Vista técnico" : role === "alumno" ? "Vista alumno" : "Vista pública";
  const klass = role === "admin" ? "text-bg-dark" : role === "tecnico" ? "text-bg-info" : role === "alumno" ? "text-bg-primary" : "text-bg-secondary";
  return `<span class="badge rounded-pill ${klass}">${label}</span>`;
}

function currentPageName() {
  const path = window.location.pathname.split("/").pop() || "index.html";
  return path;
}

function navLink(href, label) {
  const active = currentPageName() === href ? " active" : "";
  const aria = active ? ' aria-current="page"' : "";
  return `<a class="btn btn-outline-dark btn-sm nav-section-link${active}" href="${href}"${aria}>${label}</a>`;
}

export function setupNav() {
  const nav = document.querySelector("#userNav");
  if (!nav) return;
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      const isPurchasesPage = currentPageName() === "compras.html";
      nav.innerHTML = `
        ${roleBadge("public")}
        ${navLink("index.html", "Inventario")}
        ${isPurchasesPage ? navLink("compras.html", "Compras") : ""}
        <a class="btn btn-outline-primary btn-sm" href="login.html">Entrar</a>`;
      return;
    }
    const profile = await getUserProfile(user.uid);
    const role = profile?.role || "alumno";
    nav.innerHTML = `
      ${roleBadge(role)}
      ${navLink("index.html", "Inventario")}
      ${navLink("compras.html", "Compras")}
      <span class="small text-muted d-none d-md-inline">${profile?.nombre || user.email}</span>
      ${role === "admin" ? '<a class="btn btn-outline-dark btn-sm" href="admin.html">Admin</a>' : ''}
      ${role === "tecnico" || role === "admin" ? '<a class="btn btn-outline-dark btn-sm" href="tecnico.html">Técnico</a>' : ''}
      <a class="btn btn-outline-secondary btn-sm" href="alumno.html">Mis préstamos</a>
      <button id="logoutBtn" class="btn btn-danger btn-sm">Salir</button>`;
    document.querySelector("#logoutBtn")?.addEventListener("click", logout);
  });
}
