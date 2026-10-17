/* FabLab IBERO: folio externo de requisición, captura individual/masiva,
   edición retrospectiva y consulta agrupada de sólo lectura.
   Requiere los módulos de compras cargados previamente desde compras.html.
   Ninguna escritura cambia stock, cantidades recibidas o gasto real histórico. */
import { auth,db } from './firebase-app.js';
import { getUserProfile,waitForUser } from './common.js';
import { collection,doc,getDoc,getDocsFromServer,runTransaction,serverTimestamp,updateDoc } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { n,q,pending,folioKey,cleanFolio,amounts,stage,groupRequisitions } from './compras-requisitions-model.js';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=(amount,currency='MXN')=>{try{return new Intl.NumberFormat('es-MX',{style:'currency',currency}).format(n(amount));}catch{return `${n(amount).toFixed(2)} ${currency}`;}};
const reqRef=id=>doc(db,'purchaseRequests',id);
const lineRef=(id,lineId)=>doc(db,'purchaseRequests',id,'items',lineId);
const linesRef=id=>collection(db,'purchaseRequests',id,'items');
const stamp=()=>new Date().toISOString();
let role='',profile=null,busy=false,restoreDetailId='',lastBundles=[],viewFilter='';
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
// requisitada sin su folio cuando el usuario proporciona uno.
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
  .req-report-card .table{font-size:.87rem}
  .req-folio-inline{border:1px solid #b6d4fe;background:#eff6ff;padding:.7rem;border-radius:.5rem;margin:.6rem 0}
  .req-number-input{max-width:540px}
  #iberoRequisitionsPanel .offcanvas-body{background:#fff}
  #iberoRequisitionEditor .modal-dialog{max-width:980px}
  @media(max-width:760px){#iberoRequisitionsPanel{width:100vw!important}.req-report-card .table{min-width:940px}}
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
 try {requireAdmin();const snap=await getDoc(lineRef(requestId,lineId));if(!snap.exists())throw new Error('No se encontró el artículo.');
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
 try{requireAdmin();const lines=(await fetchLines(requestId)).filter(l=>l.requisitionStatus==='requisitioned');if(!lines.length)throw new Error('Esta SC todavía no tiene artículos requisitados.');
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
 <div class="offcanvas-body"><div class="d-flex gap-2 flex-wrap align-items-center mb-3"><input id="iberoRequisitionSearch" type="search" class="form-control flex-grow-1" placeholder="Buscar requisición, SKU, producto, SC o alias" style="max-width:580px"><button id="iberoRequisitionRefresh" class="btn btn-outline-primary" type="button">Actualizar</button></div><div id="iberoRequisitionsContent"><p class="text-muted">Consulta pendiente…</p></div></div>`;
 document.body.append(panel);return panel;
}
function groupHtml(g,index){
 const data=[...g.currencies.entries()].map(([currency,v])=>`<div class="border rounded p-2 small"><strong>${esc(currency)}</strong><div>Gasto real: <strong>${esc(money(v.spent,currency))}</strong></div><div>Compromiso: <strong>${esc(money(v.committed,currency))}</strong></div><div>Total utilizado: <strong>${esc(money(v.used,currency))}</strong></div></div>`).join('');
 const statuses=new Set(g.lines.map(stage));
 return `<details class="req-report-card" data-search="${esc([g.folio,...g.lines.flatMap(l=>[l.sku,l.nombre,l.requestFolio,l.requestAlias]),...statuses].join(' ').toLocaleLowerCase('es-MX'))}">
 <summary>${esc(g.folio||'Sin número asignado')} ${g.unassigned?`<span class="badge text-bg-warning ms-2">SC ${esc(g.lines[0]?.requestFolio||'')}</span>`:''} <span class="text-secondary small ms-2">${g.lines.length} SKU · ${g.requestIds.size} SC</span></summary>
 <div class="mt-2"><div class="small text-muted mb-2">Estados: ${esc([...statuses].join(' · '))}</div><div class="d-flex gap-2 flex-wrap">${data}</div>
 <div class="table-responsive mt-3"><table class="table table-sm align-middle"><thead><tr><th>SC</th><th>SKU</th><th>Artículo</th><th>Estado</th><th class="text-end">Solicitado</th><th class="text-end">Recibido</th><th class="text-end">Cancelado</th><th class="text-end">Pendiente</th><th class="text-end">Gasto real</th><th class="text-end">Compromiso</th></tr></thead><tbody>
 ${g.lines.map(l=>{const t=amounts(l);return `<tr><td><button type="button" class="btn btn-link btn-sm p-0 req-open-sc" data-request-id="${esc(l.requestId)}">${esc(l.requestFolio||'SC')}</button><div class="small text-muted">${esc(l.requestAlias)}</div></td><td>${esc(l.sku||'')}</td><td>${esc(l.nombre||'')}</td><td>${esc(stage(l))}</td><td class="text-end">${t.requested}</td><td class="text-end">${t.received}</td><td class="text-end">${t.cancelled}</td><td class="text-end">${t.pending}</td><td class="text-end">${esc(money(t.spent,t.currency))}</td><td class="text-end">${esc(money(t.committed,t.currency))}</td></tr>`;}).join('')}</tbody></table></div></div></details>`;
}
function drawPanel(){const content=document.getElementById('iberoRequisitionsContent');if(!content)return;
 const groups=groupRequisitions(lastBundles);const allLines=groups.flatMap(g=>g.lines),spentBy=new Map(),commitBy=new Map();
 for(const l of allLines){const t=amounts(l);spentBy.set(t.currency,(spentBy.get(t.currency)||0)+t.spent);commitBy.set(t.currency,(commitBy.get(t.currency)||0)+t.committed);}
 const currencies=[...new Set([...spentBy.keys(),...commitBy.keys()])];
 content.innerHTML=`<div class="small text-muted mb-2">${groups.length} grupos de requisición · ${allLines.length} líneas · ${new Set(allLines.map(l=>l.requestId)).size} solicitudes con requisición</div>
 <div class="req-report-summary">${currencies.map(c=>`<span><strong>${esc(c)}</strong> · Gasto real ${esc(money(spentBy.get(c)||0,c))} · Comprometido ${esc(money(commitBy.get(c)||0,c))}</span>`).join('')}</div>
 ${groups.length?groups.map(groupHtml).join(''):'<p class="alert alert-info">No hay artículos registrados en requisición.</p>'}`;
 filterReport();
}
function filterReport(){const search=document.getElementById('iberoRequisitionSearch');const raw=(search?.value||'').trim().toLocaleLowerCase('es-MX');const tokens=raw.split(/\s+/).filter(Boolean);
 document.querySelectorAll('#iberoRequisitionsContent .req-report-card').forEach(card=>{card.hidden=tokens.length>0&&!tokens.every(t=>card.dataset.search.includes(t));});}
async function loadPanel(){const content=document.getElementById('iberoRequisitionsContent');if(!content)return;content.innerHTML='<p class="text-muted">Consultando solicitudes y requisiciones en Firestore…</p>';
 try{lastBundles=await getBundles();drawPanel();}catch(e){console.error(e);content.innerHTML=`<div class="alert alert-danger">No se pudo obtener la información actual de Firestore: ${esc(e.message)}</div>`;}
}
function injectLauncher(){if(!role)return;ensureReadPanel();let container=document.querySelector('.purchase-request-launcher')?.parentElement||document.querySelector('.inventory-hero .inventory-lead')?.parentElement;if(!container)return;
 if(container.querySelector('#iberoRequisitionLauncher'))return;
 const box=document.createElement('div');box.className='mt-2';box.innerHTML=`<button type="button" class="btn btn-outline-primary" id="iberoRequisitionLauncher" data-bs-toggle="offcanvas" data-bs-target="#iberoRequisitionsPanel" aria-controls="iberoRequisitionsPanel">Requisiciones</button>`;container.append(box);
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
 if(t.closest('#iberoRequisitionIndividualSave'))void saveIndividual();
 else if(t.closest('#iberoRequisitionEditorSave'))void saveEditor();
 else if(t.closest('#iberoRequisitionEditButton')){const id=document.querySelector('#purchaseRequestDetailPdf')?.dataset.requestId;if(id)void openEditor(id);}
 else if(t.closest('#iberoRequisitionRefresh'))void loadPanel();
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
 document.addEventListener('input',e=>{if(e.target?.id==='iberoRequisitionSearch')filterReport();if(e.target?.id==='iberoRequisitionEditSearch'){
  const tokens=e.target.value.trim().toLocaleLowerCase('es-MX').split(/\s+/).filter(Boolean);
  document.querySelectorAll('#iberoRequisitionEditor .req-edit-row').forEach(row=>row.hidden=tokens.length>0&&!tokens.every(t=>row.dataset.search.includes(t)));
 }});
}
init().catch(e=>console.error('Requisiciones: no se pudo iniciar el módulo',e));
