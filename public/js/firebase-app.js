import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// En Compras instalamos primero la capa de rendimiento.
// El "await" es intencional: evita que compras.js llegue a renderizar miles
// de tarjetas antes de que el render progresivo esté preparado.
if (window.location.pathname.endsWith("compras.html")) {
  try {
    await import("./compras-performance.js");
  } catch (err) {
    // Si por cualquier motivo fallara la optimización, la página conserva
    // el flujo funcional anterior en vez de quedar inutilizable.
    console.error("No se pudo cargar la optimización de Compras:", err);
  }

  import("./compras-status.js")
    .then(() => import("./compras-budget-ui-fix.js"))
    .then(() => import("./compras-request-grouping.js"))
    .then(() => import("./compras-request-progress.js"))
    .then(() => import("./compras-group-batch-actions.js"))
    .then(() => import("./compras-request-stage-tools.js"))
    .then(() => import("./compras-request-wide-requisition.js"))
    .then(() => import("./compras-global-money-charts.js"))
    .then(() => import("./compras-budget-money-charts.js"))
    .then(() => import("./compras-requisition-blue.js"))
    .then(() => import("./compras-filter-shortage-summary.js"))
    .catch(err => {
      console.error("No se pudo cargar el módulo de Compras:", err);
    });
}
