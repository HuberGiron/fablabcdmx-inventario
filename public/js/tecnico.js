import { db } from "./firebase-app.js";
import { setupNav, requireRole, apiFetch, formatDate } from "./common.js";
import { collection, getDocs, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

setupNav();

async function callLoan(id, action, body = {}) {
  const res = await apiFetch(`/api/loans/${id}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function renderRequests() {
  const snap = await getDocs(query(collection(db, "loanRequests"), orderBy("createdAt", "desc")));
  const target = document.querySelector("#requestsList");
  target.innerHTML = snap.docs.map(d => {
    const r = d.data();
    const lines = (r.items || []).map(x => `<li>${x.nombre} · Sol: ${x.cantidadSolicitada} · Apr: ${x.cantidadAprobada} · Ent: ${x.cantidadEntregada} · Dev: ${x.cantidadDevuelta} · LP: ${x.cantidadLargoPlazo}</li>`).join("");
    return `<div class="card shadow-sm mb-3"><div class="card-body">
      <div class="d-flex justify-content-between"><h5>${r.requestCode || d.id}</h5><span class="badge text-bg-secondary">${r.status}</span></div>
      <div class="small text-muted">${formatDate(r.createdAt)} · ${r.alumnoNombre || ""} · ${r.numeroCuenta || ""}</div>
      <ul class="mt-2">${lines}</ul>
      <p><strong>Alumno:</strong> ${r.comentariosAlumno || ""}</p>
      <div class="d-flex flex-wrap gap-2">
        <button class="btn btn-sm btn-success loan-action" data-id="${d.id}" data-action="approve">Aprobar</button>
        <button class="btn btn-sm btn-primary loan-action" data-id="${d.id}" data-action="deliver">Entregar</button>
        <button class="btn btn-sm btn-warning loan-action" data-id="${d.id}" data-action="return">Registrar devolución</button>
        <button class="btn btn-sm btn-dark loan-action" data-id="${d.id}" data-action="long-term">Pasar a largo plazo</button>
        <button class="btn btn-sm btn-outline-danger loan-action" data-id="${d.id}" data-action="reject">Rechazar</button>
      </div>
    </div></div>`;
  }).join("") || '<p class="text-muted">No hay solicitudes.</p>';

  document.querySelectorAll(".loan-action").forEach(btn => btn.addEventListener("click", async () => {
    const notes = prompt("Notas del técnico:", "") || "";
    try {
      await callLoan(btn.dataset.id, btn.dataset.action, { notes, comentariosTecnico: notes });
      await renderRequests();
    } catch (err) {
      alert(err.message);
    }
  }));
}

async function downloadPurchaseList() {
  const res = await apiFetch("/api/export/purchase-list-csv");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "lista_compra_fablab.csv";
  a.click();
  URL.revokeObjectURL(url);
}

async function init() {
  await requireRole(["admin", "tecnico"]);
  await renderRequests();
  document.querySelector("#purchaseCsv")?.addEventListener("click", downloadPurchaseList);
}
init().catch(err => alert(err.message));
