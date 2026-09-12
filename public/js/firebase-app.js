import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Flujo administrativo específico de la página de Compras.
// La carga es condicional para no afectar al resto de vistas del inventario.
if (window.location.pathname.endsWith("compras.html")) {
  import("./compras-status.js").catch(err => {
    console.error("No se pudo cargar el módulo de estados de compra:", err);
  });
}
