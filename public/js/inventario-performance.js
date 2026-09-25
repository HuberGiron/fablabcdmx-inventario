/*
 * ============================================================================
 * INVENTARIO GENERAL · RENDER PROGRESIVO
 * ============================================================================
 *
 * Mantiene el conjunto filtrado completo dentro de catalogo.js, pero sólo
 * materializa una parte de sus tarjetas en el DOM.
 *
 * Esto NO cambia:
 * - filtros lógicos;
 * - Excel filtrado;
 * - respaldo completo;
 * - carrito;
 * - edición;
 * - datos de Firestore.
 *
 * Sólo reduce DOM e imágenes simultáneas.
 * ============================================================================
 */

const PAGE_SIZE = 36;
const SEARCH_DEBOUNCE_MS = 220;
const SENTINEL_ID = "inventoryProgressiveSentinel";
const STYLE_ID = "inventoryProgressiveStyles";
const CARD_MARKER =
  '<div class="item-card card shadow-sm mb-3" data-item-id="';

const innerHtmlDescriptor =
  Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")
  || Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerHTML");

if (!innerHtmlDescriptor?.get || !innerHtmlDescriptor?.set) {
  throw new Error(
    "El navegador no permite instalar el render progresivo."
  );
}

const nativeInnerHtmlGet = innerHtmlDescriptor.get;
const nativeInnerHtmlSet = innerHtmlDescriptor.set;

let baseEntries = [];
let visibleLimit = PAGE_SIZE;

let bypassItemsInnerHtml = false;
let preserveLimitNextRender = false;
let forceResetNextRender = false;

let sentinelObserver = null;
let searchTimer = null;

