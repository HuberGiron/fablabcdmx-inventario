import { auth } from "./firebase-app.js";
import { getUserProfile } from "./common.js";

/*
  Corrección puntual del modal "Cambiar precio".

  compras-request-stage-tools.js ya realiza correctamente la parte financiera:
  - actualiza unitPrice;
  - si la línea está requisitioned, actualiza también requisitionUnitCost;
  - no modifica actualCostTotal de las piezas ya recibidas.

  El problema era de estado de UI: después de guardar una vez, el botón
  #requestPriceModalSave quedaba disabled y el mismo modal se reutilizaba.
  Por eso una operación posterior podía mostrar el nuevo precio pero no permitir
  guardar.

  Este módulo se carga inmediatamente después de compras-request-stage-tools.js
  y no altera las reglas de seguridad: sólo Admin puede modificar precios.
*/

const MODAL_ID = "purchaseRequestPriceModal";
const SAVE_ID = "requestPriceModalSave";

let isAdmin = false;

async function resolveRole() {
  const user = auth.currentUser;
  if (!user) return "";

  try {
    const profile = await getUserProfile(user.uid);
    return profile?.appRole || profile?.role || "";
  } catch (error) {
    console.warn("No se pudo validar el rol para precio de requisición:", error);
    return "";
  }
}

function resetSaveButton(modal) {
  if (!isAdmin || !modal) return;

  const save = modal.querySelector(`#${SAVE_ID}`);
  if (!save) return;

  save.disabled = false;
  save.removeAttribute("aria-disabled");
  save.textContent = "Guardar precios";
}

function clarifyRequisitionPriceUi(modal) {
  if (!isAdmin || !modal) return;

  const header = modal.querySelector(".request-price-table thead tr");
  if (header) {
    const cells = header.querySelectorAll("th");
    if (cells[4]) cells[4].textContent = "Precio confirmado";
  }

  const footerNote = modal.querySelector(".modal-footer .me-auto.small.text-muted");
  if (footerNote) {
    footerNote.textContent =
      "El precio confirmado por Compras sustituye el precio vigente de las piezas pendientes. "
      + "Si el SKU ya está en requisición, actualiza el compromiso presupuestal. "
      + "Lo ya recibido conserva su costo real.";
  }
}

function refreshBudgetIfOpen() {
  const budgetPanel = document.querySelector("#purchaseBudgetsPanel");
  if (!budgetPanel?.classList.contains("show")) return;

  const refresh = document.querySelector("#refreshPurchaseBudgets");
  if (refresh && !refresh.disabled) {
    window.setTimeout(() => refresh.click(), 150);
  }
}

function attachToModal(modal) {
  if (!modal || modal.dataset.priceRequisitionFixAttached === "1") return;
  modal.dataset.priceRequisitionFixAttached = "1";

  modal.addEventListener("show.bs.modal", () => {
    resetSaveButton(modal);
    // La tabla se vuelve a construir cada vez que abre el modal.
    window.setTimeout(() => clarifyRequisitionPriceUi(modal), 0);
  });

  modal.addEventListener("shown.bs.modal", () => {
    resetSaveButton(modal);
    clarifyRequisitionPriceUi(modal);
  });

  modal.addEventListener("hidden.bs.modal", () => {
    // Si Presupuestos está abierto, recalcula la vista después de un cambio.
    refreshBudgetIfOpen();
  });

  modal.addEventListener("input", event => {
    if (!event.target.matches(".request-price-input")) return;
    resetSaveButton(modal);
  });

  resetSaveButton(modal);
  clarifyRequisitionPriceUi(modal);
}

function observeModal() {
  const existing = document.querySelector(`#${MODAL_ID}`);
  if (existing) attachToModal(existing);

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;

        if (node.id === MODAL_ID) {
          attachToModal(node);
          continue;
        }

        const modal = node.querySelector?.(`#${MODAL_ID}`);
        if (modal) attachToModal(modal);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

async function init() {
  const role = await resolveRole();
  isAdmin = role === "admin";

  if (!isAdmin) return;

  observeModal();
}

init().catch(error => {
  console.error("No se pudo activar la corrección de precio en requisición:", error);
});
