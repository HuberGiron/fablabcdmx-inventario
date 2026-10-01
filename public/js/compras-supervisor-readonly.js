import { auth, db } from "./firebase-app.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// Esta capa NO reemplaza la seguridad de Firestore. Su función es mantener
// limpia la interfaz del Supervisor y evitar que alcance handlers de escritura.
// Las reglas de firebase/firestore.rules son la barrera definitiva.

const BLOCKED_SELECTORS = [
  // Crear/editar borradores de solicitud.
  ".purchase-add-request-btn",
  ".purchase-bulk-checkbox",
  "#bulkSelectVisible",
  "#bulkClearSelection",
  "#bulkAddSelected",
  ".request-draft-edit",
  ".request-draft-empty",
  ".request-draft-send",
  "#purchaseQuantitySave",

  // Mutaciones sobre solicitudes existentes.
  ".request-history-alias-edit",
  ".request-history-cancel",
  ".request-history-delete",
  "#purchaseRequestCancelAll",
  "#purchaseRequestDelete",

  // Requisición, recepción y cancelación de pendientes.
  ".request-line-requisition",
  ".request-line-receive",
  ".request-line-cancel",
  ".group-batch-requisition",
  ".group-batch-receive",
  "#purchaseGroupBatchSave",
  "#purchaseGroupBatchSelectAll",
  "#purchaseGroupBatchClear",
  "#requestWideRequisitionSave",
  "#requestWideSelectAll",
  "#requestWideClearAll",

  // Cambios de precio / datos de compra.
  ".request-group-price",
  "#requestPriceModalSave",
  "#requestPriceSelectAll",
  "#requestPriceClear",

  // Presupuesto autorizado.
  ".budget-save-zone",
  ".purchase-budget-zone-input",
].join(",");

const REMOVE_SELECTORS = [
  ".purchase-bulk-selector",
  "#purchaseBulkToolbar",
  ".purchase-add-request-btn",
  ".request-draft-edit",
  ".request-draft-empty",
  ".request-draft-send",
  ".request-history-alias-edit",
  ".request-history-cancel",
  ".request-history-delete",
  ".request-line-requisition",
  ".request-line-receive",
  ".request-line-cancel",
  ".group-batch-requisition",
  ".group-batch-receive",
  ".request-group-price",
  ".budget-save-zone",
].join(",");

let supervisorMode = false;
let observer = null;

function waitForUser() {
  return new Promise(resolve => {
    const unsubscribe = onAuthStateChanged(auth, user => {
      unsubscribe();
      resolve(user);
    });
  });
}

async function realRoleFor(uid) {
  if (!uid) return "";
  const snapshot = await getDoc(doc(db, "users", uid));
  return snapshot.exists() ? String(snapshot.data()?.role || "") : "";
}

function ensureStyle() {
  if (document.querySelector("#supervisorPurchasesReadOnlyStyles")) return;
  const style = document.createElement("style");
  style.id = "supervisorPurchasesReadOnlyStyles";
  style.textContent = `
    html.purchase-supervisor-readonly .supervisor-readonly-banner {
      border: 1px solid #d7b100;
      border-left: 6px solid #d7b100;
      background: #fff8d8;
      color: #4f4300;
      border-radius: .75rem;
      padding: .8rem 1rem;
      margin: 0 0 1rem;
      font-size: .92rem;
    }
    html.purchase-supervisor-readonly .supervisor-readonly-banner strong {
      color: #2f2900;
    }
    html.purchase-supervisor-readonly #currentDraftPanel {
      display: none !important;
    }
    html.purchase-supervisor-readonly .purchase-budget-zone-input {
      pointer-events: none !important;
    }
  `;
  document.head.appendChild(style);
}

function ensureBanner() {
  if (document.querySelector("#supervisorPurchasesReadOnlyBanner")) return;
  const anchor = document.querySelector(".filter-card")
    || document.querySelector(".purchase-summary-card")
    || document.querySelector("#itemsList");
  if (!anchor?.parentNode) return;

  const banner = document.createElement("div");
  banner.id = "supervisorPurchasesReadOnlyBanner";
  banner.className = "supervisor-readonly-banner";
  banner.innerHTML = `
    <strong>Supervisor de compras · modo sólo lectura.</strong>
    Puedes consultar inventario, estatus, solicitudes, requisiciones, recepciones,
    presupuesto ejercido y exportar reportes. Las modificaciones están deshabilitadas.`;
  anchor.parentNode.insertBefore(banner, anchor);
}

function removeWriteControls(root = document) {
  if (!supervisorMode) return;

  if (root.matches?.(REMOVE_SELECTORS)) root.remove();
  root.querySelectorAll?.(REMOVE_SELECTORS).forEach(element => element.remove());

  // Salvaguardas para modales que podrían haberse abierto justo antes de que
  // entrara esta capa. Los botones quedan inutilizados aunque no se eliminen.
  root.querySelectorAll?.(BLOCKED_SELECTORS).forEach(element => {
    if (element.matches("input, select, textarea, button")) {
      element.disabled = true;
      element.setAttribute("aria-disabled", "true");
    }
  });

  const subtitle = document.querySelector("#purchaseRequestsPanelLabel")?.parentElement?.querySelector(".text-muted.small");
  if (subtitle) subtitle.textContent = "Historial, requisiciones, recepciones y seguimiento de compras.";

  ensureBanner();
}

function blockedTarget(target) {
  if (!(target instanceof Element)) return null;
  return target.closest(BLOCKED_SELECTORS);
}

function stopBlockedInteraction(event) {
  if (!supervisorMode) return;
  const blocked = blockedTarget(event.target);
  if (!blocked) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function stopBlockedSubmit(event) {
  if (!supervisorMode) return;
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (!form.querySelector(BLOCKED_SELECTORS)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

async function initSupervisorReadOnly() {
  const user = await waitForUser();
  if (!user) return;

  const role = await realRoleFor(user.uid);
  if (role !== "supervisor") return;

  supervisorMode = true;
  document.documentElement.classList.add("purchase-supervisor-readonly");
  ensureStyle();
  removeWriteControls(document);

  // Capture phase: bloquea handlers de módulos de Compras aunque una futura
  // actualización vuelva a insertar temporalmente un control de escritura.
  document.addEventListener("click", stopBlockedInteraction, true);
  document.addEventListener("change", stopBlockedInteraction, true);
  document.addEventListener("input", stopBlockedInteraction, true);
  document.addEventListener("submit", stopBlockedSubmit, true);

  observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) removeWriteControls(node);
      }
    }
    ensureBanner();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

initSupervisorReadOnly().catch(error => {
  console.error("No se pudo activar el modo sólo lectura del Supervisor de Compras:", error);
});
