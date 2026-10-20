/* FabLab IBERO: folio externo de requisición, captura individual/masiva,
   edición retrospectiva y consulta agrupada de sólo lectura.
   Requiere los módulos de compras cargados previamente desde compras.html.
   Ninguna escritura cambia stock, cantidades recibidas o gasto real histórico. */
import { auth,db } from './firebase-app.js';
import { getUserProfile,waitForUser,fileViewUrl } from './common.js';
import { collection,doc,getDoc,getDocFromServer,getDocsFromServer,runTransaction,serverTimestamp,updateDoc } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { n,q,pending,folioKey,cleanFolio,amounts,stage,groupRequisitions,warehouseReady,stateTone,sortRequisitionGroups } from './compras-requisitions-model.js?v=20261017d';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=(amount,currency='MXN')=>{try{return new Intl.NumberFormat('es-MX',{style:'currency',currency}).format(n(amount));}catch{return `${n(amount).toFixed(2)} ${currency}`;}};
const reqRef=id=>doc(db,'purchaseRequests',id);
const lineRef=(id,lineId)=>doc(db,'purchaseRequests',id,'items',lineId);
const linesRef=id=>collection(db,'purchaseRequests',id,'items');
const stamp=()=>new Date().toISOString();
let role='',profile=null,busy=false,restoreDetailId='',lastBundles=[],viewFilter='';
let requisitionSortMode='folio', warehouseOnly=false, reportLoading=false;
const admin=()=>role==='admin';
function requireAdmin(){if(!admin()||!auth.currentUser)throw new Error('Sólo el administrador puede registrar o editar números de requisición.');}
function validateFolio(raw){const value=cleanFolio(raw);if(value.length>80)throw new Error('El número de requisición excede 80 caracteres.');if(/[\u0000-\u001f]/.test(value))throw new Error('El folio contiene caracteres no permitidos.');return value;}
function lineEligible(l){return l.requisitionStatus!=='requisitioned'&&pending(l)>0&&q(l.quantityReceived)===0&&q(l.quantityCancelled)===0&&l.status!=='draft';}
function itemRefFor(line,lineId){return doc(db,'items',String(line.itemId||lineId));}
function refsFor(item){return (Array.isArray(item.purchaseRequisitionRefs)?item.purchaseRequisitionRefs:[])
  .map(x=>({...x,requestId:String(x?.requestId||''),lineId:String(x?.lineId||x?.itemId||''),requisitionQty:Math.max(0,n(x?.requisitionQty))}))
  .filter(x=>x.requestId&&x.lineId&&x.requisitionQty>0);}
