import { auth, db } from "./firebase-app.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  collection,
  getDocs,
  getDocsFromCache,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/*
 * Vista pública del Inventario FabLab.
 *
 * Mientras el visitante NO haya iniciado sesión, el botón visual "Más info"
 * usa la liga de compra (purchaseUrl) en lugar de infoUrl.
 *
 * Los usuarios autenticados conservan el comportamiento original de
 * catalogo.js y continúan viendo infoUrl en "Más info".
 */

function waitForAuthState() {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

function waitForInventoryRender() {
  const list = document.querySelector("#itemsList");
  if (!list) return Promise.resolve(null);
  if (list.querySelector(".item-card[data-item-id]")) return Promise.resolve(list);

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!list.querySelector(".item-card[data-item-id]")) return;
      observer.disconnect();
      resolve(list);
    });

    observer.observe(list, { childList: true, subtree: true });
  });
}

function isMoreInfoLink(anchor) {
  const text = String(anchor?.textContent || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return text === "mas info";
}

function actionRowFor(card) {
  // En catalogo.js esta fila es hija directa de .card-body y contiene los
  // accesos de documentación / préstamo / asistencia. También existe cuando
  // el elemento es únicamente de consulta.
  return card.querySelector(".card-body > .d-flex.flex-wrap.gap-2.align-items-center");
}

function patchCard(card, purchaseById) {
  const itemId = String(card?.dataset?.itemId || "");
  if (!itemId) return;

  const purchaseUrl = String(purchaseById.get(itemId) || "").trim();
  const row = actionRowFor(card);
  if (!row) return;

  const currentLinks = [...row.querySelectorAll("a")].filter(isMoreInfoLink);

  // En vista pública nunca dejamos "Más info" apuntando a infoUrl.
  if (!purchaseUrl) {
    currentLinks.forEach((link) => link.remove());
    return;
  }

  let link = currentLinks[0] || null;

  if (!link) {
    link = document.createElement("a");
    link.className = "btn btn-sm btn-outline-primary";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Más info";
    row.prepend(link);
  }

  link.href = purchaseUrl;
  link.dataset.publicPurchaseUrl = "true";

  // Evita duplicados si otra capa vuelve a materializar la tarjeta.
  currentLinks.slice(1).forEach((extra) => extra.remove());
}

function patchVisibleCards(purchaseById) {
  document.querySelectorAll("#itemsList .item-card[data-item-id]")
    .forEach((card) => patchCard(card, purchaseById));
}

async function loadPublicPurchaseUrls() {
  const itemsQuery = query(
    collection(db, "items"),
    where("activo", "==", true),
    where("visibleParaAlumno", "==", true),
  );

  // catalogo.js ejecuta exactamente esta consulta antes de pintar las tarjetas.
  // Primero intentamos reutilizar su caché para no duplicar lecturas de red.
  try {
    const cached = await getDocsFromCache(itemsQuery);
    if (!cached.empty) {
      return new Map(cached.docs.map((doc) => [doc.id, doc.data()?.purchaseUrl || ""]));
    }
  } catch (_) {
    // Si el navegador aún no tiene la consulta en caché, usamos el fallback normal.
  }

  const snapshot = await getDocs(itemsQuery);
  return new Map(snapshot.docs.map((doc) => [doc.id, doc.data()?.purchaseUrl || ""]));
}

async function initPublicPurchaseInfo() {
  const user = await waitForAuthState();

  // El cambio solicitado aplica exclusivamente a visitantes sin sesión.
  if (user) return;

  const list = await waitForInventoryRender();
  if (!list) return;

  const purchaseById = await loadPublicPurchaseUrls();
  patchVisibleCards(purchaseById);

  // inventario-performance.js materializa tarjetas por lotes al hacer scroll.
  // Observamos esos nuevos lotes para aplicar el mismo enlace sin recargar.
  const observer = new MutationObserver(() => patchVisibleCards(purchaseById));
  observer.observe(list, { childList: true, subtree: true });
}

initPublicPurchaseInfo().catch((error) => {
  console.error("No se pudo aplicar la liga de compra en Más info (vista pública):", error);
});
