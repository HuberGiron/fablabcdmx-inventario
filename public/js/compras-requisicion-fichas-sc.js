/**
 * FabLab IBERO - Información y filtros de requisición en SC y PDF extendido/agrupado.
 * Lee Firestore. No modifica registros ni reemplaza los generadores originales.
 * El resumen financiero de una SC siempre corresponde a la SC COMPLETA.
 */
import { db } from './firebase-app.js';
import { collection, getDocsFromServer } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = v => {const x=Number(v);return Number.isFinite(x)?x:0;};
const simple = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es').replace(/\s+/g,' ').trim();
const currency = l => {try{return new Intl.NumberFormat('es-MX',{style:'currency',currency:String(l.currency||'MXN').toUpperCase()}).format(number(l.requisitionUnitCost??l.unitPrice));}catch{return `${number(l.unitPrice).toFixed(2)} ${l.currency||'MXN'}`;}};
const folio = l => String(l.requisitionNumber||l.externalRequisitionNumber||'').trim();
const dateText = s => /^\d{4}-\d\d-\d\d$/.test(String(s||''))?`${s.slice(8,10)}/${s.slice(5,7)}/${s.slice(0,4)}`:'No registrada';
const prepared = new Map();
let armed=null;

function fetchLines(rid){
  if(!prepared.has(rid)){
    const promise=getDocsFromServer(collection(db,'purchaseRequests',rid,'items'))
      .then(snap=>snap.docs.map(doc=>({id:doc.id,...doc.data()})))
      .catch(error=>{prepared.delete(rid);throw error;});
    prepared.set(rid,promise);
  }
  return prepared.get(rid);
}
function requisitionLines(lines){return lines.filter(l=>l.requisitionStatus==='requisitioned');}
function numbers(lines){return [...new Set(requisitionLines(lines).map(folio))].filter(Boolean).sort((a,b)=>a.localeCompare(b,'es',{numeric:true}));}
function metadata(l){
  const parts=[`<strong>Requisición:</strong> ${esc(folio(l)||'Sin número asignado')}`];
  if(l.externalReportedStatus)parts.push(`<strong>Etapa de Compras:</strong> ${esc(l.externalReportedStatus)}`);
  if(l.externalExpectedDeliveryDate)parts.push(`<strong>Entrega estimada:</strong> ${esc(dateText(l.externalExpectedDeliveryDate))}`);
  if(l.externalPurchaseOrderNumber)parts.push(`<strong>Orden de compra:</strong> ${esc(l.externalPurchaseOrderNumber)}`);
  parts.push(`<strong>Costo vigente:</strong> ${esc(currency(l))}`);
  return parts.join(' · ');
}
function matchSKU(lines,sku,title,area='',used=null){
  let candidates=lines.filter(l=>String(l.sku||'').trim()===sku);
  if(!candidates.length)return null;
  const normTitle=simple(title), normArea=simple(area);
  candidates=candidates.map(l=>({l,score:(simple(l.nombre)===normTitle?100:0)
    +(normTitle.includes(simple(l.nombre))&&l.nombre?25:0)
    +[l.zoneName,l.subzoneName,l.locationName,l.locationCode].filter(Boolean).reduce((n,x)=>n+(normArea.includes(simple(x))?12:0),0)
    -(used?.has(l.id)?500:0)})).sort((a,b)=>b.score-a.score);
  const best=candidates[0]?.l;if(best&&used)used.add(best.id);
  return best||null;
}
function pdfStyles(){return `
 .ibero-req-pdf-meta{border:1px solid #afd1f8;border-left:5px solid #0d6efd;background:#f3f8ff;padding:7px 9px;margin:6px 0;font-size:9pt;line-height:1.45;break-inside:avoid}
 .ibero-req-pdf-filter{display:inline-flex;align-items:center;gap:7px;margin-right:auto;font:13px Arial}
 .ibero-req-pdf-filter select{padding:5px;border:1px solid #9ca7b6;border-radius:5px;max-width:250px}
 .ibero-req-pdf-label{display:inline-block;border:1px solid #98baf5;background:#eff6ff;border-radius:99px;padding:4px 10px;margin:2px;font-size:8pt}
 .ibero-req-pdf-notice{font-size:8pt;color:#5f6872;padding:5px 0}
 .ibero-req-rowmeta{color:#135aaf;display:block;font-size:8pt;white-space:normal}
 @media print{.ibero-req-pdf-filter{display:none!important}}
 `;}
