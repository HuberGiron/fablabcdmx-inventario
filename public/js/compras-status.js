import { db } from "./firebase-app.js";
import { waitForUser, getUserProfile } from "./common.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const PURCHASE_STATUS_ORDERED = "ordered";
const PURCHASE_STATUS_RECEIVED = "received";

const itemsById = new Map();
let decorationQueued = false;

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function currentInventory(item) {
  return num(item.stockAlmacen) + num(item.stockPrestadoTemporal);
}

function quantityToBuy(item) {
  return Math.max(num(item.inventarioDeseado) - currentInventory(item), 0);
}

function purchaseVisualState(item) {
  const missing = quantityToBuy(item);

  if (missing <= 0) {
    return {
      key: "complete",
      borderClass: "border-success",
      badgeClass: "text-bg-success",
      label: "Inventario completo",
      missing: 0,
    };
  }

  if (item.purchaseStatus === PURCHASE_STATUS_ORDERED) {
    return {
      key: "ordered",
      borderClass: "border-warning",
      badgeClass: "text-bg-warning",
      label: "En compras",
      missing,
    };
  }

  return {
    key: "missing",
    borderClass: "border-danger",
    badgeClass: "text-bg-danger",
    label: "Faltante",
    missing,
  };
}

function pluralPieces(value) {
  return `${value} pieza${Number(value) === 1 ? "" : "s"}`;
}

function statusControlsHtml(item, state) {
  const current = currentInventory(item);
  const desired = num(item.inventarioDeseado);

  if (state.key === "complete") {
    return `
      <div class="d-flex flex-wrap gap-2 align-items-center">
        <span class="badge ${state.badgeClass}">${state.label}</span>
        <span class="small text-muted">Inventario actual: <strong>${current}</strong> / deseado: <strong>${desired}</strong></span>
      </div>`;
  }

  if (state.key === "ordered") {
    const requested = num(item.purchaseRequestedQty) || state.missing;
    return `
      <div class="d-flex flex-wrap gap-2 align-items-center">
        <span class="badge ${state.badgeClass}">${state.label}</span>
        <span class="small text-muted">Faltan ${pluralPieces(state.missing)} · Solicitud enviada: ${pluralPieces(requested)}</span>
        <button type="button" class="btn btn-sm btn-warning purchase-received-btn" data-id="${item.id}">Ya llegó</button>
      </div>`;
  }

  return `
    <div class="d-flex flex-wrap gap-2 align-items-center">
      <span class="badge ${state.badgeClass}">${state.label}</span>
      <span class="small text-muted">Faltan ${pluralPieces(state.missing)} para completar el inventario deseado</span>
      <button type="button" class="btn btn-sm btn-danger purchase-send-btn" data-id="${item.id}">Mandar a comprar</button>
    </div>`;
}

function decorateCard(card) {
  const itemId = card?.dataset?.itemId;
  const item = itemsById.get(itemId);
  if (!item) return;

  const state = purchaseVisualState(item);
  const signature = [
    state.key,
    state.missing,
    currentInventory(item),
    num(item.inventarioDeseado),
    item.purchaseStatus || "",
    num(item.purchaseRequestedQty),
  ].join("|");

  if (card.dataset.purchaseStatusSignature === signature) return;
  card.dataset.purchaseStatusSignature = signature;

  card.classList.remove("border-success", "border-warning", "border-danger", "border-2");
  card.classList.add("border-2", state.borderClass);

  const body = card.querySelector(".card-body");
  if (!body) return;

  let controls = body.querySelector(".purchase-status-controls");
  if (!controls) {
    controls = document.createElement("div");
    controls.className = "purchase-status-controls mt-3 pt-3 border-top";
    const adminActions = body.querySelector(".admin-card-actions");
    if (adminActions) body.insertBefore(controls, adminActions);
    else body.appendChild(controls);
  }

  controls.innerHTML = statusControlsHtml(item, state);
}

function decorateVisibleCards() {
  document.querySelectorAll("#itemsList .item-card[data-item-id]").forEach(decorateCard);
}

function queueDecorations() {
  if (decorationQueued) return;
  decorationQueued = true;
  queueMicrotask(() => {
    decorationQueued = false;
    decorateVisibleCards();
  });
}

function addLegend() {
  if (document.querySelector("#purchaseStatusLegend")) return;
  const itemsList = document.querySelector("#itemsList");
  if (!itemsList?.parentNode) return;

  const legend = document.createElement("div");
  legend.id = "purchaseStatusLegend";
  legend.className = "d-flex flex-wrap gap-2 align-items-center mb-3 small";
  legend.innerHTML = `
    <span class="fw-semibold me-1">Estado:</span>
    <span class="badge text-bg-danger">Falta comprar</span>
    <span class="badge text-bg-warning">En compras</span>
    <span class="badge text-bg-success">Inventario completo</span>`;
  itemsList.parentNode.insertBefore(legend, itemsList);
}

async function fetchLiveItem(itemId) {
  const snapshot = await getDoc(doc(db, "items", itemId));
  if (!snapshot.exists()) throw new Error("El item ya no existe en Firestore.");
  return { id: snapshot.id, ...snapshot.data() };
}