function splitCards(html) {
  const source = String(html || "");
  const positions = [];

  let from = 0;

  while (true) {
    const index = source.indexOf(
      CARD_MARKER,
      from
    );

    if (index < 0) break;

    positions.push(index);
    from = index + CARD_MARKER.length;
  }

  if (!positions.length) return [];

  const entries = [];

  for (let index = 0; index < positions.length; index += 1) {
    const start = positions[index];

    const end =
      index + 1 < positions.length
        ? positions[index + 1]
        : source.length;

    const cardHtml =
      source.slice(start, end).trim();

    const idMatch =
      cardHtml.match(
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

function sameIdSet(nextEntries) {
  if (
    nextEntries.length
    !== baseEntries.length
  ) {
    return false;
  }

  const previousIds =
    new Set(
      baseEntries.map(entry => entry.id)
    );

  return nextEntries.every(entry =>
    previousIds.has(entry.id)
  );
}

function setNativeInnerHtml(element, value) {
  bypassItemsInnerHtml = true;

  try {
    nativeInnerHtmlSet.call(
      element,
      value
    );
  } finally {
    bypassItemsInnerHtml = false;
  }
}

function progressHtml(rendered, total) {
  if (
    total <= 0
    || rendered >= total
  ) {
    return "";
  }

  const next =
    Math.min(
      PAGE_SIZE,
      total - rendered
    );

  return `
    <div id="${SENTINEL_ID}"
         class="inventory-progressive-sentinel"
         data-rendered="${rendered}"
         data-total="${total}">
      <strong>
        Mostrando ${rendered} de ${total} resultados
      </strong>
      <span>
        Al seguir bajando se cargarán automáticamente
        ${next} más.
      </span>
    </div>`;
}

function renderProgressive(
  itemsList,
  entries
) {
  const total = entries.length;

  const rendered =
    Math.min(
      visibleLimit,
      total
    );

  const cardsHtml =
    entries
      .slice(0, rendered)
      .map(entry =>
        lazyCardHtml(entry.html)
      )
      .join("");

  setNativeInnerHtml(
    itemsList,
    cardsHtml
      + progressHtml(
        rendered,
        total
      )
  );

  queueMicrotask(
    setupSentinelObserver
  );
}

function handleItemsListHtml(
  itemsList,
  value
) {
  const source =
    String(value || "");

  // Estados vacíos u otro contenido no relacionado con tarjetas.
  if (
    !source.includes(CARD_MARKER)
  ) {
    baseEntries = [];
    visibleLimit = PAGE_SIZE;

    setNativeInnerHtml(
      itemsList,
      source
    );

    if (sentinelObserver) {
      sentinelObserver.disconnect();
    }

    return;
  }

  const nextEntries =
    splitCards(source);

  const preserve =
    preserveLimitNextRender
    || sameIdSet(nextEntries);

  baseEntries = nextEntries;

  if (
    forceResetNextRender
    || !preserve
  ) {
    visibleLimit = PAGE_SIZE;
  }

  preserveLimitNextRender = false;
  forceResetNextRender = false;

  renderProgressive(
    itemsList,
    baseEntries
  );
}

Object.defineProperty(
  Element.prototype,
  "innerHTML",
  {
    configurable:
      innerHtmlDescriptor.configurable,

    enumerable:
      innerHtmlDescriptor.enumerable,

    get: function getInnerHtml() {
      return nativeInnerHtmlGet.call(this);
    },

    set: function setInnerHtml(value) {
      if (
        !bypassItemsInnerHtml
        && this?.id === "itemsList"
        && typeof value === "string"
      ) {
        handleItemsListHtml(
          this,
          value
        );

        return;
      }

      nativeInnerHtmlSet.call(
        this,
        value
      );
    },
  }
);

function triggerCatalogRerender({
  preserveLimit = false,
  resetLimit = false,
} = {}) {
  preserveLimitNextRender =
    preserveLimit;

  forceResetNextRender =
    resetLimit;

  // sortMode ya tiene un listener "input" en catalogo.js.
  // Reutilizarlo permite volver a renderizar sin duplicar la lógica
  // privada de filtrado del catálogo.
  const sort =
    document.querySelector(
      "#sortMode"
    );

  if (sort) {
    const event =
      new Event(
        "input",
        {
          bubbles: true,
        }
      );

    event.__inventoryPerformanceReplay =
      true;

    sort.dispatchEvent(event);
    return;
  }

  const search =
    document.querySelector(
      "#search"
    );

  if (search) {
    const event =
      new Event(
        "input",
        {
          bubbles: true,
        }
      );

    event.__inventoryPerformanceReplay =
      true;

    search.dispatchEvent(event);
  }
}

function loadNextBatch() {
  if (
    visibleLimit
    >= baseEntries.length
  ) {
    return;
  }

  visibleLimit =
    Math.min(
      visibleLimit + PAGE_SIZE,
      baseEntries.length
    );

  triggerCatalogRerender({
    preserveLimit: true,
  });
}

function setupSentinelObserver() {
  if (
    !("IntersectionObserver" in window)
  ) {
    return;
  }

  if (!sentinelObserver) {
    sentinelObserver =
      new IntersectionObserver(
        entries => {
          const visible =
            entries.some(
              entry =>
                entry.isIntersecting
            );

          if (!visible) return;

          loadNextBatch();
        },
        {
          root: null,

          // Empieza a cargar antes de que el usuario llegue al final.
          rootMargin: "650px 0px",

          threshold: 0.01,
        }
      );
  }

  sentinelObserver.disconnect();

  const sentinel =
    document.querySelector(
      `#${SENTINEL_ID}`
    );

  if (sentinel) {
    sentinelObserver.observe(
      sentinel
    );
  }
}

function scheduleSearch(input) {
  clearTimeout(searchTimer);

  searchTimer =
    window.setTimeout(
      () => {
        forceResetNextRender = true;

        const event =
          new Event(
            "input",
            {
              bubbles: true,
            }
          );

        event.__inventoryPerformanceReplay =
          true;

        input.dispatchEvent(event);
      },
      SEARCH_DEBOUNCE_MS
    );
}

// Evita que catalogo.js filtre/renderice por CADA tecla.
document.addEventListener(
  "input",
  event => {
    const target =
      event.target;

    if (
      target?.id === "search"
      && !event.__inventoryPerformanceReplay
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();

      scheduleSearch(target);
      return;
    }

    // Un cambio de orden debe volver a empezar desde la parte superior
    // del nuevo orden.
    if (
      target?.id === "sortMode"
      && !event.__inventoryPerformanceReplay
    ) {
      forceResetNextRender = true;
    }
  },
  true
);

// En estos filtros el conjunto lógico cambia.
// Normalmente el cambio de IDs ya reinicia el lote por sí solo;
// esta marca cubre también filtros cuyo resultado casualmente tenga
// la misma cantidad/conjunto.
document.addEventListener(
  "change",
  event => {
    const target =
      event.target;

    if (
      target?.matches?.(
        "#filterZone, "
        + "#filterSubzone, "
        + "#filterLocation, "
        + "#filterRelatedMachine, "
        + "#filterWeek, "
        + ".tipo-check"
      )
    ) {
      forceResetNextRender = true;
    }
  },
  true
);

document.addEventListener(
  "click",
  event => {
    if (
      event.target?.closest?.(
        "#clearFilters, "
        + "#selectAllTypes, "
        + "#clearTypeFilters"
      )
    ) {
      forceResetNextRender = true;
    }
  },
  true
);

function injectStyles() {
  if (
    document.querySelector(
      `#${STYLE_ID}`
    )
  ) {
    return;
  }

  const style =
    document.createElement("style");

  style.id = STYLE_ID;

  style.textContent = `
    .inventory-progressive-sentinel {
      display:flex;
      flex-direction:column;
      align-items:center;
      justify-content:center;
      gap:.15rem;
      margin:.75rem 0 1.5rem;
      padding:.8rem 1rem;
      color:#6c757d;
      font-size:.86rem;
      text-align:center;
    }

    .inventory-progressive-sentinel strong {
      color:#343a40;
      font-weight:650;
    }
  `;

  document.head.appendChild(style);
}

injectStyles();