function refreshUI(requestId){
  document.querySelector('#refreshPurchaseRequests')?.click();
  if(document.querySelector('#purchaseBudgetsPanel.show'))document.querySelector('#refreshPurchaseBudgets')?.click();
  document.dispatchEvent(new CustomEvent('purchase:finance-reconciled',{detail:{requestId}}));
}
async function fetchLines(requestId){const snap=await getDocsFromServer(linesRef(requestId));return snap.docs.map(d=>({id:d.id,...d.data()}));}
async function refreshAggregate(requestId){
  const lines=await fetchLines(requestId),estimated={},spent={},committed={},current={};
  let requested=0,received=0,cancelled=0,outstanding=0;
  for(const l of lines){
    const currency=String(l.currency||'MXN').toUpperCase(),t=amounts(l);
    requested+=t.requested;received+=t.received;cancelled+=t.cancelled;outstanding+=t.pending;
    estimated[currency]=(estimated[currency]||0)+t.requested*Math.max(0,n(l.unitPrice));
    spent[currency]=(spent[currency]||0)+t.spent;
    committed[currency]=(committed[currency]||0)+t.committed;
    current[currency]=(current[currency]||0)+t.used;
  }
  const status=outstanding>0?(received||cancelled?'partial':'sent'):(received>0?'completed':'cancelled');
  await updateDoc(reqRef(requestId),{
    status,itemCount:lines.length,totalQty:requested,totalsByCurrency:estimated,
    currentTotalsByCurrency:current,spentTotalsByCurrency:spent,
    pendingTotalsByCurrency:committed,updatedAt:serverTimestamp()
  });
}
// Cada SKU se registra en una transacción con el folio: nunca queda la etapa
// en requisición, sin su folio, cuando el usuario proporciona uno.
async function registerOne(requestId,lineId,cost,folio){
  requireAdmin();const unit=Number(cost);if(!Number.isFinite(unit)||unit<0)throw new Error('Costo unitario inválido.');
  const number=validateFolio(folio);
  await runTransaction(db,async tx=>{
    const lr=lineRef(requestId,lineId),rr=reqRef(requestId),ls=await tx.get(lr),rs=await tx.get(rr);
    if(!ls.exists()||!rs.exists()||rs.data().status==='draft')throw new Error('La línea o solicitud no existe o sigue en borrador.');
    const l=ls.data();if(!lineEligible(l))throw new Error(`${l.sku||lineId}: ya no está disponible para registrar requisición completa.`);
    const ir=itemRefFor(l,lineId),is=await tx.get(ir);if(!is.exists())throw new Error(`${l.sku||lineId}: producto no encontrado.`);
    const item=is.data(),itemId=String(l.itemId||lineId),quantity=pending(l),prevCost=Math.max(0,n(l.unitPrice));
    const refs=refsFor(item).filter(ref=>!(ref.requestId===requestId&&ref.lineId===itemId));
    refs.push({requestId,lineId:itemId,folio:String(rs.data().folio||requestId),requisitionQty:quantity,requisitionNumber:number});
    const linePatch={requisitionStatus:'requisitioned',requisitionNumber:number,
      requisitionedAt:serverTimestamp(),requisitionedBy:auth.currentUser.uid,
      requisitionedByName:profile?.nombre||auth.currentUser.email||'',requisitionUnitCost:unit,updatedAt:serverTimestamp()};
    if(Math.abs(unit-prevCost)>0.005){linePatch.originalUnitPrice=Object.prototype.hasOwnProperty.call(l,'originalUnitPrice')?n(l.originalUnitPrice):prevCost;linePatch.unitPrice=unit;}
    const itemPatch={purchaseRequisitionRefs:refs,purchaseRequisitionQty:refs.reduce((s,x)=>s+x.requisitionQty,0),updatedAt:serverTimestamp()};
    // Misma política de sincronización de precio vigente del paquete financiero;
    // jamás reescribe el costo de recepciones ya efectuadas.
    if(Math.abs(unit-n(item.precioUnitario))>0.005){itemPatch.precioUnitario=unit;itemPatch.moneda=l.currency||item.moneda||'MXN';itemPatch.financePriceSourceMillis=Date.now();}
    tx.update(ir,itemPatch);tx.update(lr,linePatch);
  });
}
// Editar sólo folio: sin cambiar etapa, cantidad, inventario, cotización o gasto.
async function editOne(requestId,lineId,folio,reason=''){
  requireAdmin();const number=validateFolio(folio);
  await runTransaction(db,async tx=>{
    const lr=lineRef(requestId,lineId),ls=await tx.get(lr);if(!ls.exists())throw new Error('Producto no encontrado.');
    const l=ls.data();if(l.requisitionStatus!=='requisitioned')throw new Error(`${l.sku||lineId}: no está registrado en requisición.`);
    const before=cleanFolio(l.requisitionNumber);if(before===number)return;
    const ir=itemRefFor(l,lineId),is=await tx.get(ir);if(!is.exists())throw new Error('Producto de inventario no encontrado.');
    const itemId=String(l.itemId||lineId),refs=refsFor(is.data());
    const updatedRefs=refs.map(x=>(x.requestId===requestId&&x.lineId===itemId)?{...x,requisitionNumber:number}:x);
    const history=Array.isArray(l.requisitionNumberHistory)?l.requisitionNumberHistory:[];
    if(history.length>=200)throw new Error('Este SKU alcanzó el límite del historial de correcciones del folio. Consulta al administrador.');
    tx.update(lr,{requisitionNumber:number,requisitionNumberHistory:[...history,{previous:before,current:number,at:stamp(),by:auth.currentUser.uid,reason:String(reason||'').slice(0,300)}],updatedAt:serverTimestamp()});
    if(updatedRefs.some((x,i)=>x!==refs[i]))tx.update(ir,{purchaseRequisitionRefs:updatedRefs,updatedAt:serverTimestamp()});
  });
}
function ensureStyle(){if(document.getElementById('iberoRequisitionFolioStyles'))return;const s=document.createElement('style');s.id='iberoRequisitionFolioStyles';s.textContent=`
  .req-number-tag{font-size:.79rem;color:#0b5ed7;font-weight:600;display:inline-block}
  .req-report-summary{display:flex;flex-wrap:wrap;gap:.6rem;margin:.7rem 0}
  .req-report-summary>span{border:1px solid #d9dee3;background:#f8f9fa;padding:.35rem .65rem;border-radius:.5rem}
  .req-report-card{border:1px solid #d8dde3;border-left:5px solid #0d6efd;border-radius:.6rem;padding:1rem;margin:.8rem 0}
  .req-report-card summary{cursor:pointer;font-size:1.05rem;font-weight:650}
  .req-pdf-extended{margin-left:1rem;white-space:nowrap;vertical-align:middle;font-size:.82rem;}
  .req-report-card .table{font-size:.87rem}
  .req-folio-inline{border:1px solid #b6d4fe;background:#eff6ff;padding:.7rem;border-radius:.5rem;margin:.6rem 0}
  .req-number-input{max-width:540px}
  #iberoRequisitionsPanel .offcanvas-body{background:#fff}
  #iberoRequisitionEditor .modal-dialog{max-width:980px}
  #iberoRequisitionsPanel .req-warehouse-controls{display:flex;align-items:end;gap:.7rem;flex-wrap:wrap;margin:.7rem 0 1rem}
  #iberoRequisitionsPanel .req-warehouse-controls .form-select{width:min(280px,100%)}
  #iberoRequisitionsPanel .req-report-card{border-left:5px solid #0d6efd}
  #iberoRequisitionsPanel .req-report-card.req-group-warehouse{border-left-color:#d35400}
  #iberoRequisitionsPanel .req-report-card.req-group-received{border-left-color:#198754}
  #iberoRequisitionsPanel .req-report-card.req-group-cancelled{border-left-color:#6c757d}
  #iberoRequisitionsPanel .req-state-pill{display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;line-height:1.25;border-radius:6px;padding:.35rem .55rem;font-size:.8rem;font-weight:700}
  #iberoRequisitionsPanel .req-state-warehouse{color:#fff!important;background:#d35400!important;border:1px solid #b64400}
  #iberoRequisitionsPanel .req-state-requisition{color:#fff!important;background:#0d6efd!important;border:1px solid #0849b3}
  #iberoRequisitionsPanel .req-state-received{color:#fff!important;background:#198754!important;border:1px solid #12633c}
  #iberoRequisitionsPanel .req-state-cancelled{color:#fff!important;background:#6c757d!important;border:1px solid #545b62}
  #iberoRequisitionsPanel .req-row-warehouse>td{background:#fff4e8!important}
  #iberoRequisitionsPanel .req-row-received>td{background:#f0f8f2!important}
  #iberoRequisitionsPanel .req-pickup-check{width:1.2rem;height:1.2rem;cursor:pointer;accent-color:#d35400}
  #iberoRequisitionsPanel .req-pickup-check:disabled{cursor:not-allowed}
  #iberoRequisitionsPanel .req-pickup-cell{min-width:95px;text-align:center}
  #iberoRequisitionsPanel .req-report-card .table td{vertical-align:middle}
  #iberoRequisitionsPanel .req-warehouse-hint{color:#5b6168;font-size:.84rem}
  @media(max-width:760px){#iberoRequisitionsPanel{width:100vw!important}.req-report-card .table{min-width:1100px}}
`;document.head.append(s);}
function modalBase(id,title,footer){let m=document.getElementById(id);if(m)return m;m=document.createElement('div');m.id=id;m.className='modal fade';m.tabIndex=-1;m.innerHTML=`<div class="modal-dialog modal-lg modal-dialog-scrollable"><div class="modal-content">
 <div class="modal-header"><h5 class="modal-title">${esc(title)}</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button></div>
 <div class="modal-body"></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cerrar</button>${footer}</div></div></div>`;document.body.append(m);return m;}
function reopenAfter(m,requestId){
 const detail=document.getElementById('purchaseRequestDetailModal');restoreDetailId=requestId;
 m.addEventListener('hidden.bs.modal',()=>{
   if(restoreDetailId===requestId){restoreDetailId='';
     const btn=[...document.querySelectorAll('.request-history-view')].find(x=>x.dataset.requestId===requestId);
     if(btn)window.setTimeout(()=>btn.click(),90);
   }
 },{once:true});
 const show=()=>window.bootstrap.Modal.getOrCreateInstance(m).show();
 if(detail?.classList.contains('show')){
   detail.addEventListener('hidden.bs.modal',show,{once:true});window.bootstrap.Modal.getOrCreateInstance(detail).hide();
 }else show();
}
function finishModal(m){window.bootstrap.Modal.getOrCreateInstance(m).hide();}