function setButtonBusy(button, busy, busyLabel) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText || button.textContent;
  }
}

async function sendToPurchases(itemId, button) {
  setButtonBusy(button, true, "Guardando...");

  try {
    const item = await fetchLiveItem(itemId);
    const missing = quantityToBuy(item);

    if (missing <= 0) {
      itemsById.set(itemId, item);
      decorateCard(document.querySelector(`.item-card[data-item-id="${CSS.escape(itemId)}"]`));
      alert("Este item ya tiene completo su inventario deseado.");
      return;
    }

    const ok = confirm(
      `¿Marcar como enviado a Compras?\n\n${item.nombre || item.sku || "Item"}\nCantidad faltante: ${pluralPieces(missing)}`
    );
    if (!ok) return;

    await updateDoc(doc(db, "items", itemId), {
      purchaseStatus: PURCHASE_STATUS_ORDERED,
      purchaseRequestedQty: missing,
      purchaseRequestedAt: serverTimestamp(),
      purchaseReceivedAt: null,
      purchaseReceivedQty: null,
      updatedAt: serverTimestamp(),
    });

    itemsById.set(itemId, {
      ...item,
      purchaseStatus: PURCHASE_STATUS_ORDERED,
      purchaseRequestedQty: missing,
    });

    const card = document.querySelector(`.item-card[data-item-id="${CSS.escape(itemId)}"]`);
    if (card) {
      delete card.dataset.purchaseStatusSignature;
      decorateCard(card);
    }
  } catch (error) {
    console.error(error);
    alert(`No se pudo mandar el item a Compras: ${error.message}`);
  } finally {
    setButtonBusy(button, false);
  }
}

async function markAsReceived(itemId, button) {
  setButtonBusy(button, true, "Actualizando...");

  try {
    const item = await fetchLiveItem(itemId);

    if (item.purchaseStatus !== PURCHASE_STATUS_ORDERED) {
      itemsById.set(itemId, item);
      const card = document.querySelector(`.item-card[data-item-id="${CSS.escape(itemId)}"]`);
      if (card) {
        delete card.dataset.purchaseStatusSignature;
        decorateCard(card);
      }
      alert("Este item ya no está marcado como 'En compras'. Se actualizó la tarjeta con el estado actual.");
      return;
    }

    const missing = quantityToBuy(item);
    if (missing <= 0) {
      await updateDoc(doc(db, "items", itemId), {
        purchaseStatus: PURCHASE_STATUS_RECEIVED,
        purchaseReceivedQty: 0,
        purchaseReceivedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      window.location.reload();
      return;
    }

    const ok = confirm(
      `¿Confirmar que ya llegó la compra?\n\n${item.nombre || item.sku || "Item"}\nSe agregarán ${pluralPieces(missing)} al stock de almacén para completar el inventario deseado.`
    );
    if (!ok) return;

    const newWarehouseStock = num(item.stockAlmacen) + missing;

    await updateDoc(doc(db, "items", itemId), {
      stockAlmacen: newWarehouseStock,
      purchaseStatus: PURCHASE_STATUS_RECEIVED,
      purchaseReceivedQty: missing,
      purchaseReceivedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    // Se recarga para que compras.js recalcule también totales, subtotales y reportes.
    window.location.reload();
  } catch (error) {
    console.error(error);
    alert(`No se pudo registrar la recepción de la compra: ${error.message}`);
  } finally {
    setButtonBusy(button, false);
  }
}

function bindPurchaseActions() {
  const itemsList = document.querySelector("#itemsList");
  if (!itemsList) return;

  itemsList.addEventListener("click", event => {
    const sendButton = event.target.closest(".purchase-send-btn");
    if (sendButton) {
      sendToPurchases(sendButton.dataset.id, sendButton);
      return;
    }

    const receivedButton = event.target.closest(".purchase-received-btn");
    if (receivedButton) {
      markAsReceived(receivedButton.dataset.id, receivedButton);
    }
  });
}

function observePurchaseCards() {
  const itemsList = document.querySelector("#itemsList");
  if (!itemsList) return;

  const observer = new MutationObserver(() => queueDecorations());
  observer.observe(itemsList, { childList: true, subtree: true });
}

async function loadAdminItems() {
  const snapshot = await getDocs(
    query(collection(db, "items"), where("activo", "==", true))
  );

  snapshot.docs.forEach(itemDoc => {
    itemsById.set(itemDoc.id, { id: itemDoc.id, ...itemDoc.data() });
  });
}

async function initPurchaseStatusFlow() {
  const user = await waitForUser();
  if (!user) return;

  const profile = await getUserProfile(user.uid);
  if (profile?.role !== "admin") return;

  await loadAdminItems();
  addLegend();
  bindPurchaseActions();
  observePurchaseCards();
  decorateVisibleCards();
}

initPurchaseStatusFlow().catch(error => {
  console.error("No se pudo inicializar el flujo de estados de compra:", error);
});