function ensurePdfStyle(doc){if(doc.getElementById('iberoReqPdfStyle'))return;const style=doc.createElement('style');style.id='iberoReqPdfStyle';style.textContent=pdfStyles();doc.head.append(style);}

function enhanceExtended(doc,lines){
  const used=new Set();let matches=0;
  for(const card of doc.querySelectorAll('.request-report-card')){
    const sku=(card.querySelector('.request-report-head .muted')?.textContent||'').split('·')[0].trim();
    const title=card.querySelector('.request-report-head h2')?.textContent||'';
    const l=matchSKU(lines,sku,title,card.querySelector('.area-line')?.textContent||'',used);
    if(!l){card.dataset.iberoReqNums='';continue;}
    card.dataset.iberoReqNums=folio(l);
    if(l.requisitionStatus!=='requisitioned')continue;
    matches++;
    if(!card.querySelector('.ibero-req-pdf-meta')){
      const box=doc.createElement('div');box.className='ibero-req-pdf-meta';box.innerHTML=metadata(l);
      const anchor=card.querySelector('.cost-line')||card.querySelector('.request-report-head');anchor?.insertAdjacentElement('afterend',box);
    }
  }
  return matches;
}
function enhanceGrouped(doc,lines){
  let matches=0;
  for(const card of doc.querySelectorAll('.group-card')){
    const used=new Set(),associated=[],table=card.querySelector('.pdf-breakdown-table');
    for(const row of table?.querySelectorAll('tbody tr')||[]){
      const cells=row.querySelectorAll('td'),sku=cells[0]?.textContent?.trim()||'';
      const area=[...cells].slice(1,4).map(x=>x.textContent).join(' ');
      const l=matchSKU(lines,sku,card.querySelector('.group-head h2')?.textContent||'',area,used);
      if(!l){row.dataset.iberoReqNums='';continue;}
      row.dataset.iberoReqNums=folio(l);
      if(l.requisitionStatus!=='requisitioned')continue;
      associated.push(l);matches++;
      if(!row.querySelector('.ibero-req-rowmeta')){
        const div=doc.createElement('div');div.className='ibero-req-rowmeta';div.textContent=`Req. ${folio(l)||'sin número'} · ${l.externalReportedStatus||'En requisición'}${l.externalExpectedDeliveryDate?' · Entrega '+dateText(l.externalExpectedDeliveryDate):''}`;
        cells[0]?.append(div);
      }
    }
    const keys=[...new Set(associated.map(folio).filter(Boolean))];
    card.dataset.iberoReqNums=keys.join('|');
    if(associated.length&&!card.querySelector('.ibero-req-pdf-meta')){
      const box=doc.createElement('div');box.className='ibero-req-pdf-meta';
      box.innerHTML=`<strong>Requisiciones:</strong> ${esc(keys.join(', ')||'Sin número asignado')} · <strong>Etapas institucionales:</strong> ${esc([...new Set(associated.map(l=>l.externalReportedStatus||'Sin reporte'))].join(', '))} · <strong>Entregas estimadas:</strong> ${esc([...new Set(associated.map(l=>l.externalExpectedDeliveryDate).filter(Boolean).map(dateText))].join(', ')||'No registradas')}`;
      card.querySelector('.group-head')?.insertAdjacentElement('afterend',box);
    }
  }
  return matches;
}
function decoratePdf(doc,lines){
  const extended=doc.querySelectorAll('.request-report-card'),grouped=doc.querySelectorAll('.group-card');
  if(!extended.length&&!grouped.length)return false;
  ensurePdfStyle(doc);
  if(extended.length)enhanceExtended(doc,lines);
  if(grouped.length)enhanceGrouped(doc,lines);
  const nums=numbers(lines), toolbar=doc.querySelector('.toolbar');
  if(!toolbar)return true;
  if(!doc.getElementById('iberoReqPdfSelect')){
    const label=doc.createElement('label');label.className='ibero-req-pdf-filter';
    label.innerHTML=`Requisición: <select id="iberoReqPdfSelect"><option value="">Todas las requisiciones</option>${nums.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select>`;
    toolbar.prepend(label);
    const filters=doc.querySelector('.filters')||doc.querySelector('.page header');
    if(filters){const badge=doc.createElement('span');badge.id='iberoReqPdfActive';badge.className='ibero-req-pdf-label';badge.textContent='Requisiciones: '+(nums.join(', ')||'Sin asignación');filters.append(badge);}
    const summary=doc.querySelector('.summary,.top-summary');
    if(summary&&!doc.getElementById('iberoReqPdfNotice')){const note=doc.createElement('div');note.id='iberoReqPdfNotice';note.className='ibero-req-pdf-notice';note.textContent='Los importes del resumen financiero corresponden a la solicitud de compra completa, incluso si filtras sus fichas por requisición.';summary.insertAdjacentElement('afterend',note);}
    label.querySelector('select').addEventListener('change',event=>{
      const choice=event.target.value;
      for(const card of doc.querySelectorAll('.request-report-card,.group-card')){
        const refs=(card.dataset.iberoReqNums||'').split('|');
        card.hidden=Boolean(choice&&!refs.includes(choice));
        card.style.display=card.hidden?'none':'';
      }
      for(const row of doc.querySelectorAll('.pdf-breakdown-table tbody tr')){
        const refs=(row.dataset.iberoReqNums||'').split('|');row.style.display=choice&&!refs.includes(choice)?'none':'';
      }
      const badge=doc.getElementById('iberoReqPdfActive');if(badge)badge.textContent=choice?'Filtro de requisición: '+choice:'Requisiciones: '+(nums.join(', ')||'Sin asignación');
    });
  }
  return true;
}
function attachPdf(popup,intent){
  const existingPrint=popup.print.bind(popup);
  let printing=false,decorated=false;
  const enhance=async()=>{
    const lines=await intent.promise;
    for(let n=0;n<160;n++){
      if(popup.closed)return false;
      try{if(decoratePdf(popup.document,lines)){decorated=true;return true;}}catch(e){console.warn('Requisiciones PDF:',e);}
      await new Promise(r=>setTimeout(r,100));
    }
    return false;
  };
  popup.print=function(){if(printing)return;printing=true;
    void enhance().catch(e=>{console.warn('Información de requisición no disponible:',e);return false;})
      .then(()=>existingPrint()).finally(()=>{printing=false;});
  };
  void enhance().catch(e=>console.warn('Datos de requisición en PDF:',e));
}
function installPdfHook(){
  document.addEventListener('click',e=>{
    const btn=e.target?.closest?.('.request-history-pdf,#purchaseRequestDetailPdf,.request-history-pdf-grouped,#purchaseRequestDetailPdfGrouped');
    if(!btn)return;
    const rid=String(btn.dataset.requestId||document.querySelector('#purchaseRequestDetailPdf')?.dataset.requestId||'');
    if(!rid)return;
    prepared.delete(rid);
    armed={rid,started:Date.now(),promise:fetchLines(rid)};
  },true);
  const oldOpen=window.open;
  window.open=function(...args){
    const popup=oldOpen.apply(this,args),intent=armed;
    if(popup&&intent&&Date.now()-intent.started<60000&&!String(args[0]||'')){
      armed=null;attachPdf(popup,intent);
    }
    return popup;
  };
}

