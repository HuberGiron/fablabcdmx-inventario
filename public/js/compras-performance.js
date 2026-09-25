import {
  collection,
  getDocs,
  getDocsFromCache,
  getFirestore,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import {
  getAuth,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

/*
 * ============================================================================
 * COMPRAS · RENDER PROGRESIVO
 * ============================================================================
 *
 * Objetivo:
 * - conservar TODO el conjunto filtrado en memoria;
 * - materializar sólo una ventana pequeña de tarjetas en el DOM;
 * - cargar más conforme el usuario hace scroll;
 * - mantener totales, PDF, Excel y operaciones masivas sobre el conjunto
 *   lógico completo, no únicamente sobre las tarjetas dibujadas.
 *
 * No modifica Firestore ni la estructura de datos.
 * ============================================================================
 */

const PAGE_SIZE = 36;
const SEARCH_DEBOUNCE_MS = 220;
const SENTINEL_ID = "purchaseProgressiveSentinel";
const STYLE_ID = "purchaseProgressiveStyles";
const CARD_MARKER = '<div class="item-card card shadow-sm mb-3" data-item-id="';

const db = getFirestore();
const auth = getAuth();

const itemsById = new Map();

let itemsReady = false;
let itemsLoadPromise = null;

let baseEntries = [];
let logicalEntriesCache = [];
let visibleLimit = PAGE_SIZE;

let preserveLimitNextRender = false;
let forceResetNextRender = false;
let bypassItemsInnerHtml = false;
let operationMaterialized = false;
let bulkMaterialized = false;

let sentinelObserver = null;
let resultCountObserver = null;
let searchTimer = null;
let refreshTimer = null;
let restoringTimer = null;
let lastBaseIdSetKey = "";
let replayExport = false;

const innerHtmlDescriptor =
  Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")
  || Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerHTML");

if (!innerHtmlDescriptor?.get || !innerHtmlDescriptor?.set) {
  throw new Error("El navegador no permite instalar el render progresivo.");
}

const nativeInnerHtmlGet = innerHtmlDescriptor.get;
const nativeInnerHtmlSet = innerHtmlDescriptor.set;

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function currentInventory(item) {
  return num(item?.stockAlmacen) + num(item?.stockPrestadoTemporal);
}

function purchaseStateKey(item) {
  if (!item) return "missing";

  const current = currentInventory(item);
  const desired = num(item.inventarioDeseado);
  const pending = Math.max(num(item.purchasePendingQty), 0);
  const requisition = Math.min(
    Math.max(num(item.purchaseRequisitionQty), 0),
    pending
  );

  if (pending > 0 && requisition > 0) return "requisition";
  if (pending > 0) return "ordered";
  if (Math.max(desired - current, 0) <= 0) return "complete";
  return "missing";
}

function itemPriority(item) {
  const value = Number(item?.purchasePriority);
  return [1, 2, 3].includes(value) ? value : 3;
}

function selectedValues(selector, fallback) {
  const checks = [...document.querySelectorAll(selector)];

  if (!checks.length) {
    return new Set(fallback);
  }

  return new Set(
    checks
      .filter(check => check.checked)
      .map(check => String(check.value))
  );
}

function currentStatusFilters() {
  return selectedValues(
    "#filterPurchaseStatusGroup .purchase-status-check",
    ["missing", "ordered", "requisition", "complete"]
  );
}

function currentPriorityFilters() {
  return selectedValues(
    "#filterPurchasePriorityGroup .purchase-priority-check",
    ["1", "2", "3"]
  );
}

function passesExtraFilters(item) {
  if (!item) {
    // Mientras la caché termina de llegar no ocultamos resultados.
    return !itemsReady;
  }

  const statuses = currentStatusFilters();
  const priorities = currentPriorityFilters();

  return (
    statuses.has(purchaseStateKey(item))
    && priorities.has(String(itemPriority(item)))
  );
}

function escapeAttribute(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function splitCards(html) {
  const source = String(html || "");
  const positions = [];

  let from = 0;

  while (true) {
    const index = source.indexOf(CARD_MARKER, from);
    if (index < 0) break;

    positions.push(index);
    from = index + CARD_MARKER.length;
  }

  if (!positions.length) return [];

  const entries = [];

  for (let i = 0; i < positions.length; i += 1) {
    const start = positions[i];
    const end = i + 1 < positions.length
      ? positions[i + 1]
      : source.length;

    const cardHtml = source.slice(start, end).trim();

    const idMatch = cardHtml.match(
      /data-item-id="([^"]+)"/
    );

    if (!idMatch) continue;

    entries.push({
      id: idMatch[1],
      html: cardHtml,
    });
  }

  return entries;
}

function lazyCardHtml(html) {
  return String(html).replace(
    /<img\s+(?![^>]*\bloading=)/gi,
    '<img loading="lazy" decoding="async" fetchpriority="low" '
  );
}

function logicalEntries() {
  let rows = baseEntries.filter(entry => {
    const item = itemsById.get(entry.id);
    return passesExtraFilters(item);
  });

  const sortMode =
    document.querySelector("#sortMode")?.value || "zone";

  if (sortMode === "priority" && itemsReady) {
    rows = [...rows].sort((a, b) => {
      const ia = itemsById.get(a.id);
      const ib = itemsById.get(b.id);

      return (
        itemPriority(ia) - itemPriority(ib)
        || String(ia?.nombre || "").localeCompare(
          String(ib?.nombre || ""),
          "es",
          {
            sensitivity: "base",
            numeric: true,
          }
        )
      );
    });
  }

  logicalEntriesCache = rows;
  return rows;
}

function logicalItems() {
  return logicalEntries()
    .map(entry => itemsById.get(entry.id))
    .filter(Boolean);
}

function logicalIdSetKey(entries) {
  // Sólo se usa para decidir si un filtro base cambió realmente.
  return entries.map(entry => entry.id).join("|");
}

function progressHtml(rendered, total) {
  if (total <= 0) return "";

  const remaining = Math.max(total - rendered, 0);

  return `
    <div id="${SENTINEL_ID}"
         class="purchase-progressive-sentinel"
         data-rendered="${rendered}"
         data-total="${total}">

      <div class="purchase-progressive-meta">
        <strong>Mostrando ${rendered} de ${total} resultados</strong>
        ${
          remaining > 0
            ? `<span>Desplázate para cargar ${Math.min(PAGE_SIZE, remaining)} más.</span>`
            : `<span>Todos los resultados del filtro están cargados.</span>`
        }
      </div>
    </div>`;
}

function setNativeInnerHtml(element, value) {
  bypassItemsInnerHtml = true;

  try {
    nativeInnerHtmlSet.call(element, value);
  } finally {
    bypassItemsInnerHtml = false;
  }
}

function updateLogicalCounter() {
  const resultCount = document.querySelector("#resultCount");
  if (!resultCount) return;

  const total = logicalEntriesCache.length;

  const expected =
    `${total} resultado${total === 1 ? "" : "s"}`;

  if (resultCount.textContent !== expected) {
    resultCount.textContent = expected;
  }
}

function dispatchLogicalChanged() {
  const entries = logicalEntriesCache;

  document.dispatchEvent(
    new CustomEvent(
      "purchase:logical-filter-changed",
      {
        detail: {
          total: entries.length,
          rendered: Math.min(
            visibleLimit,
            entries.length
          ),
          itemIds: entries.map(entry => entry.id),
        },
      }
    )
  );
}

function setupSentinelObserver() {
  if (!("IntersectionObserver" in window)) return;

  if (!sentinelObserver) {
    sentinelObserver = new IntersectionObserver(
      entries => {
        const hit = entries.some(entry => entry.isIntersecting);
        if (!hit) return;

        const total = logicalEntriesCache.length;

        if (
          !operationMaterialized
          && !bulkMaterialized
          && visibleLimit < total
        ) {
          requestMore();
        }
      },
      {
        root: null,
        rootMargin: "650px 0px",
        threshold: 0.01,
      }
    );
  }

  sentinelObserver.disconnect();

  const sentinel = document.querySelector(
    `#${SENTINEL_ID}`
  );

  if (sentinel) {
    sentinelObserver.observe(sentinel);
  }
}

function ensureResultCountObserver() {
  const resultCount = document.querySelector("#resultCount");
  if (!resultCount || resultCountObserver) return;

  resultCountObserver = new MutationObserver(() => {
    queueMicrotask(updateLogicalCounter);
  });

  resultCountObserver.observe(
    resultCount,
    {
      childList: true,
      characterData: true,
      subtree: true,
    }
  );
}

function renderProgressive(itemsList, entries) {
  const total = entries.length;
  const rendered = Math.min(visibleLimit, total);

  const html = entries
    .slice(0, rendered)
    .map(entry => lazyCardHtml(entry.html))
    .join("");

  setNativeInnerHtml(
    itemsList,
    html + progressHtml(rendered, total)
  );

  logicalEntriesCache = entries;

  queueMicrotask(() => {
    updateLogicalCounter();
    ensureResultCountObserver();
    setupSentinelObserver();
    dispatchLogicalChanged();

    document.dispatchEvent(
      new CustomEvent(
        "purchase:render-batch",
        {
          detail: {
            total,
            rendered,
          },
        }
      )
    );
  });
}

function sameIdSet(nextEntries) {
  if (nextEntries.length !== baseEntries.length) return false;

  const previous = new Set(baseEntries.map(entry => entry.id));

  for (const entry of nextEntries) {
    if (!previous.has(entry.id)) return false;
  }

  return true;
}

function handleItemsListHtml(itemsList, html) {
  const source = String(html || "");

  if (!source.includes(CARD_MARKER)) {
    baseEntries = [];
    logicalEntriesCache = [];
    visibleLimit = PAGE_SIZE;

    setNativeInnerHtml(itemsList, source);

    queueMicrotask(() => {
      updateLogicalCounter();
      dispatchLogicalChanged();
    });

    return;
  }

  const entries = splitCards(source);
  const keepLimit =
    preserveLimitNextRender
    || sameIdSet(entries);

  baseEntries = entries;

  const nextSetKey = logicalIdSetKey(entries);

  if (
    forceResetNextRender
    || (!keepLimit && nextSetKey !== lastBaseIdSetKey)
  ) {
    visibleLimit = PAGE_SIZE;
  }

  lastBaseIdSetKey = nextSetKey;
  preserveLimitNextRender = false;
  forceResetNextRender = false;

  if (operationMaterialized || bulkMaterialized) {
    const rows = logicalEntries();
    const fullHtml = rows
      .map(entry => lazyCardHtml(entry.html))
      .join("");

    setNativeInnerHtml(itemsList, fullHtml);
    logicalEntriesCache = rows;

    queueMicrotask(() => {
      updateLogicalCounter();
      dispatchLogicalChanged();
    });

    return;
  }

  renderProgressive(
    itemsList,
    logicalEntries()
  );
}

Object.defineProperty(
  Element.prototype,
  "innerHTML",
  {
    configurable: innerHtmlDescriptor.configurable,
    enumerable: innerHtmlDescriptor.enumerable,
    get: function getInnerHtml() {
      return nativeInnerHtmlGet.call(this);
    },
    set: function setInnerHtml(value) {
      if (
        !bypassItemsInnerHtml
        && this?.id === "itemsList"
        && typeof value === "string"
      ) {
        handleItemsListHtml(this, value);
        return;
      }

      nativeInnerHtmlSet.call(this, value);
    },
  }
);

function triggerBaseRerender({
  preserveLimit = false,
  resetLimit = false,
} = {}) {
  preserveLimitNextRender = preserveLimit;
  forceResetNextRender = resetLimit;

  const sort = document.querySelector("#sortMode");

  if (sort) {
    const event = new Event(
      "input",
      {
        bubbles: true,
      }
    );

    event.__purchasePerformanceReplay = true;
    sort.dispatchEvent(event);
    return;
  }

  // Fallback si todavía no existe el selector.
  const search = document.querySelector("#search");

  if (search) {
    const event = new Event(
      "input",
      {
        bubbles: true,
      }
    );

    event.__purchasePerformanceReplay = true;
    search.dispatchEvent(event);
  }
}

function requestMore() {
  const total = logicalEntriesCache.length;

  if (visibleLimit >= total) return;

  visibleLimit = Math.min(
    visibleLimit + PAGE_SIZE,
    total
  );

  triggerBaseRerender({
    preserveLimit: true,
  });
}

function materializeAll() {
  const itemsList = document.querySelector("#itemsList");
  if (!itemsList) return;

  const rows = logicalEntries();

  logicalEntriesCache = rows;

  setNativeInnerHtml(
    itemsList,
    rows
      .map(entry => lazyCardHtml(entry.html))
      .join("")
  );

  updateLogicalCounter();

  document.dispatchEvent(
    new CustomEvent(
      "purchase:materialized-all",
      {
        detail: {
          total: rows.length,
        },
      }
    )
  );
}

function restoreProgressive({
  delay = 0,
} = {}) {
  clearTimeout(restoringTimer);

  restoringTimer = window.setTimeout(
    () => {
      if (bulkMaterialized) return;

      operationMaterialized = false;

      visibleLimit = Math.max(
        PAGE_SIZE,
        Math.min(
          visibleLimit,
          logicalEntriesCache.length || PAGE_SIZE
        )
      );

      triggerBaseRerender({
        preserveLimit: true,
      });
    },
    delay
  );
}

function allCardsDecorated() {
  const cards = [
    ...document.querySelectorAll(
      "#itemsList .item-card[data-item-id]"
    ),
  ];

  if (!cards.length) return true;

  // compras-status agrega este bloque al decorar cada tarjeta.
  return cards.every(card =>
    Boolean(
      card.querySelector(".purchase-status-controls")
    )
  );
}

function waitForDecoration({
  timeoutMs = 6500,
} = {}) {
  const started = performance.now();

  return new Promise(resolve => {
    const poll = () => {
      if (
        allCardsDecorated()
        || performance.now() - started >= timeoutMs
      ) {
        resolve();
        return;
      }

      window.setTimeout(poll, 45);
    };

    poll();
  });
}

async function replayExportClick(button) {
  await waitForDecoration();

  replayExport = true;

  try {
    button.click();
  } finally {
    replayExport = false;
  }

  restoreProgressive({
    delay: 900,
  });
}

function exportSelector(target) {
  return target.closest(
    "#exportXlsx, "
    + "#exportPurchaseReport, "
    + "#exportPurchasePdf"
  );
}

function scheduleSearchReplay(input) {
  clearTimeout(searchTimer);

  searchTimer = window.setTimeout(
    () => {
      forceResetNextRender = true;

      const event = new Event(
        "input",
        {
          bubbles: true,
        }
      );

      event.__purchasePerformanceReplay = true;
      input.dispatchEvent(event);
    },
    SEARCH_DEBOUNCE_MS
  );
}

function refreshLogicalAfterExtraFilter() {
  forceResetNextRender = true;

  window.setTimeout(
    () => {
      triggerBaseRerender({
        resetLimit: true,
      });
    },
    0
  );
}

function refreshItemCacheAfterMutation(delay = 900) {
  clearTimeout(refreshTimer);

  refreshTimer = window.setTimeout(
    async () => {
      await loadItems({
        force: true,
      });

      triggerBaseRerender({
        preserveLimit: true,
      });
    },
    delay
  );
}

document.addEventListener(
  "input",
  event => {
    const target = event.target;

    if (
      target?.id === "search"
      && !event.__purchasePerformanceReplay
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();

      scheduleSearchReplay(target);
    }
  },
  true
);

document.addEventListener(
  "change",
  event => {
    const target = event.target;

    if (
      target?.matches?.(
        ".purchase-status-check, "
        + ".purchase-priority-check"
      )
    ) {
      refreshLogicalAfterExtraFilter();
      return;
    }

    if (
      target?.matches?.(
        ".purchase-priority-select"
      )
    ) {
      const itemId =
        String(target.dataset.id || "");

      const item = itemsById.get(itemId);

      if (item) {
        item.purchasePriority =
          Number(target.value) || 3;
      }

      refreshItemCacheAfterMutation(700);
      return;
    }

    if (
      target?.id === "bulkSelectVisible"
      && !bulkMaterialized
    ) {
      // "Todos los visibles" debe significar todos los resultados lógicos
      // del filtro, no sólo la primera ventana renderizada.
      bulkMaterialized = true;
      materializeAll();

      // La lógica original de compras-status continuará procesando
      // este mismo evento y verá el conjunto completo.
    }
  },
  true
);

document.addEventListener(
  "click",
  event => {
    const target = event.target;

    const exportButton = exportSelector(target);

    if (
      exportButton
      && !replayExport
      && !operationMaterialized
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();

      operationMaterialized = true;
      materializeAll();

      void replayExportClick(exportButton);
      return;
    }
    if (
      target?.closest?.("#clearFilters")
    ) {
      forceResetNextRender = true;

      window.setTimeout(
        () => triggerBaseRerender({
          resetLimit: true,
        }),
        35
      );

      return;
    }

    if (
      target?.closest?.(
        "#bulkClearSelection"
      )
    ) {
      bulkMaterialized = false;
      restoreProgressive({
        delay: 120,
      });
      return;
    }

    if (
      target?.closest?.(
        "#bulkAddSelected"
      )
    ) {
      // Dejamos el conjunto materializado durante el guardado.
      // Después se restaura automáticamente.
      window.setTimeout(
        () => {
          bulkMaterialized = false;
          restoreProgressive();
        },
        4200
      );

      return;
    }

    if (
      target?.closest?.(
        ".request-line-receive, "
        + ".request-line-cancel, "
        + ".request-line-requisition, "
        + ".group-batch-receive, "
        + ".group-batch-requisition, "
        + "#purchaseGroupBatchSave, "
        + "#requestWideRequisitionSave, "
        + ".purchase-add-request-btn"
      )
    ) {
      refreshItemCacheAfterMutation(1500);
    }
  },
  true
);

document.addEventListener(
  "visibilitychange",
  () => {
    if (document.visibilityState === "visible") {
      refreshItemCacheAfterMutation(250);
    }
  }
);

function injectStyles() {
  if (document.querySelector(`#${STYLE_ID}`)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;

  style.textContent = `
    .purchase-progressive-sentinel {
      display:flex;
      flex-wrap:wrap;
      align-items:center;
      justify-content:center;
      gap:.75rem 1.25rem;
      margin:1rem 0 2rem;
      padding:1rem 1.25rem;
      border:1px solid #dee2e6;
      border-radius:.75rem;
      background:#fafafa;
      text-align:center;
    }

    .purchase-progressive-meta {
      display:flex;
      flex-direction:column;
      gap:.15rem;
      color:#6c757d;
      font-size:.88rem;
    }

    .purchase-progressive-meta strong {
      color:#343a40;
    }
  `;

  document.head.appendChild(style);
}

async function loadItems({
  force = false,
} = {}) {
  if (
    itemsLoadPromise
    && !force
  ) {
    return itemsLoadPromise;
  }

  if (
    itemsReady
    && !force
  ) {
    return;
  }

  const itemsQuery = query(
    collection(db, "items"),
    where("activo", "==", true)
  );

  itemsLoadPromise = (async () => {
    let snapshot = null;

    // Primero intentamos reutilizar lo que compras.js / compras-status
    // hayan dejado en la caché local del SDK.
    try {
      snapshot = await getDocsFromCache(
        itemsQuery
      );
    } catch (_) {
      snapshot = null;
    }

    if (
      !snapshot
      || snapshot.empty
    ) {
      snapshot = await getDocs(
        itemsQuery
      );
    }

    itemsById.clear();

    snapshot.docs.forEach(itemDoc => {
      itemsById.set(
        itemDoc.id,
        {
          id: itemDoc.id,
          ...itemDoc.data(),
        }
      );
    });

    itemsReady = true;

    if (baseEntries.length) {
      triggerBaseRerender({
        preserveLimit: true,
      });
    }

    document.dispatchEvent(
      new CustomEvent(
        "purchase:item-cache-ready",
        {
          detail: {
            total: itemsById.size,
          },
        }
      )
    );
  })();

  try {
    await itemsLoadPromise;
  } catch (error) {
    console.warn(
      "No se pudo preparar la caché de rendimiento de Compras:",
      error
    );
  } finally {
    itemsLoadPromise = null;
  }
}

function beginItemLoadWhenAuthenticated() {
  let settled = false;

  const unsubscribe = onAuthStateChanged(
    auth,
    user => {
      if (settled) return;

      settled = true;
      unsubscribe();

      if (!user) return;

      // Damos oportunidad a compras.js / compras-status de llenar
      // primero la caché del SDK y así evitar otra descarga completa.
      window.setTimeout(
        () => {
          void loadItems();
        },
        650
      );
    }
  );
}

window.__purchasePerformance = {
  getLogicalItemIds() {
    return logicalEntries()
      .map(entry => entry.id);
  },

  getLogicalItems() {
    return logicalItems();
  },

  getItem(itemId) {
    return itemsById.get(
      String(itemId || "")
    ) || null;
  },

  getAllItems() {
    return [...itemsById.values()];
  },

  getRenderedCount() {
    return document.querySelectorAll(
      "#itemsList .item-card[data-item-id]"
    ).length;
  },

  getLogicalCount() {
    return logicalEntries().length;
  },

  refreshItems() {
    return loadItems({
      force: true,
    });
  },

  materializeAll,
  restoreProgressive,
};

injectStyles();
beginItemLoadWhenAuthenticated();
