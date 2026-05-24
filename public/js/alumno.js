import { db } from "./firebase-app.js";
import { setupNav, requireLogin, formatDate } from "./common.js";
import { collection, getDocs, query, where, orderBy } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

setupNav();

async function init() {
  const user = await requireLogin();
  if (!user) return;
  const q = query(collection(db, "loanRequests"), where("alumnoUid", "==", user.uid), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  const target = document.querySelector("#myRequests");
  target.innerHTML = snap.docs.map(d => {
    const r = d.data();
    const lines = (r.items || []).map(x => `<li>${x.nombre} · Solicitado: ${x.cantidadSolicitada} · Aprobado: ${x.cantidadAprobada} · Entregado: ${x.cantidadEntregada} · Devuelto: ${x.cantidadDevuelta} · Largo plazo: ${x.cantidadLargoPlazo}</li>`).join("");
    return `<div class="card shadow-sm mb-3"><div class="card-body">
      <div class="d-flex justify-content-between"><h5>${r.requestCode || d.id}</h5><span class="badge text-bg-secondary">${r.status}</span></div>
      <div class="small text-muted">${formatDate(r.createdAt)}</div>
      <ul class="mt-2">${lines}</ul>
      <p class="mb-0"><strong>Comentarios:</strong> ${r.comentariosAlumno || ""}</p>
      ${r.comentariosTecnico ? `<p class="mb-0"><strong>Técnico:</strong> ${r.comentariosTecnico}</p>` : ''}
    </div></div>`;
  }).join("") || '<p class="text-muted">No tienes solicitudes registradas.</p>';
}

init().catch(err => alert(err.message));