// Complemento para el DETALLE de una SC (no requiere alterar compras-status.js).
let detailObserver=null,detailSeq=0,detailLines=[],detailRequest='';
function modalMatchRows(body){
 const rows=[...body.querySelectorAll('.request-line-row')];
 const isGrouped=rows.some(r=>r.classList.contains('grouped-request-card'));
 const allNums=numbers(detailLines);
 let touched=false;
 rows.forEach(row=>{
  let linked=[];
  if(row.classList.contains('grouped-request-card')){
    const used=new Set();
    for(const tr of row.querySelectorAll('.grouped-breakdown-table tbody tr')){
      const c=tr.querySelectorAll('td'),sku=c[0]?.textContent?.trim()||'';
      const l=matchSKU(detailLines,sku,row.querySelector('.request-line-title')?.textContent||'',[...c].slice(1,4).map(x=>x.textContent).join(' '),used);
      if(l){tr.dataset.iberoReqNums=folio(l);if(l.requisitionStatus==='requisitioned'){linked.push(l);if(!tr.querySelector('.ibero-req-modal-inline')){const badge=document.createElement('div');badge.className='ibero-req-modal-inline small text-primary';badge.textContent=`Requisición ${folio(l)||'sin número'} · ${l.externalReportedStatus||'Sin seguimiento'}${l.externalExpectedDeliveryDate?' · Entrega '+dateText(l.externalExpectedDeliveryDate):''}`;c[0]?.append(badge);touched=true;}}}
    }
  }else{
    const s=(row.querySelector('.request-line-meta')?.textContent||'').trim().split('·')[0].trim();
    const l=matchSKU(detailLines,s,row.querySelector('.request-line-title')?.textContent||'');
    if(l&&l.requisitionStatus==='requisitioned')linked.push(l);
  }
  row.dataset.iberoReqNums=[...new Set(linked.map(folio).filter(Boolean))].join('|');
  const meta=row.querySelector('.request-line-meta');
  if(meta&&linked.length&&!meta.querySelector('.ibero-req-modal-badge')){
    const div=document.createElement('div');div.className='ibero-req-modal-badge mt-1 small';
    div.innerHTML=linked.map(l=>`<span class="badge text-bg-primary me-1">Req. ${esc(folio(l)||'sin número')}</span> <span class="text-muted">${esc(l.externalReportedStatus||'Sin reporte')} · Entrega ${esc(dateText(l.externalExpectedDeliveryDate))} · ${esc(currency(l))}</span>`).join('<br>');
    meta.append(div);touched=true;
  }
 });
 let picker=body.querySelector('#iberoScReqFilter');
 if(!picker&&allNums.length){
   const wrap=document.createElement('div');wrap.className='d-flex align-items-center flex-wrap gap-2 mb-2 p-2 border rounded';wrap.id='iberoScReqFilterWrap';
   wrap.innerHTML=`<label class="form-label mb-0 fw-semibold" for="iberoScReqFilter">Filtrar por requisición:</label><select id="iberoScReqFilter" class="form-select form-select-sm" style="max-width:300px"><option value="">Todas las requisiciones y artículos</option>${allNums.map(f=>`<option value="${esc(f)}">${esc(f)}</option>`).join('')}</select>`;
   const toolbar=body.querySelector('#requestGroupingToolbar');
   if(toolbar)toolbar.insertAdjacentElement('afterend',wrap);else body.prepend(wrap);
   picker=wrap.querySelector('select');
   picker.value=body.dataset.iberoReqSelected||'';
   picker.addEventListener('change',()=>{body.dataset.iberoReqSelected=picker.value;applyModalFilter(body);});
   touched=true;
 }
 applyModalFilter(body);
 return touched;
}
// Los tres filtros de SC (texto, etapa y número de requisición) deben usar
// LA MISMA lista de líneas. El módulo original de etapas sólo busca nombre/SKU:
// si se busca un folio, imprime cero aunque las tarjetas sí coincidan.
function selectedModalStages(){
 const checks=[...document.querySelectorAll('#requestStageFilterGroup .request-stage-filter-check')];
 return checks.length?new Set(checks.filter(c=>c.checked).map(c=>c.value)):new Set(['ordered','requisition','received','cancelled']);
}
function matchesStage(line,selected){
 if(!line||!selected.size)return false;
 const req=number(line.quantityRequested),got=number(line.quantityReceived),cancel=number(line.quantityCancelled);
 const pending=Math.max(0,req-got-cancel);
 return Boolean((pending>0&&line.requisitionStatus==='requisitioned'&&selected.has('requisition'))
  ||(pending>0&&line.requisitionStatus!=='requisitioned'&&selected.has('ordered'))
  ||(got>0&&selected.has('received'))||(cancel>0&&selected.has('cancelled')));
}
function matchesText(line,tokens){
 if(!tokens.length)return true;
 const haystack=simple([line.sku,line.nombre,line.descripcion,line.requisitionNumber,line.externalRequisitionNumber,
  line.externalReportedStatus,line.externalProcurementItemCode,line.externalPurchaseOrderNumber,
  line.zoneId,line.zoneName,line.subzoneId,line.subzoneName,line.locationName,line.locationCode].filter(Boolean).join(' '));
 return tokens.every(token=>haystack.includes(token));
}
function visibleDetailLines(body){
 const chosen=body.querySelector('#iberoScReqFilter')?.value||body.dataset.iberoReqSelected||'';
 const stages=selectedModalStages();
 const tokens=simple(document.querySelector('#requestDetailSearch')?.value||'').split(/\s+/).filter(Boolean);
 return detailLines.filter(line=>(!chosen||folio(line)===chosen)&&matchesStage(line,stages)&&matchesText(line,tokens));
}
function groupedSku(tr){
 return tr.querySelector('td:first-child strong')?.textContent?.trim()
   ||tr.querySelector('td:first-child')?.childNodes?.[0]?.textContent?.trim()||'';
}
function applyModalFilter(body){
 if(!body||!detailLines.length)return;
 const visible=visibleDetailLines(body);
 const bySku=new Set(visible.map(l=>String(l.sku||'').trim()));
 let nVisible=0;
 for(const card of body.querySelectorAll('.request-line-row')){
  if(card.classList.contains('grouped-request-card')){
   let show=0;
   for(const tr of card.querySelectorAll('.grouped-breakdown-table tbody tr')){
    const yes=bySku.has(groupedSku(tr));
    tr.classList.toggle('request-stage-row-hidden',!yes);
    tr.hidden=!yes;
    tr.style.display=yes?'':'none';
    if(yes)show++;
   }
   card.classList.toggle('request-stage-hidden',!show);
   card.classList.toggle('d-none',!show);
   card.hidden=!show;
   card.style.display=show?'':'none';
   nVisible+=show;
   const meta=card.querySelector('.request-stage-group-meta');
   if(meta)meta.textContent=`${show} SKU visibles con los filtros combinados.`;
  }else{
   const sku=card.querySelector('.request-line-meta')?.textContent?.split('·')[0]?.trim()||'';
   const yes=bySku.has(sku);
   card.classList.toggle('request-stage-hidden',!yes);
   card.classList.toggle('d-none',!yes);
   card.hidden=!yes;
   card.style.display=yes?'':'none';
   if(yes)nVisible++;
  }
 }
 const label=`${visible.length} línea${visible.length===1?'':'s'} coinciden con búsqueda + etapa + requisición.`;
 const stageCounter=document.querySelector('#requestStageFilterCount');
 if(stageCounter)stageCounter.textContent=label;
 const groupingCounter=document.querySelector('#requestDetailSearchCount');
 if(groupingCounter)groupingCounter.textContent=`${nVisible} coincidencia${nVisible===1?'':'s'} de ${detailLines.length}`;
}
function printCombinedFiltered(){
 const body=document.querySelector('#purchaseRequestDetailBody');
 if(!body||!detailLines.length){alert('Abre una SC y espera a que terminen de cargarse los artículos.');return;}
 const lines=visibleDetailLines(body);
 if(!lines.length){alert('No hay artículos que coincidan con los filtros seleccionados.');return;}
 const popup=window.open('','_blank');if(!popup){alert('Permite ventanas emergentes para imprimir el listado.');return;}
 const req=body.querySelector('#iberoScReqFilter')?.value||'Todas';
 const selected=[...document.querySelectorAll('#requestStageFilterGroup .request-stage-filter-check:checked')].map(x=>x.parentElement?.textContent?.trim()).filter(Boolean).join(', ');
 const request=document.querySelector('#purchaseRequestDetailTitle')?.textContent?.trim()||'Solicitud';
 const amount=(n,c)=>{try{return new Intl.NumberFormat('es-MX',{style:'currency',currency:c||'MXN'}).format(number(n));}catch{return number(n).toFixed(2)+' '+(c||'MXN');}};
 const rows=lines.map(l=>{
  const wanted=number(l.quantityRequested),received=number(l.quantityReceived),cancel=number(l.quantityCancelled),out=Math.max(0,wanted-received-cancel);
  const unit=number(l.requisitionUnitCost??l.unitPrice),spent=Object.hasOwn(l,'actualCostTotal')?number(l.actualCostTotal):received*number(l.lastActualUnitCost??l.unitPrice);
  return `<tr><td>${esc(l.sku)}</td><td><strong>${esc(l.nombre)}</strong><div class="muted">${esc(l.zoneName||'')} · ${esc(l.subzoneName||'')} · ${esc(l.locationName||'')}</div></td>
  <td>${esc(folio(l)||'Sin folio')}</td><td>${esc(l.externalReportedStatus|| (l.requisitionStatus==='requisitioned'?'En requisición':'Solicitado'))}</td>
  <td class="num">${wanted}</td><td class="num">${received}</td><td class="num">${cancel}</td><td class="num">${out}</td>
  <td class="num">${esc(amount(unit,l.currency))}</td><td class="num">${esc(amount(spent,l.currency))}</td><td class="num">${esc(amount(out*unit,l.currency))}</td></tr>`;
 }).join('');
 popup.document.open();popup.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(request)} · Filtrados</title><style>
 @page{size:A4 landscape;margin:10mm}*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font:10pt Arial,sans-serif;color:#202327;margin:0}
 header{border-bottom:3px solid #c8102e;padding:8px 0 10px;margin-bottom:14px}h1{font-size:20pt;margin:3px 0}.small,.muted{color:#637080;font-size:8pt}table{width:100%;border-collapse:collapse;font-size:8pt}
 th,td{padding:6px 5px;border-bottom:1px solid #d7dce3;text-align:left;vertical-align:top}th{background:#f1f3f7}.num{text-align:right;white-space:nowrap}.tools{text-align:right;margin:6px 0 15px}
 @media print{.tools{display:none}}</style></head><body><div class="tools"><button onclick="window.print()">Imprimir / Guardar PDF</button><button onclick="window.close()">Cerrar</button></div>
 <header><div class="small">UNIVERSIDAD IBEROAMERICANA CIUDAD DE MÉXICO · FABLAB</div><h1>${esc(request)} · Listado filtrado</h1>
 <div class="small">${lines.length} artículos · Requisición: ${esc(req)} · Etapas: ${esc(selected||'Todas')} · Búsqueda: ${esc(document.querySelector('#requestDetailSearch')?.value||'Sin búsqueda')}</div></header>
 <table><thead><tr><th>SKU</th><th>Producto / Área</th><th>Requisición</th><th>Etapa</th><th>Solic.</th><th>Rec.</th><th>Cancel.</th><th>Pend.</th><th>Costo unit.</th><th>Gasto recibido</th><th>Compromiso</th></tr></thead><tbody>${rows}</tbody></table>
 <script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));<\/script></body></html>`);
 popup.document.close();
}
function prepareModal(requestId){
 const id=++detailSeq;detailRequest=requestId;detailObserver?.disconnect();
 const body=document.querySelector('#purchaseRequestDetailBody');if(!body)return;
 void fetchLines(requestId).then(lines=>{
  if(id!==detailSeq)return;
  detailLines=lines;
  const update=()=>{if(id!==detailSeq)return;modalMatchRows(body);};
  update();let scheduled=false;
  detailObserver=new MutationObserver(()=>{
    if(scheduled)return;scheduled=true;
    queueMicrotask(()=>{scheduled=false;update();});
  });
  detailObserver.observe(body,{subtree:true,childList:true});
 }).catch(e=>console.warn('No se pudo consultar requisiciones de la SC:',e));
}
function installModalHook(){
 // El botón original imprime según un buscador que no reconoce folios.
 // Capturamos el clic ANTES de su manejador y usamos el mismo conjunto visible.
 document.addEventListener('click',e=>{
   if(!e.target?.closest?.('#requestPrintFiltered'))return;
   e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();printCombinedFiltered();
 },true);
 const refilter=()=>window.setTimeout(()=>{
   const body=document.querySelector('#purchaseRequestDetailBody');
   if(body&&detailLines.length)applyModalFilter(body);
 },45);
 document.addEventListener('input',e=>{if(e.target?.matches?.('#requestDetailSearch'))refilter();});
 document.addEventListener('change',e=>{if(e.target?.matches?.('#requestStageFilterGroup .request-stage-filter-check'))refilter();});
 document.addEventListener('click',e=>{if(e.target?.closest?.('#requestStageSelectAll,.request-view-mode'))refilter();});
 document.addEventListener('purchase-request-detail-rendered',e=>{
   const id=String(e.detail?.requestId||'');if(id){prepared.delete(id);prepareModal(id);}
 });
 document.addEventListener('hidden.bs.modal',e=>{
   if(e.target?.id==='purchaseRequestDetailModal'){detailSeq++;detailObserver?.disconnect();detailObserver=null;}
 });
}
installPdfHook();
installModalHook();