async function openIndividual(requestId,lineId){
 try {requireAdmin();const snap=await getDocFromServer(lineRef(requestId,lineId));if(!snap.exists())throw new Error('No se encontró el artículo.');
 const l=snap.data();if(!lineEligible(l))throw new Error('El artículo ya no cumple los requisitos para registrar requisición.');
 const m=modalBase('iberoRequisitionIndividual','Registrar requisición',`<button type="button" class="btn btn-primary" id="iberoRequisitionIndividualSave">Registrar</button>`);
 m.dataset.requestId=requestId;m.dataset.lineId=lineId;
 m.querySelector('.modal-body').innerHTML=`<p><strong>${esc(l.sku||lineId)}</strong> · ${esc(l.nombre||'')}</p>
 <p class="small text-muted">Se registrará la requisición completa de ${pending(l)} piezas, sin aumentar las existencias.</p>
 <label class="form-label" for="iberoRequisitionIndividualFolio">Número asignado por Compras</label>
 <input id="iberoRequisitionIndividualFolio" class="form-control mb-3 req-number-input" maxlength="80" placeholder="Ej. REQ-2026-01234" autocomplete="off">
 <div class="form-text mb-3">Puede quedar vacío si Compras todavía no asignó número; podrás editarlo después.</div>
 <label class="form-label" for="iberoRequisitionIndividualCost">Costo unitario oficial (${esc(l.currency||'MXN')})</label>
 <input id="iberoRequisitionIndividualCost" type="number" min="0" step="0.01" class="form-control" value="${Math.max(0,n(l.unitPrice))}">`;
 reopenAfter(m,requestId);
 }catch(e){alert(e.message);}
}
async function saveIndividual(){
 const m=document.getElementById('iberoRequisitionIndividual');if(!m||busy)return;
 const requestId=m.dataset.requestId,lineId=m.dataset.lineId,folio=m.querySelector('#iberoRequisitionIndividualFolio').value,cost=Number(m.querySelector('#iberoRequisitionIndividualCost').value);
 if(!confirm(`¿Registrar esta requisición${cleanFolio(folio)?` con número ${cleanFolio(folio)}`:' todavía sin número'}?`))return;
 busy=true;const button=m.querySelector('#iberoRequisitionIndividualSave');button.disabled=true;
 try{await registerOne(requestId,lineId,cost,folio);await refreshAggregate(requestId);refreshUI(requestId);finishModal(m);}catch(e){console.error(e);alert(`No se pudo registrar la requisición: ${e.message}`);}finally{busy=false;button.disabled=false;}
}
function addMassFolioInput(m){
 if(!admin())return;
 const id=m.id,isWide=id==='requestWideRequisitionModal',isGroup=id==='purchaseGroupBatchModal'&&m.dataset.mode==='requisition';
 if(!isWide&&!isGroup)return;
 const body=m.querySelector('.modal-body');if(!body)return;
 let wrap=body.querySelector('.req-folio-inline');if(wrap)return;
 wrap=document.createElement('div');wrap.className='req-folio-inline';wrap.innerHTML=`<label class="form-label fw-semibold" for="${isWide?'reqWideFolio':'reqGroupFolio'}">Número de requisición asignado por Compras</label>
 <input class="form-control req-number-input req-mass-folio" id="${isWide?'reqWideFolio':'reqGroupFolio'}" type="text" maxlength="80" placeholder="Un mismo número para todos los SKU seleccionados" autocomplete="off">
 <div class="form-text">El mismo folio se guardará en todas las líneas seleccionadas. Puede dejarse pendiente y completarse después.</div>`;
 body.prepend(wrap);
}
function selectionFromModal(m){
 const wide=m.id==='requestWideRequisitionModal';const selector=wide?'.request-wide-line':'.group-batch-row',check=wide?'.request-wide-line-check':'.group-batch-select',cost=wide?'.request-wide-unit-cost':'.group-batch-unit-cost';
 return [...m.querySelectorAll(selector)].filter(row=>row.querySelector(check)?.checked&&!row.querySelector(check)?.disabled).map(row=>({
   row,id:String(row.dataset.lineId||''),price:Number(row.querySelector(cost)?.value)
 }));
}
async function saveMass(m){
 if(!m||busy)return;try{requireAdmin();}catch(e){alert(e.message);return;}
 const requestId=String(m.dataset.requestId||''),number=m.querySelector('.req-mass-folio')?.value||'';
 let rows;try{validateFolio(number);rows=selectionFromModal(m);if(!rows.length)throw new Error('Selecciona al menos un SKU.');
   for(const r of rows)if(!r.id||!Number.isFinite(r.price)||r.price<0)throw new Error('Hay un SKU con costo no válido.');
 }catch(e){alert(e.message);return;}
 if(!confirm(`¿Registrar ${rows.length} artículos con el número de requisición ${cleanFolio(number)||'(pendiente de asignar)'}?\n\nLa operación conservará los importes y cantidades por SKU.`))return;
 busy=true;const button=m.querySelector(m.id==='requestWideRequisitionModal'?'#requestWideRequisitionSave':'#purchaseGroupBatchSave');const oldText=button?.textContent||'';
 if(button){button.disabled=true;button.textContent='Registrando…';}
 let completed=0,errors=[];
 try {
   // Secuencial: protege las referencias por SKU repetido entre solicitudes.
   for(const r of rows){try{await registerOne(requestId,r.id,r.price,number);completed++;r.row.querySelector('input[type="checkbox"]')?.setAttribute('disabled','disabled');
     const c=r.row.querySelector('.request-wide-line-check,.group-batch-select');if(c)c.checked=false;
   }catch(e){errors.push(`${r.id}: ${e.message}`);}}
   if(completed){await refreshAggregate(requestId);refreshUI(requestId);}
   if(errors.length){alert(`Se registraron ${completed} artículos. Fallaron ${errors.length}:\n${errors.slice(0,10).join('\n')}`);}
   else {alert(`${completed} artículos registrados con número ${cleanFolio(number)||'pendiente'}.`);window.bootstrap.Modal.getOrCreateInstance(m).hide();}
 }catch(e){console.error(e);alert(`Error de actualización: ${e.message}`);}finally{busy=false;if(button){button.disabled=false;button.textContent=oldText;}}
}
async function showDetailRequisitionNumbers(requestId) {
 const subtitle=document.getElementById('purchaseRequestDetailSubtitle');if(!subtitle)return;
 let summary=document.getElementById('iberoRequisitionDetailSummary');
 if(!summary){summary=document.createElement('div');summary.id='iberoRequisitionDetailSummary';summary.className='small mt-2';subtitle.insertAdjacentElement('afterend',summary);}
 summary.textContent='Consultando números de requisición…';
 try {
   const lines=(await fetchLines(requestId)).filter(x=>x.requisitionStatus==='requisitioned');
   if(document.querySelector('#purchaseRequestDetailPdf')?.dataset.requestId!==requestId)return;
   if(!lines.length){summary.remove();return;}
   const groups=new Map();for(const l of lines){const number=cleanFolio(l.requisitionNumber)||'Sin número';
      if(!groups.has(number))groups.set(number,0);groups.set(number,groups.get(number)+1);}
   summary.innerHTML=`<div class="d-flex gap-2 flex-wrap align-items-center"><strong>Requisiciones:</strong>${[...groups].map(([num,count])=>`<span class="badge ${num==='Sin número'?'text-bg-warning':'text-bg-primary'}">${esc(num)} · ${count} SKU</span>`).join('')}</div>`;
 } catch(e){summary.textContent=`No se pudieron consultar los números de requisición: ${e.message}`;}
}
function ensureDetailButton(){if(!admin())return;const modal=document.getElementById('purchaseRequestDetailModal');if(!modal)return;
 const footer=modal.querySelector('.modal-footer');if(!footer||footer.querySelector('#iberoRequisitionEditButton'))return;
 const button=document.createElement('button');button.id='iberoRequisitionEditButton';button.type='button';button.className='btn btn-outline-primary';button.textContent='Editar números de requisición';
 footer.prepend(button);
}
async function openEditor(requestId,focusLine=''){
 try{requireAdmin();const lines=(await fetchLines(requestId)).filter(l=>l.requisitionStatus==='requisitioned');if(!lines.length)throw new Error('Esta SC todavía no tiene artículos en requisición.');
 const m=modalBase('iberoRequisitionEditor','Editar número de requisición',`<button id="iberoRequisitionEditorSave" type="button" class="btn btn-primary">Guardar folio en seleccionados</button>`);
 m.dataset.requestId=requestId;
 m.querySelector('.modal-body').innerHTML=`<div class="alert alert-info py-2">Selecciona los SKU que pertenecen a la misma requisición externa. Esta edición sólo cambia su número y conserva cantidades, inventario, precios y gasto.</div>
 <label class="form-label" for="iberoRequisitionNewNumber">Número de requisición de Compras</label><input id="iberoRequisitionNewNumber" class="form-control req-number-input" maxlength="80" autocomplete="off" placeholder="Ej. REQ-2026-01234">
 <label class="form-label mt-2" for="iberoRequisitionReason">Motivo de corrección (opcional)</label><input id="iberoRequisitionReason" class="form-control" maxlength="300" placeholder="Asignación tardía o corrección de folio">
 <div class="d-flex gap-2 flex-wrap my-3"><input id="iberoRequisitionEditSearch" class="form-control flex-grow-1" type="search" placeholder="Buscar SKU, nombre o número"><button id="iberoRequisitionSelectAll" class="btn btn-outline-primary btn-sm" type="button">Seleccionar visibles</button><button id="iberoRequisitionClearAll" class="btn btn-outline-secondary btn-sm" type="button">Deseleccionar</button></div>
 <div class="table-responsive"><table class="table table-sm align-middle"><thead><tr><th></th><th>SKU / artículo</th><th>Folio actual</th><th>Recibido</th><th>Pendiente</th></tr></thead><tbody>${lines.map(l=>`<tr class="req-edit-row" data-id="${esc(l.id)}" data-search="${esc(`${l.sku||''} ${l.nombre||''} ${l.requisitionNumber||''}`.toLocaleLowerCase('es-MX'))}"><td><input type="checkbox" class="form-check-input req-edit-select" ${focusLine===l.id?'checked':''}></td><td><strong>${esc(l.sku||'')}</strong><div class="small text-muted">${esc(l.nombre||'')}</div></td><td>${esc(l.requisitionNumber||'Sin número')}</td><td>${q(l.quantityReceived)}</td><td>${pending(l)}</td></tr>`).join('')}</tbody></table></div>`;
 if(focusLine){const l=lines.find(x=>x.id===focusLine);if(l)m.querySelector('#iberoRequisitionNewNumber').value=cleanFolio(l.requisitionNumber);}
 reopenAfter(m,requestId);
 }catch(e){alert(e.message);}
}
async function saveEditor(){const m=document.getElementById('iberoRequisitionEditor');if(!m||busy)return;
 const requestId=m.dataset.requestId,rows=[...m.querySelectorAll('.req-edit-row')].filter(row=>row.querySelector('.req-edit-select')?.checked);
 let number;try{requireAdmin();number=validateFolio(m.querySelector('#iberoRequisitionNewNumber').value);if(!rows.length)throw new Error('Selecciona al menos un SKU.');}catch(e){alert(e.message);return;}
 if(!confirm(`¿Asignar ${number||'(sin número)'} a ${rows.length} artículos? Se conservará un historial de cambios de folio.`))return;
 busy=true;const button=m.querySelector('#iberoRequisitionEditorSave');button.disabled=true;
 const reason=m.querySelector('#iberoRequisitionReason').value;let done=0,errors=[];
 try{for(const row of rows){try{await editOne(requestId,row.dataset.id,number,reason);done++;}catch(e){errors.push(`${row.dataset.id}: ${e.message}`);}}
 if(done)refreshUI(requestId);
 if(errors.length)alert(`Se actualizaron ${done}; ${errors.length} fallaron:\n${errors.slice(0,10).join('\n')}`);
 else{alert(`${done} números de requisición actualizados.`);finishModal(m);}
 }finally{busy=false;button.disabled=false;}
}
async function getBundles(){
 const snapshot=await getDocsFromServer(collection(db,'purchaseRequests'));
 const requests=snapshot.docs.map(d=>({id:d.id,...d.data()})).filter(r=>r.status!=='draft');
 const bundles=[];
 for(let i=0;i<requests.length;i+=5){const slice=requests.slice(i,i+5);const batch=await Promise.all(slice.map(async request=>({request,lines:await fetchLines(request.id)})));bundles.push(...batch);}
 return bundles;
}
function ensureReadPanel(){let panel=document.getElementById('iberoRequisitionsPanel');if(panel)return panel;
 panel=document.createElement('div');panel.id='iberoRequisitionsPanel';panel.className='offcanvas offcanvas-end';panel.tabIndex=-1;panel.style.width='min(1250px,96vw)';panel.setAttribute('aria-labelledby','iberoRequisitionsTitle');
 panel.innerHTML=`<div class="offcanvas-header"><div><h2 id="iberoRequisitionsTitle" class="h4 mb-0">Requisiciones de Compras</h2><small class="text-muted">Vista informativa agrupada por número asignado por Compras</small></div><button class="btn-close" type="button" data-bs-dismiss="offcanvas" aria-label="Cerrar"></button></div>
 <div class="offcanvas-body">
 <div class="d-flex gap-2 flex-wrap align-items-center mb-2"><input id="iberoRequisitionSearch" type="search" class="form-control flex-grow-1" placeholder="Buscar requisición, SKU, producto, SC o alias" style="max-width:580px"><button id="iberoRequisitionRefresh" class="btn btn-outline-primary" type="button">Actualizar</button></div>
 <div class="req-warehouse-controls">
   <div><label class="form-label small mb-1" for="iberoRequisitionSort">Ordenar por</label><select class="form-select" id="iberoRequisitionSort"><option value="folio">Número de requisición</option><option value="estado">Estado (almacén primero)</option><option value="gasto_desc">Gasto real: mayor a menor</option><option value="gasto_asc">Gasto real: menor a mayor</option><option value="nombre">Nombre de artículo (A–Z)</option><option value="entrega_asc">Entrega estimada: próxima primero</option><option value="entrega_desc">Entrega estimada: lejana primero</option></select></div>
   <label class="form-check d-flex align-items-center gap-2 mb-2"><input type="checkbox" id="iberoRequisitionOnlyWarehouse" class="form-check-input"><span class="form-check-label">Sólo por recoger en almacén</span></label>
   <button class="btn btn-outline-warning mb-1" type="button" id="iberoRequisitionPrintWarehouse"><span aria-hidden="true">🖨️</span> Imprimir por recoger</button>
 </div>
 <div class="d-flex gap-2 flex-wrap mb-2"><span class="req-state-pill req-state-warehouse">En almacén</span><span class="req-state-pill req-state-requisition">En requisición</span><span class="req-state-pill req-state-received">Recibido</span></div>
 <p class="req-warehouse-hint">La casilla indica que Compras avisó que el artículo está listo para recoger en almacén. No registra una recepción, no modifica existencias ni genera gasto. Sólo el administrador puede cambiarla; el supervisor puede consultar e imprimir.</p>
 <div id="iberoRequisitionsContent"><p class="text-muted">Consulta pendiente…</p></div>
 </div>`;
 document.body.append(panel);return panel;
}
function dateText(value){
  if(!value)return '—';
  const d=typeof value?.toDate==='function'?value.toDate():new Date(value);
  return Number.isNaN(d.getTime())?'—':d.toLocaleString('es-MX',{dateStyle:'short',timeStyle:'short'});
}
function currencySummary(lines){
  const map=new Map();
  for(const l of lines){const a=amounts(l);if(!map.has(a.currency))map.set(a.currency,{spent:0,committed:0,used:0});
    const t=map.get(a.currency);t.spent+=a.spent;t.committed+=a.committed;t.used+=a.used;}
  return map;
}
function deliveryText(value){const iso=String(value||'');const match=iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);return match?`${match[3]}/${match[2]}/${match[1]}`:'—';}
function groupHtml(g){
 const shown=warehouseOnly?g.lines.filter(warehouseReady):g.lines;
 if(!shown.length)return '';
 const data=[...currencySummary(shown).entries()].map(([currency,v])=>`<div class="border rounded p-2 small"><strong>${esc(currency)}</strong><div>Gasto real: <strong>${esc(money(v.spent,currency))}</strong></div><div>Compromiso: <strong>${esc(money(v.committed,currency))}</strong></div><div>Total utilizado: <strong>${esc(money(v.used,currency))}</strong></div></div>`).join('');
 const statuses=new Set(shown.map(stage)),pickup=shown.filter(warehouseReady).length;
 const tone=shown.some(warehouseReady)?'warehouse':shown.some(l=>pending(l)>0)?'requisition':shown.some(l=>q(l.quantityReceived)>0)?'received':'cancelled';
 const groupTone=`req-group-${tone}`;
 return `<details class="req-report-card ${groupTone}" data-group-key="${esc(g.key)}" data-search="${esc([g.folio,...shown.flatMap(l=>[l.sku,l.nombre,l.requestFolio,l.requestAlias]),...statuses].join(' ').toLocaleLowerCase('es-MX'))}">
 <summary>${esc(g.folio||'Sin número asignado')} ${g.unassigned?`<span class="badge text-bg-warning ms-2">SC ${esc(shown[0]?.requestFolio||'')}</span>`:''} <span class="text-secondary small ms-2">${shown.length} SKU · ${new Set(shown.map(l=>l.requestId)).size} SC</span>${pickup?` <span class="req-state-pill req-state-warehouse ms-2">${pickup} por recoger</span>`:''} <button type="button" class="btn btn-outline-danger btn-sm req-pdf-extended" data-group-key="${esc(g.key)}" title="Imprimir las fichas completas de esta requisición">PDF extendido</button> <button type="button" class="btn btn-outline-primary btn-sm req-zip-individual" data-group-key="${esc(g.key)}" title="Descargar un PDF independiente por producto, con foto y liga de compra">Fichas ZIP</button></summary>
 <div class="mt-2"><div class="small text-muted mb-2">Estados: ${esc([...statuses].join(' · '))}</div><div class="d-flex gap-2 flex-wrap">${data}</div>
 <div class="table-responsive mt-3"><table class="table table-sm align-middle"><thead><tr><th>SC</th><th>SKU</th><th>Artículo</th><th>Estado</th><th>Entrega estimada</th><th>Almacén</th><th class="text-end">Solicitado</th><th class="text-end">Recibido</th><th class="text-end">Cancelado</th><th class="text-end">Pendiente</th><th class="text-end">Gasto real</th><th class="text-end">Compromiso</th></tr></thead><tbody>
 ${shown.map(l=>{const t=amounts(l),color=stateTone(l),ready=warehouseReady(l),allowToggle=admin()&&t.pending>0;
 return `<tr class="req-row-${color}"><td><button type="button" class="btn btn-link btn-sm p-0 req-open-sc" data-request-id="${esc(l.requestId)}">${esc(l.requestFolio||'SC')}</button><div class="small text-muted">${esc(l.requestAlias)}</div></td><td>${esc(l.sku||'')}</td><td>${esc(l.nombre||'')}</td><td><span class="req-state-pill req-state-${color}">${esc(stage(l))}</span></td><td class="small text-nowrap">${esc(deliveryText(l.externalExpectedDeliveryDate))}${l.externalExpectedDeliveryDate&&l.externalExpectedDeliveryDate<new Date().toISOString().slice(0,10)&&t.pending>0?'<div class="text-danger fw-semibold">Fecha vencida</div>':''}</td><td class="req-pickup-cell"><label class="d-inline-flex flex-column align-items-center gap-1 small"><input class="req-pickup-check" type="checkbox" data-request-id="${esc(l.requestId)}" data-line-id="${esc(l.id)}" ${ready?'checked':''} ${allowToggle?'':'disabled'} title="${allowToggle?'Marcar aviso de almacén listo para recoger':'Solo administrador; se requiere una cantidad pendiente'}" aria-label="Aviso de almacén: ${esc(l.sku||l.nombre||'Artículo')}"><span>${ready?'Por recoger':(t.pending>0?'Avisar':'Cerrado')}</span></label>${ready?`<div class="small text-muted mt-1">${esc(dateText(l.warehousePickupSetAt))}</div>`:''}</td><td class="text-end">${t.requested}</td><td class="text-end">${t.received}</td><td class="text-end">${t.cancelled}</td><td class="text-end">${t.pending}</td><td class="text-end">${esc(money(t.spent,t.currency))}</td><td class="text-end">${esc(money(t.committed,t.currency))}</td></tr>`;}).join('')}</tbody></table></div></div></details>`;
}
function drawPanel(){
 const content=document.getElementById('iberoRequisitionsContent');if(!content)return;
 const expanded=new Set([...content.querySelectorAll('.req-report-card[open]')].map(el=>el.dataset.groupKey));
 const groups=sortRequisitionGroups(groupRequisitions(lastBundles),requisitionSortMode);
 const allLines=groups.flatMap(g=>g.lines),visibleLines=warehouseOnly?allLines.filter(warehouseReady):allLines;
 const spentBy=new Map(),commitBy=new Map();
 for(const l of visibleLines){const t=amounts(l);spentBy.set(t.currency,(spentBy.get(t.currency)||0)+t.spent);commitBy.set(t.currency,(commitBy.get(t.currency)||0)+t.committed);}
 const currencies=[...new Set([...spentBy.keys(),...commitBy.keys()])];
 const pickupCount=allLines.filter(warehouseReady).length;
 const rendered=groups.map(groupHtml).filter(Boolean);
 content.innerHTML=`<div class="small text-muted mb-2">${warehouseOnly?'Vista: por recoger · ':''}${rendered.length} requisiciones visibles · ${visibleLines.length} líneas visibles · ${new Set(visibleLines.map(l=>l.requestId)).size} SC · <strong>${pickupCount} artículo${pickupCount===1?'':'s'} por recoger</strong></div>
 <div class="req-report-summary">${currencies.map(c=>`<span><strong>${esc(c)}</strong> · Gasto real ${esc(money(spentBy.get(c)||0,c))} · Comprometido ${esc(money(commitBy.get(c)||0,c))}</span>`).join('')}</div>
 ${(requisitionSortMode==='gasto_asc'||requisitionSortMode==='gasto_desc')?'<p class="small text-muted">Montos ordenados dentro de cada moneda, sin conversión entre divisas. En grupos con varias divisas se toma MXN como referencia principal.</p>':''}
 ${rendered.length?rendered.join(''):'<p class="alert alert-info">No hay artículos que coincidan con el filtro.</p>'}`;
 content.querySelectorAll('.req-report-card').forEach(el=>{if(expanded.has(el.dataset.groupKey))el.open=true;});
 filterReport();
}
function filterReport(){const search=document.getElementById('iberoRequisitionSearch');const raw=(search?.value||'').trim().toLocaleLowerCase('es-MX');const tokens=raw.split(/\s+/).filter(Boolean);
 document.querySelectorAll('#iberoRequisitionsContent .req-report-card').forEach(card=>{card.hidden=tokens.length>0&&!tokens.every(t=>card.dataset.search.includes(t));});}
