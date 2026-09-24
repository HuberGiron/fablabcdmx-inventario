const STYLE_ID = "purchaseRequisitionBlueStyles";

if (!document.querySelector(`#${STYLE_ID}`)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;

  style.textContent = `
    /* Estado REQUISICIÓN: azul fijo, independiente del color "primary"
       personalizado por la identidad visual del sitio. */

    #purchaseStatusLegend .badge.text-bg-primary,
    .purchase-state-requisition .badge.text-bg-primary {
      background-color: #0d6efd !important;
      border-color: #0d6efd !important;
      color: #ffffff !important;
    }

    .purchase-state-requisition {
      background: #e7f1ff !important;
      border-color: #0d6efd !important;
    }

    .item-card.border-primary {
      border-color: #0d6efd !important;
    }

    /* Si el estado aparece como etiqueta dentro de operaciones agrupadas,
       mantenemos el mismo azul visual. */
    .group-batch-current-stage.is-requisition {
      background: #cfe2ff !important;
      color: #084298 !important;
      border-color: #9ec5fe !important;
    }
  `;

  document.head.appendChild(style);
}