// Guardamos el aviso en la propia línea; toda la operación es atómica.
// No tocamos quantityReceived, stockAlmacen ni actualCostTotal.
async function saveWarehouseNotice(requestId,id,checked){
 requireAdmin();
 await runTransaction(db,async tx=>{
   const ref=lineRef(requestId,id),snap=await tx.get(ref);
   if(!snap.exists())throw new Error('La línea de requisición ya no existe.');
   const l=snap.data();
   if(l.requisitionStatus!=='requisitioned')throw new Error('Este artículo aún no está en requisición.');
   if(checked&&pending(l)<=0)throw new Error('El artículo ya no tiene piezas pendientes de recepción.');
   const old=Boolean(l.warehousePickupPending);
   if(old===checked)return;
   const history=Array.isArray(l.warehousePickupHistory)?l.warehousePickupHistory:[];
   if(history.length>=150)throw new Error('Se alcanzó el límite de auditoría de avisos. Consulta al administrador.');
   tx.update(ref,{
     warehousePickupPending:checked,
     warehousePickupSetAt:checked?serverTimestamp():null,
     warehousePickupUpdatedAt:serverTimestamp(),
     warehousePickupUpdatedBy:auth.currentUser.uid,
     warehousePickupUpdatedByName:profile?.nombre||auth.currentUser.email||'',
     warehousePickupHistory:[...history,{from:old,to:checked,at:stamp(),by:auth.currentUser.uid}],
     updatedAt:serverTimestamp(),
   });
 });
}
async function toggleWarehouse(checkbox){
 if(checkbox.disabled)return;
 const requestId=checkbox.dataset.requestId,lineId=checkbox.dataset.lineId,desired=checkbox.checked;
 checkbox.disabled=true;
 try{
   await saveWarehouseNotice(requestId,lineId,desired);
   // Confirmar el dato en el servidor, para no simular una escritura exitosa.
   const snap=await getDocFromServer(lineRef(requestId,lineId));
   if(!snap.exists())throw new Error('La línea dejó de existir después de la actualización.');
   for(const bundle of lastBundles)if(bundle.request.id===requestId){const i=bundle.lines.findIndex(l=>l.id===lineId);if(i>=0)bundle.lines[i]={id:lineId,...snap.data()};}
   drawPanel();
 }catch(e){console.error('Aviso almacén',e);checkbox.checked=!desired;alert(`No se pudo guardar el aviso de almacén: ${e.message}`);checkbox.disabled=false;}
}
function printWarehouseReport(){
 // Se abre inmediatamente por acción del usuario, antes de consultar Firestore.
 const popup=window.open('','_blank');if(!popup){alert('Permite ventanas emergentes para imprimir este reporte.');return;}
 popup.document.write('<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Requisiciones por recoger</title></head><body style="font-family:Arial;padding:20px">Consultando avisos vigentes del almacén…</body></html>');popup.document.close();
 (async()=>{
   const bundles=await getBundles();
   const groups=sortRequisitionGroups(groupRequisitions(bundles),'folio')
     .map(g=>({...g,lines:g.lines.filter(warehouseReady)})).filter(g=>g.lines.length);
   const total=groups.reduce((sum,g)=>sum+g.lines.length,0),now=new Date().toLocaleString('es-MX');
   popup.document.open();popup.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>FabLab IBERO · Artículos por recoger</title>
 <style>@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}body{font-family:Arial,sans-serif;color:#1f2328;margin:0}header{border-bottom:4px solid #d35400;padding:0 0 14px}h1{margin:3px 0 7px;font-size:24px}.overline{font-size:12px;text-transform:uppercase;letter-spacing:.04em;font-weight:bold;color:#ad4000}.muted{color:#626a72;font-size:12px}.toolbar{display:flex;justify-content:flex-end;gap:8px;margin-bottom:12px}.summary{padding:12px;border:1px solid #d8dee3;background:#fff4e8;border-radius:6px;margin:18px 0;font-size:15px}.reqgroup{break-inside:avoid;margin:18px 0}.reqtitle{background:#d35400;color:#fff;padding:9px;font-size:17px;font-weight:700;border-radius:4px 4px 0 0}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #dadfe4;padding:7px;text-align:left;vertical-align:top}th{background:#fff4e8}td.qty{text-align:center;font-weight:bold}.warning{margin:14px 0;font-size:12px;color:#626a72}@media print{.toolbar{display:none}}</style></head>
 <body><div class="toolbar"><button onclick="window.print()">Imprimir / Guardar PDF</button><button onclick="window.close()">Cerrar</button></div><header><div class="overline">Universidad Iberoamericana Ciudad de México · FabLab</div><h1>Artículos por recoger en almacén</h1><div class="muted">Generado: ${esc(now)} · Avisos activos por número de requisición</div></header>
 <div class="summary"><strong>${groups.length}</strong> requisiciones · <strong>${total}</strong> artículos pendientes de recoger</div>
 ${groups.length?groups.map(g=>`<section class="reqgroup"><div class="reqtitle">Requisición ${esc(g.folio||'Sin número asignado')} · ${g.lines.length} SKU</div><table><thead><tr><th>SC</th><th>SKU</th><th>Artículo</th><th>Área</th><th>Fecha del aviso</th><th>Piezas pendientes de SC</th></tr></thead><tbody>${g.lines.map(l=>`<tr><td>${esc(l.requestFolio||'')}${l.requestAlias?`<div class="muted">${esc(l.requestAlias)}</div>`:''}</td><td>${esc(l.sku||'')}</td><td>${esc(l.nombre||'')}</td><td>${esc([l.zoneName,l.subzoneName,l.locationName].filter(Boolean).join(' · '))}</td><td>${esc(dateText(l.warehousePickupSetAt))}</td><td class="qty">${pending(l)}</td></tr>`).join('')}</tbody></table></section>`).join(''):'<p>No hay artículos con aviso de almacén activo y piezas pendientes de recepción.</p>'}
 <p class="warning">Un aviso de almacén no equivale a recepción del FabLab. La cantidad pendiente de la SC no garantiza que todas esas piezas estén físicamente disponibles para recoger. Confirma las unidades entregadas con almacén.</p>
 <script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));<\/script></body></html>`);
   popup.document.close();
 })().catch(e=>{console.error(e);popup.document.open();popup.document.write(`<p>No se pudo generar el reporte: ${esc(e.message)}</p>`);popup.document.close();});
}
// Documento A4 apaisado con fichas individuales, por FOLIO DE REQUISICIÓN.
// Se vuelve a consultar Firestore justo al imprimir; no se usa el caché del panel.
function reportReqCard(l){
 const a=amounts(l), curr=a.currency, image=l.imageFileId?fileViewUrl(l.imageFileId):'assets/placeholder.svg';
 const entered=String(l.externalReportedStatus||'').trim(), date=deliveryText(l.externalExpectedDeliveryDate);
 const badge=warehouseReady(l)?'En almacén':a.pending>0?'En requisición':a.received>0?'Recibido':'Cancelado';
 const badgeTone=warehouseReady(l)?'warehouse':a.pending>0?'requisition':a.received>0?'received':'cancelled';
 const unitPrice=Math.max(0,n(l.requisitionUnitCost??l.unitPrice));
 const initial=l.originalUnitPrice!=null&&Math.abs(n(l.originalUnitPrice)-unitPrice)>.01?`<span><b>Precio estimado inicial:</b> ${esc(money(l.originalUnitPrice,curr))}</span>`:'';
 const links=[['Información',l.infoUrl],['Liga de compra',l.purchaseUrl]].filter(([,url])=>/^https?:\/\//i.test(String(url||''))).map(([label,url])=>`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`).join('');
 return `<article class="req-report-item ${badgeTone}">
  <div class="req-report-photo"><img src="${esc(image)}" alt="Foto ${esc(l.nombre||l.sku||'producto')}" onerror="this.src='assets/placeholder.svg'"></div>
  <div class="req-report-body">
    <div class="req-report-top"><div><h2>${esc(l.nombre||l.sku||'Artículo')}</h2><div class="small">SKU ${esc(l.sku||'—')} · ${esc(l.tipo||'')} · <b>${esc(l.requestFolio||'SC')}</b>${l.requestAlias?` · ${esc(l.requestAlias)}`:''}</div></div><span class="state-pill ${badgeTone}">${esc(badge)}</span></div>
    <div class="req-report-proc"><span><b>Requisición:</b> ${esc(l.requisitionNumber||'Sin número asignado')}</span><span><b>Estado de Compras:</b> ${esc(entered||'Sin reporte institucional')}</span><span><b>Entrega estimada:</b> ${esc(date)}</span>${l.externalPurchaseOrderNumber?`<span><b>Orden de compra:</b> ${esc(l.externalPurchaseOrderNumber)}</span>`:''}</div>
    <div class="req-report-finance"><span><b>Costo unitario actualizado:</b> ${esc(money(unitPrice,curr))}</span>${initial}<span><b>Subtotal solicitado vigente:</b> ${esc(money(a.requested*unitPrice,curr))}</span><span><b>Gasto real recibido:</b> ${esc(money(a.spent,curr))}</span><span><b>Compromiso pendiente:</b> ${esc(money(a.committed,curr))}</span></div>
    <div class="req-report-area"><b>Zona:</b> ${esc(l.zoneName||l.zoneId||'—')} · <b>Subzona:</b> ${esc(l.subzoneName||l.subzoneId||'—')} · <b>Área:</b> ${esc([l.locationCode,l.locationName].filter(Boolean).join(' ')||'—')}</div>
    ${l.descripcion?`<p>${esc(l.descripcion)}</p>`:''}
    ${links?`<div class="req-report-links">${links}</div>`:''}
    <div class="req-report-stock">Solicitado: <b>${a.requested}</b> · Recibido: <b>${a.received}</b> · Cancelado: <b>${a.cancelled}</b> · Pendiente: <b>${a.pending}</b></div>
  </div></article>`;
}
function reportReqHtml(group){
 const lines=group.lines, folio=group.folio||'Sin número asignado', currencies=currencySummary(lines);
 const pieces=lines.reduce((s,l)=>s+amounts(l).requested,0),related=[...new Set(lines.map(l=>l.requestFolio||l.requestId))];
 const tiles=[...currencies.entries()].map(([currency,v])=>`<div class="req-total"><span>Gasto real · ${esc(currency)}</span><strong>${esc(money(v.spent,currency))}</strong><span>Compromiso: ${esc(money(v.committed,currency))}</span><span>Total utilizado: ${esc(money(v.used,currency))}</span></div>`).join('');
 return `<!doctype html><html lang="es"><head><meta charset="utf-8"><base href="${esc(document.baseURI)}"><title>Requisición ${esc(folio)} · PDF extendido</title>
 <style>
 @page{size:A4 landscape;margin:9mm}*{box-sizing:border-box;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}body{font-family:Arial,sans-serif;color:#191919;background:#fff;margin:0}
 .toolbar{text-align:right;padding:8px;border-bottom:1px solid #ccc}.toolbar button{margin-left:8px;padding:6px 12px}.kicker{color:#c8102e;font-weight:700;font-size:9pt;text-transform:uppercase}header{border-bottom:3px solid #c8102e;padding-bottom:9px;margin:6px 0 12px}h1{margin:4px 0;font-size:23pt}header .small{color:#555;font-size:9pt}
 .req-report-totals{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}.req-total{min-width:180px;flex:1;border:1px solid #ccc;padding:9px;border-radius:5px}.req-total span{display:block;font-size:9pt;color:#525c66}.req-total strong{display:block;font-size:13pt;margin:5px 0;color:#171717}
 .req-report-item{display:grid;grid-template-columns:42mm minmax(0,1fr);border:1.5px solid #d2d8df;border-left:6px solid #0d6efd;border-radius:5px;margin:0 0 13px;page-break-inside:avoid;break-inside:avoid;overflow:hidden}.req-report-item.warehouse{border-left-color:#d35400;background:#fff9f4}.req-report-item.received{border-left-color:#198754;background:#f4fcf8}.req-report-item.cancelled{border-left-color:#6c757d}.req-report-photo{border-right:1px solid #eee;padding:10px;display:flex;justify-content:center;align-items:center}.req-report-photo img{max-width:100%;max-height:46mm;object-fit:contain}.req-report-body{padding:10px}.req-report-top{display:flex;justify-content:space-between;gap:9px}.req-report-top h2{font-size:14pt;margin:0 0 4px}.req-report-top .small{color:#666;font-size:8pt}.state-pill{border-radius:20px;font-size:8pt;font-weight:700;color:white;background:#0d6efd;padding:5px 10px;white-space:nowrap;height:max-content}.state-pill.warehouse{background:#d35400}.state-pill.received{background:#198754}.state-pill.cancelled{background:#6c757d}
 .req-report-proc,.req-report-finance{display:flex;flex-wrap:wrap;column-gap:18px;row-gap:4px;padding:7px;margin-top:8px;font-size:9pt;border:1px solid #cfe0f9;background:#f3f8ff}.req-report-finance{border-color:#efd9b8;background:#fff8ed}.req-report-area{font-size:8pt;background:#fafafa;border:1px solid #eee;padding:6px;margin:7px 0}.req-report-body p{font-size:9pt;margin:8px 0}.req-report-links{display:flex;gap:8px;margin:6px 0}.req-report-links a{font-size:8pt;color:#176b3a;border:1px solid #198754;border-radius:15px;padding:5px 9px;text-decoration:none}.req-report-stock{background:#e7f1ff;border-left:5px solid #0d6efd;padding:7px;font-size:9pt;border-radius:3px;margin-top:6px}
 @media print{.toolbar{display:none!important}body{margin:0}}
 </style></head><body><div class="toolbar"><button onclick="window.print()">Imprimir / Guardar PDF</button><button onclick="window.close()">Cerrar</button></div><header><div class="kicker">Universidad Iberoamericana Ciudad de México · FabLab</div><h1>Requisición ${esc(folio)} · PDF extendido</h1><div class="small">${lines.length} líneas / SKU · ${pieces} piezas solicitadas · SC relacionadas: ${esc(related.join(', '))} · Generado: ${esc(new Date().toLocaleString('es-MX'))}</div></header><section class="req-report-totals">${tiles}</section><section>${lines.map(reportReqCard).join('')}</section><script>window.addEventListener('load',()=>{const waits=[...document.images].map(i=>i.complete?Promise.resolve():new Promise(r=>{i.addEventListener('load',r,{once:true});i.addEventListener('error',r,{once:true});}));Promise.race([Promise.all(waits),new Promise(r=>setTimeout(r,6500))]).then(()=>setTimeout(()=>window.print(),300));});<\/script></body></html>`;
}
function printRequisitionExtendedPdf(groupKey){
 const popup=window.open('','_blank');if(!popup){alert('Permite las ventanas emergentes para generar el PDF.');return;}
 popup.document.write('<!doctype html><html lang="es"><title>Preparando requisición</title><body style="font:16px Arial;padding:25px">Preparando PDF extendido de requisición…</body></html>');popup.document.close();
 void (async()=>{
  const bundles=await getBundles(),groups=groupRequisitions(bundles),group=groups.find(g=>g.key===groupKey);
  if(!group||!group.lines.length)throw new Error('No se encontraron productos en esta requisición. Actualiza el listado.');
  popup.document.open();popup.document.write(reportReqHtml(group));popup.document.close();
 })().catch(e=>{console.error('PDF extendido requisición:',e);if(!popup.closed){popup.document.open();popup.document.write(`<p style="font:16px Arial;color:#a00;padding:30px">No se pudo generar el PDF: ${esc(e.message)}</p>`);popup.document.close();}});
}
async function loadPanel(){const content=document.getElementById('iberoRequisitionsContent');if(!content)return;content.innerHTML='<p class="text-muted">Consultando solicitudes y requisiciones en Firestore…</p>';
 try{lastBundles=await getBundles();drawPanel();}catch(e){console.error(e);content.innerHTML=`<div class="alert alert-danger">No se pudo obtener la información actual de Firestore: ${esc(e.message)}</div>`;}
}
function injectLauncher(){
 if(!role)return;
 ensureReadPanel();
 const container=document.querySelector('.purchase-request-launcher')?.parentElement
   ||document.querySelector('.inventory-hero .inventory-lead')?.parentElement;
 if(!container)return;
 // Los cuatro accesos comparten el lugar del botón Requisiciones mostrado
 // junto a Solicitudes de compra y Presupuestos; no quedan debajo de filtros.
 let requisitionButton=container.querySelector('#iberoRequisitionLauncher');
 let box=requisitionButton?.parentElement;
 if(!box){
  box=document.createElement('div');
  box.className='mt-2 d-flex flex-wrap align-items-center gap-2';
  box.innerHTML=`<button type="button" class="btn btn-outline-primary" id="iberoRequisitionLauncher" data-bs-toggle="offcanvas" data-bs-target="#iberoRequisitionsPanel" aria-controls="iberoRequisitionsPanel">Requisiciones</button>`;
  container.append(box);
 }
 box.classList.add('d-flex','flex-wrap','align-items-center','gap-2');
 // Los accesos a importación, fechas y seguimiento se muestran únicamente
 // dentro del panel Requisiciones (organizados por el módulo de avance).
 for(const id of ['iberoProcurementImportLauncherHero','iberoDeliveryBoardLauncherHero','iberoFollowupOpenHero']){
   document.getElementById(id)?.remove();
 }
}
function stop(e){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();}
function capture(e){const t=e.target;if(!(t instanceof Element))return;
 const individual=t.closest('.request-line-requisition');if(individual&&admin()){stop(e);void openIndividual(individual.dataset.requestId,individual.dataset.lineId);return;}
 const wide=t.closest('#requestWideRequisitionSave');if(wide&&admin()){stop(e);void saveMass(wide.closest('#requestWideRequisitionModal'));return;}
 const group=t.closest('#purchaseGroupBatchSave');if(group&&admin()&&group.closest('#purchaseGroupBatchModal')?.dataset.mode==='requisition'){
   stop(e);void saveMass(group.closest('#purchaseGroupBatchModal'));return;
 }
}
function ordinaryClick(e){const t=e.target;if(!(t instanceof Element))return;
 // Los botones del encabezado reutilizan los mismos flujos comprobados
 // que los botones originales en el panel lateral.
 if(t.closest('#iberoRequisitionIndividualSave'))void saveIndividual();
 else if(t.closest('#iberoRequisitionEditorSave'))void saveEditor();
 else if(t.closest('#iberoRequisitionEditButton')){const id=document.querySelector('#purchaseRequestDetailPdf')?.dataset.requestId;if(id)void openEditor(id);}
 else if(t.closest('#iberoRequisitionRefresh'))void loadPanel();
 else if(t.closest('.req-pdf-extended')){e.preventDefault();e.stopPropagation();printRequisitionExtendedPdf(t.closest('.req-pdf-extended').dataset.groupKey);}
 else if(t.closest('.req-zip-individual')){
   e.preventDefault();e.stopPropagation();
   const button=t.closest('.req-zip-individual'),groupKey=button.dataset.groupKey;
   const group=groupRequisitions(lastBundles).find(g=>g.key===groupKey);
   if(!group){alert('No se encontró la requisición. Pulsa «Actualizar» y vuelve a intentarlo.');return;}
   document.dispatchEvent(new CustomEvent('ibero:requisition-sheets',{detail:{group,button}}));
 }
 else if(t.closest('#iberoRequisitionPrintWarehouse'))printWarehouseReport();
 else if(t.closest('#iberoRequisitionSelectAll'))document.querySelectorAll('#iberoRequisitionEditor .req-edit-row:not([hidden]) .req-edit-select').forEach(x=>x.checked=true);
 else if(t.closest('#iberoRequisitionClearAll'))document.querySelectorAll('#iberoRequisitionEditor .req-edit-select').forEach(x=>x.checked=false);
 else if(t.closest('.req-open-sc')){const id=t.closest('.req-open-sc').dataset.requestId;window.bootstrap.Offcanvas.getOrCreateInstance(document.getElementById('iberoRequisitionsPanel')).hide();
  window.setTimeout(()=>{const b=[...document.querySelectorAll('.request-history-view')].find(x=>x.dataset.requestId===id);if(b)b.click();else alert('Actualiza las solicitudes de compra para abrir esta SC.');},350);}
}
async function init(){const user=await waitForUser();if(!user)return;profile=await getUserProfile(user.uid);role=String(profile?.appRole||profile?.role||'');if(role!=='admin'&&role!=='supervisor')return;
 ensureStyle();ensureReadPanel();injectLauncher();ensureDetailButton();
 const obs=new MutationObserver(()=>{injectLauncher();ensureDetailButton();});obs.observe(document.querySelector('.inventory-hero')||document.body,{childList:true,subtree:true});
 document.addEventListener('click',capture,true);document.addEventListener('click',ordinaryClick);
 document.addEventListener('shown.bs.modal',e=>addMassFolioInput(e.target));
 document.addEventListener('purchase-request-detail-rendered',e=>{ensureDetailButton();const id=String(e.detail?.requestId||'');if(id)void showDetailRequisitionNumbers(id);});
 document.addEventListener('show.bs.offcanvas',e=>{if(e.target?.id==='iberoRequisitionsPanel')void loadPanel();});
 document.addEventListener('change',e=>{if(e.target?.id==='iberoRequisitionSort'){requisitionSortMode=e.target.value;drawPanel();}else if(e.target?.id==='iberoRequisitionOnlyWarehouse'){warehouseOnly=e.target.checked;drawPanel();}else if(e.target?.matches?.('#iberoRequisitionsPanel .req-pickup-check'))void toggleWarehouse(e.target);});
 document.addEventListener('input',e=>{if(e.target?.id==='iberoRequisitionSearch')filterReport();if(e.target?.id==='iberoRequisitionEditSearch'){
  const tokens=e.target.value.trim().toLocaleLowerCase('es-MX').split(/\s+/).filter(Boolean);
  document.querySelectorAll('#iberoRequisitionEditor .req-edit-row').forEach(row=>row.hidden=tokens.length>0&&!tokens.every(t=>row.dataset.search.includes(t)));
 }});
}
init().catch(e=>console.error('Requisiciones: no se pudo iniciar el módulo',e));
