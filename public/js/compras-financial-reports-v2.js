/*
 * FabLab IBERO · Reportes y corrección de gastos reales (2026-10-17).
 * Mantiene la conciliación financiera al INICIO de los PDF extendido y agrupado.
 * No añade tablas financieras por SKU al final de esos PDF.
 * Conserva fotografías, fichas, resumen e impresión originales; el desglose
 * detallado sigue disponible en el Excel financiero y en el historial de compras.
 * Las correcciones jamás modifican stock ni la cantidad de artículos recibidos.
 */
import { auth, db } from './firebase-app.js';
import { waitForUser, getUserProfile } from './common.js';
import { collection, doc, getDoc, getDocsFromServer, runTransaction, updateDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { amount, qty, totals, pending, sumLines, money, realSpent } from './compras-financial-ledger.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]));
const fmt = (value, currency='MXN') => { try { return money(value,currency); } catch { return `${Number(value).toFixed(2)} ${currency}`; } };
const lineCollection = rid => collection(db,'purchaseRequests',rid,'items');
const lineDoc = (rid,lid) => doc(db,'purchaseRequests',rid,'items',lid);
const requestDoc = rid => doc(db,'purchaseRequests',rid);
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
const uniqueId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let currentRole = '';
let correctionBusy = false;
let scannedHistory = null;
let historyScanTimer = null;
let pdfIntent = null;
const cache = new Map();
const historyFigures = new Map();
const pendingHistoryButtons = [];
const queuedHistoryButtons = new WeakSet();
let runningHistoryReads = 0;

async function getLines(rid) {
  const path = lineCollection(rid);
  // No se permite sustituir silenciosamente cifras financieras actuales por caché local.
  const snapshot = await getDocsFromServer(path);
  return snapshot.docs.map(d=>({id:d.id,...d.data()}));
}
async function getBundle(rid) {
  const [lines,snapshot] = await Promise.all([getLines(rid),getDoc(requestDoc(rid))]);
  if(!snapshot.exists()) throw new Error('Solicitud no encontrada.');
  return {lines,request:{id:snapshot.id,...snapshot.data()},summary:sumLines(lines)};
}
function cachedBundle(rid,ttlMs=12000) {
  const old=cache.get(rid);
  if(old && Date.now()-old.started<ttlMs)return old.promise;
  const entry={started:Date.now(),promise:getBundle(rid)};
  cache.set(rid,entry);
  entry.promise.catch(()=>{if(cache.get(rid)===entry)cache.delete(rid);});
  return entry.promise;
}
function clearCache(rid='') {
  if(rid)cache.delete(rid);else cache.clear();
}
function summaryHtml(sums) {
  return [...sums].map(([currency,t])=>{
    const balance=t.original-t.active;
    return `<div class="finance-summary-currency"><div class="finance-currency-title">${esc(currency)}</div>
    <div class="finance-summary-grid">
      <div><span>Importe originalmente solicitado</span><strong>${esc(fmt(t.original,currency))}</strong></div>
      <div><span>Gasto real recibido</span><strong>${esc(fmt(t.spent,currency))}</strong></div>
      <div><span>Compromiso pendiente</span><strong>${esc(fmt(t.commitment,currency))}</strong></div>
      <div><span>Total utilizado</span><strong>${esc(fmt(t.active,currency))}</strong></div>
    </div><p class="finance-summary-balance">Diferencia respecto al importe original: <b>${esc(fmt(balance,currency))}</b> ${balance>=0?'(menor costo, descuentos y/o cancelaciones)':'(sobrecosto)'}</p></div>`;
  }).join('');
}

// No añadimos columnas a la tabla de SC, para preservar su visualización móvil.
async function fillHistoryRow(button) {
  const rid=String(button?.dataset.requestId||'');if(!rid)return;
  const row=button.closest('tr');if(!row)return;
  const totalCell=row.querySelector('td:nth-child(6)');
  if(!totalCell)return;
  let area=totalCell.querySelector('.finance-history-figures');
  if(!area){
    area=document.createElement('div');area.className='finance-history-figures small mt-1';
    area.style.cssText='min-width:180px;font-size:.82rem;line-height:1.5;';
    area.textContent='Calculando gasto real…';totalCell.append(area);
  }
  const token=uniqueId();area.dataset.token=token;
  try {
    const {summary}=await cachedBundle(rid,3000);
    if(!area.isConnected||area.dataset.token!==token)return;
    historyFigures.set(rid,summary);
    drawGlobalHistoryTotals();
    area.innerHTML=[...summary].map(([currency,t])=>`
      <div class="py-1 border-top">
        <div><span class="text-muted">Recibido (real):</span> <b class="text-success">${esc(fmt(t.spent,currency))}</b></div>
        <div><span class="text-muted">Comprometido:</span> ${esc(fmt(t.commitment,currency))}</div>
        <div><span class="text-muted">Utilizado:</span> <b>${esc(fmt(t.active,currency))}</b></div>
      </div>`).join('');
    const actions=button.parentElement;
    if(actions&&!actions.querySelector('.finance-history-xlsx')){
      const x=document.createElement('button');x.type='button';x.className='btn btn-outline-success btn-sm finance-history-xlsx';x.dataset.requestId=rid;x.textContent='Excel financiero';actions.append(x);
    }
  }catch(error){if(area.isConnected && area.dataset.token===token){area.textContent=`Gasto actual no disponible: ${error.message}`;}}
}
function drawGlobalHistoryTotals(){
  const root=document.querySelector('#purchaseRequestHistory');
  if(!root)return;
  const buttons=[...root.querySelectorAll('.request-history-view[data-request-id]')];
  if(!buttons.length)return;
  const ids=[...new Set(buttons.map(b=>b.dataset.requestId))];
  const missing=ids.filter(id=>!historyFigures.has(id));
  let banner=root.querySelector('#financeHistoryGrandTotal');
  if(!banner){banner=document.createElement('div');banner.id='financeHistoryGrandTotal';banner.className='mb-3 p-3 border rounded bg-light';root.prepend(banner);}
  if(missing.length){
    const label=`Calculando conciliación general: ${ids.length-missing.length} de ${ids.length} solicitudes…`;
    if(banner.textContent!==label)banner.textContent=label;
    return;
  }
  const totalsAll=new Map();
  for(const id of ids){
    for(const [currency,v] of historyFigures.get(id)){
      if(!totalsAll.has(currency))totalsAll.set(currency,{original:0,spent:0,commitment:0,active:0});
      const t=totalsAll.get(currency);
      for(const k of Object.keys(t))t[k]+=amount(v[k]);
    }
  }
  const html=`<h3 class="h6 mb-2">Conciliación general · ${ids.length} solicitudes</h3>
    ${[...totalsAll].map(([c,v])=>`<div class="mb-2"><strong>${esc(c)}</strong>
      <div class="d-flex gap-3 flex-wrap small">
        <span>Importe solicitado: <b>${esc(fmt(v.original,c))}</b></span>
        <span>Gasto real recibido: <b class="text-success">${esc(fmt(v.spent,c))}</b></span>
        <span>Compromiso pendiente: <b>${esc(fmt(v.commitment,c))}</b></span>
        <span>Total utilizado: <b>${esc(fmt(v.active,c))}</b></span>
      </div></div>`).join('')}
    <div class="small text-muted">El gasto real corresponde a productos recibidos; los importes comprometidos corresponden a unidades pendientes no canceladas.</div>`;
  if(banner.innerHTML!==html)banner.innerHTML=html;
}
function pumpHistoryReads(){
  while(runningHistoryReads<4 && pendingHistoryButtons.length){
    const button=pendingHistoryButtons.shift();
    if(!button.isConnected){queuedHistoryButtons.delete(button);continue;}
    runningHistoryReads++;
    fillHistoryRow(button).finally(()=>{
      runningHistoryReads--;
      queuedHistoryButtons.delete(button);
      pumpHistoryReads();
    });
  }
}
function scanHistory(force=false) {
  const root=document.querySelector('#purchaseRequestHistory');
  if(!root)return;
  const buttons=[...root.querySelectorAll('.request-history-view[data-request-id]')];
  if(force){historyFigures.clear();root.querySelector('#financeHistoryGrandTotal')?.remove();for(const button of buttons)button.closest('tr')?.querySelector('.finance-history-figures')?.remove();}
  const missing=buttons.filter(b=>!b.closest('tr')?.querySelector('.finance-history-figures'));
  for(const btn of missing){if(queuedHistoryButtons.has(btn))continue;queuedHistoryButtons.add(btn);pendingHistoryButtons.push(btn);}
  pumpHistoryReads();
  drawGlobalHistoryTotals();
}
function startHistoryWatcher(){
  const root=document.querySelector('#purchaseRequestHistory');
  if(!root||root===scannedHistory)return;
  scannedHistory=root;
  const watcher=new MutationObserver(()=>{
    clearTimeout(historyScanTimer);
    historyScanTimer=setTimeout(()=>scanHistory(),90);
  });
  watcher.observe(root,{childList:true,subtree:true});
  scanHistory();
}

// Se prepara la ventana del generador ORIGINAL y sólo se añaden los totales.
// El print nativo espera que Firestore entregue los datos, para no imprimir cifras viejas.
function financialPdfCss(){return `
.finance-pdf-overview{border:1px solid #aab6c5;border-left:5px solid #0d6efd;background:#f5f9ff;padding:9px;margin:10px 0 14px;break-inside:avoid;font-family:Arial,sans-serif;}
.finance-pdf-overview h2{font-size:13pt;margin:0 0 5px;color:#162c4c;}
.finance-summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;}
.finance-summary-grid>div{padding:7px;background:white;border:1px solid #dfe5ed;border-radius:3px;}
.finance-summary-grid span{display:block;color:#56616c;font-size:8pt;}
.finance-summary-grid strong{font-size:11pt;color:#171717;display:block;margin-top:3px;}
.finance-currency-title{font-size:9pt;font-weight:700;margin:5px 0;}
.finance-summary-balance{font-size:8pt;margin:5px 0 8px;}
@media print{.finance-pdf-overview{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}
`;}
function injectPdfFinance(popup,bundle){
  try {
    const dom=popup.document;
    const root=dom.querySelector('.page');
    const header=root?.querySelector('header');
    if(!root||!header)return false; // El PDF agrupado muestra antes un HTML de espera.
    if(root.querySelector('.finance-pdf-overview'))return true;
    const style=dom.createElement('style');style.textContent=financialPdfCss();dom.head.append(style);
    const section=dom.createElement('section');section.className='finance-pdf-overview';
    section.innerHTML=`<h2>Conciliación de presupuesto · importes actualizados</h2>
    ${summaryHtml(bundle.summary)}
    <p style="font-size:8pt;margin:3px 0">Gasto real = recepción registrada; compromiso pendiente = unidades no recibidas ni canceladas × costo vigente. Las cantidades canceladas no comprometen presupuesto. No equivale necesariamente a facturas pagadas.</p>`;
    const originalSummary=root.querySelector('.summary,.top-summary');
    (originalSummary||header).insertAdjacentElement('afterend',section);
    return true;
  }catch(error){console.error('No se pudo enriquecer el PDF:',error);return false;}
}
function setupPopup(popup,intent) {
  const nativePrint=popup.print.bind(popup);
  let printing=false;
  const ready=async()=>{
    const bundle=await intent.promise;
    for(let n=0;n<180;n++){
      if(popup.closed)return false;
      if(injectPdfFinance(popup,bundle))return true;
      await wait(100);
    }
    throw new Error('El PDF no terminó de generarse.');
  };
  popup.print=function(){
    if(printing)return;
    printing=true;
    void ready().then(ok=>{if(ok)nativePrint();}).catch(err=>{
      console.error(err);
      popup.alert?.(`No fue posible incorporar los datos financieros: ${err.message}. Cierra esta ventana y vuelve a intentarlo.`);
    }).finally(()=>{printing=false;});
  };
  intent.promise.then(bundle=>{
    // En exportaciones grupales se abre primero una página temporal.
    for(let i=0;i<20;i++)setTimeout(()=>{if(!popup.closed)injectPdfFinance(popup,bundle);},150*i);
  }).catch(err=>console.error('Datos financieros PDF:',err));
}
function installPopupUpgrade(){
  const originalOpen=window.open.bind(window);
  window.open=function(...args){
    const popup=originalOpen(...args);
    const intent=pdfIntent;
    if(popup && intent && Date.now()-intent.started<30000 && String(args[0]??'')===''){
      pdfIntent=null;
      setupPopup(popup,intent);
    }
    return popup;
  };
}
function onPdfClick(event){
  const button=event.target.closest?.('.request-history-pdf,#purchaseRequestDetailPdf,.request-history-pdf-grouped,#purchaseRequestDetailPdfGrouped');
  if(!button)return;
  const rid=String(button.dataset.requestId||document.querySelector('#purchaseRequestDetailPdf')?.dataset.requestId||'');
  if(!rid)return;
  clearCache(rid);
  pdfIntent={rid,started:Date.now(),promise:cachedBundle(rid,0)};
  // No detenemos el handler original; éste conserva fotografías, filtros y diseño.
}

async function exportFinancialXlsx(rid){
  if(!window.XLSX){alert('No está disponible el exportador XLSX.');return;}
  const {lines,request,summary}=await getBundle(rid);
  const X=window.XLSX,book=X.utils.book_new();
  const rows=lines.map(l=>{const t=totals(l);return [l.sku||'',l.nombre||'',l.zoneId||'',l.subzoneId||'',t.currency,t.requested,t.received,t.cancelled,t.pending,
    amount(l.originalUnitPrice??l.unitPrice),amount(l.unitPrice),t.original,t.spent,t.commitment,t.active];});
  X.utils.book_append_sheet(book,X.utils.aoa_to_sheet([
    ['SC',request.folio||rid,'Alias',request.alias||'', 'Exportado',new Date().toLocaleString('es-MX')],
    ['SKU','Nombre','Zona','Subzona','Moneda','Solicitado','Recibido','Cancelado','Pendiente','Precio original','Precio vigente','Solicitado original','Gasto real','Compromiso','Total utilizado'],...rows]),'Conciliación SC');
  X.utils.book_append_sheet(book,X.utils.aoa_to_sheet([
    ['Moneda','Importe original','Gasto real recibido','Compromiso vigente','Total utilizado','Diferencia'],
    ...[...summary].map(([c,s])=>[c,s.original,s.spent,s.commitment,s.active,s.original-s.active])]),'Totales');
  const reception=[['SKU','Artículo','ID recepción','Fecha','Piezas','Costo unitario vigente','Subtotal','Moneda','Usuario']];
  const adjustments=[['SKU','Artículo','Fecha corrección','ID recepción','Tipo','Costo previo','Costo nuevo','Diferencia gasto','Motivo','Usuario']];
  for(const l of lines){
    for(const e of (Array.isArray(l.receiptHistory)?l.receiptHistory:[]))reception.push([l.sku||'',l.nombre||'',e.id||'',e.at||'',qty(e.quantity),amount(e.unitCost),qty(e.quantity)*amount(e.unitCost),e.currency||l.currency||'MXN',e.userId||'']);
    for(const a of (Array.isArray(l.receiptCostCorrections)?l.receiptCostCorrections:[]))adjustments.push([l.sku||'',l.nombre||'',a.at||'',a.receiptId||'',a.kind||'',a.previousValue,a.newValue,a.deltaTotal,a.reason||'',a.userId||'']);
  }
  X.utils.book_append_sheet(book,X.utils.aoa_to_sheet(reception),'Recepciones');
  X.utils.book_append_sheet(book,X.utils.aoa_to_sheet(adjustments),'Correcciones');
  X.writeFile(book,`${String(request.folio||rid).replace(/[^A-Za-z0-9_-]/g,'_')}_gasto_real.xlsx`);
}

function correctionModal(){
  let m=document.querySelector('#financeCorrectReceiptModal');
  if(m)return m;
  m=document.createElement('div');m.id='financeCorrectReceiptModal';m.className='modal fade';m.tabIndex=-1;
  m.innerHTML=`<div class="modal-dialog modal-xl modal-dialog-scrollable"><div class="modal-content">
    <div class="modal-header"><div><h5 class="modal-title">Corregir gasto real registrado</h5><div class="small text-muted">Sólo administrador. La corrección se audita y no cambia las piezas recibidas ni el stock.</div></div><button class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button></div>
    <div class="modal-body"><div class="alert alert-info py-2 small">Modifica el costo de una recepción concreta o el importe global de recepciones antiguas sin desglose. No cambia el precio estimado ni el costo de requisición; el catálogo tampoco cambia retroactivamente. Es obligatorio indicar el motivo.</div>
      <input id="financeCorrectSearch" class="form-control mb-3" placeholder="Buscar por SKU o nombre">
      <div id="financeCorrectRows" class="table-responsive">Cargando…</div>
    </div><div class="modal-footer"><button class="btn btn-secondary" data-bs-dismiss="modal">Cerrar</button></div>
  </div></div>`;
  document.body.append(m);
  m.addEventListener('hidden.bs.modal',()=>{
    const rid=m.dataset.requestId||'';
    if(rid){document.querySelector(`.request-history-view[data-request-id="${CSS.escape(rid)}"]`)?.click();}
  });
  m.querySelector('#financeCorrectSearch').addEventListener('input',e=>{
    const q=e.target.value.toLocaleLowerCase('es-MX');
    m.querySelectorAll('.finance-correction-row').forEach(el=>{el.hidden=!el.dataset.search.includes(q);});
  });
  return m;
}
function correctionRows(lines){
  const items=[];
  for(const l of lines){
    if(qty(l.quantityReceived)<1)continue;
    const history=Array.isArray(l.receiptHistory)?l.receiptHistory:[];
    const recordedQty=history.reduce((sum,e)=>sum+qty(e.quantity),0);
    const recordedMoney=history.reduce((sum,e)=>sum+qty(e.quantity)*amount(e.unitCost),0);
    const legacyQty=Math.max(0,qty(l.quantityReceived)-recordedQty);
    const legacyTotal=realSpent(l)-recordedMoney;
    for(const [eventIndex,event] of history.entries()){
      items.push({l,event,eventIndex,kind:'receipt',quantity:qty(event.quantity),value:amount(event.unitCost),subtotal:qty(event.quantity)*amount(event.unitCost),when:event.at||'Sin fecha'});
    }
    if(legacyQty>0 || (history.length===0 && qty(l.quantityReceived)>0)){
      items.push({l,kind:'legacy',quantity:legacyQty||qty(l.quantityReceived),value:legacyTotal,subtotal:legacyTotal,when:'Histórico anterior sin desglose'});
    }
  }
  return items;
}
async function openCorrection(rid){
  if(currentRole!=='admin')return;
  const m=correctionModal();m.dataset.requestId=rid;m.querySelector('#financeCorrectSearch').value='';
  m.querySelector('#financeCorrectRows').textContent='Consultando recepciones…';
  const detail=document.querySelector('#purchaseRequestDetailModal');
  if(detail?.classList.contains('show')){
    detail.addEventListener('hidden.bs.modal',()=>bootstrap.Modal.getOrCreateInstance(m).show(),{once:true});
    bootstrap.Modal.getOrCreateInstance(detail).hide();
  }else bootstrap.Modal.getOrCreateInstance(m).show();
  try {
    clearCache(rid);const {lines}=await cachedBundle(rid,0);
    const entries=correctionRows(lines);
    if(!entries.length){m.querySelector('#financeCorrectRows').textContent='Esta solicitud no tiene recepciones registradas.';return;}
    m.querySelector('#financeCorrectRows').innerHTML=`<table class="table table-sm align-middle"><thead><tr><th>Artículo</th><th>Recepción</th><th>Cantidad</th><th>Costo actual</th><th>Importe de esta recepción</th><th>Nuevo ${entries.some(e=>e.kind==='legacy')?'costo / importe':''}</th><th>Motivo obligatorio</th><th></th></tr></thead><tbody>${entries.map((r,i)=>`
      <tr class="finance-correction-row" data-line-id="${esc(r.l.id)}" data-kind="${r.kind}" data-event-id="${esc(r.event?.id||`idx:${r.eventIndex}`)}" data-currency="${esc(r.l.currency||'MXN')}" data-original="${r.value}" data-search="${esc(`${r.l.sku} ${r.l.nombre}`.toLocaleLowerCase('es-MX'))}">
      <td><strong>${esc(r.l.sku||r.l.id)}</strong><div class="small">${esc(r.l.nombre||'')}</div></td>
      <td><span class="small">${esc(r.when)}</span>${r.kind==='legacy'?'<div class="text-warning-emphasis small">Sin desglose histórico</div>':''}</td>
      <td>${r.quantity}</td><td>${esc(fmt(r.value,r.l.currency||'MXN'))}${r.kind==='legacy'?'<div class="small text-muted">Importe global</div>':''}</td>
      <td>${esc(fmt(r.subtotal,r.l.currency||'MXN'))}</td>
      <td><input class="form-control form-control-sm finance-correct-value" type="number" step="0.01" min="0" style="min-width:100px" value="${r.value.toFixed(2)}" aria-label="${r.kind==='legacy'?'Nuevo importe total histórico':'Nuevo costo unitario'}"></td>
      <td><input class="form-control form-control-sm finance-correct-reason" maxlength="250" placeholder="Ej. Error de captura" style="min-width:165px"></td>
      <td><button type="button" class="btn btn-sm btn-outline-primary finance-correct-save">Guardar corrección</button></td></tr>`).join('')}</tbody></table>`;
  }catch(e){m.querySelector('#financeCorrectRows').textContent=`No se pudieron consultar las recepciones: ${e.message}`;}
}
async function saveCorrection(button){
  if(correctionBusy||currentRole!=='admin')return;
  const m=correctionModal(), rid=m.dataset.requestId, row=button.closest('.finance-correction-row');
  const lid=row?.dataset.lineId, kind=row?.dataset.kind, eventId=row?.dataset.eventId||'';
  const next=Number(row?.querySelector('.finance-correct-value')?.value);
  const prev=Number(row?.dataset.original);
  const reason=String(row?.querySelector('.finance-correct-reason')?.value||'').trim();
  if(!rid||!lid||!['receipt','legacy'].includes(kind))return;
  if(!Number.isFinite(next)||next<0||!Number.isFinite(prev)||prev<0){alert('El costo debe ser un número mayor o igual a cero.');return;}
  if(Math.abs(next-prev)<0.005){alert('El valor nuevo es igual al registrado.');return;}
  if(reason.length<8){alert('Escribe un motivo de al menos 8 caracteres para auditar la corrección.');return;}
  const label=kind==='receipt'?'costo unitario de esta recepción':'importe acumulado de recepciones históricas';
  const currency=row?.dataset.currency||'MXN';
  if(!confirm(`¿Corregir ${label} de ${fmt(prev,currency)} a ${fmt(next,currency)}?\n\nMotivo: ${reason}\n\nNo se modificarán existencias ni cantidades recibidas.`))return;
  correctionBusy=true;button.disabled=true;
  try{
    await runTransaction(db,async tx=>{
      const lr=lineDoc(rid,lid),rr=requestDoc(rid);
      const [snap,rootSnap]=await Promise.all([tx.get(lr),tx.get(rr)]);
      if(!snap.exists()||!rootSnap.exists()||rootSnap.data().status==='draft')throw new Error('Línea o solicitud no válida.');
      const l=snap.data(), history=Array.isArray(l.receiptHistory)?l.receiptHistory.map(x=>({...x})):[];
      const received=qty(l.quantityReceived),writtenMoney=history.reduce((s,e)=>s+qty(e.quantity)*amount(e.unitCost),0);
      const currentTotal=realSpent(l), priorCorrections=Array.isArray(l.receiptCostCorrections)?l.receiptCostCorrections:[];
      let delta=0,previous=0, patch={};
      if(kind==='receipt'){
        const index=eventId.startsWith('idx:')?Number(eventId.slice(4)):history.findIndex(e=>String(e.id||'')===eventId);
        if(!Number.isSafeInteger(index)||index<0||index>=history.length||qty(history[index].quantity)<1)throw new Error('La recepción ya no existe o no tiene identificador válido.');
        previous=amount(history[index].unitCost);
        if(Math.abs(previous-prev)>0.005)throw new Error('Otro usuario cambió el costo: recarga la ventana.');
        delta=(next-previous)*qty(history[index].quantity);
        history[index].unitCost=next;
        patch.receiptHistory=history;
        if(index===history.length-1)patch.lastActualUnitCost=next;
      }else{
        const legacyQty=received-history.reduce((s,e)=>s+qty(e.quantity),0);
        if(legacyQty<=0)throw new Error('Esta línea ya no tiene recepciones históricas sin detalle.');
        previous=currentTotal-writtenMoney;
        if(previous<-.01)throw new Error('Los importes no concuerdan: solicita una conciliación manual.');
        if(Math.abs(previous-prev)>0.005)throw new Error('El gasto histórico fue modificado por otro usuario. Recarga.');
        delta=next-previous;
      }
      const newTotal=currentTotal+delta;
      if(newTotal<-.005)throw new Error('La corrección produciría un gasto negativo.');
      const audit={id:uniqueId(),at:new Date().toISOString(),userId:auth.currentUser?.uid||'',receiptId:kind==='receipt'?eventId:null,
        kind,previousValue:previous,newValue:next,deltaTotal:delta,reason,currency:l.currency||'MXN'};
      tx.update(lr,{...patch,actualCostTotal:Math.max(0,newTotal),
        receiptCostCorrections:[...priorCorrections,audit],lastActualCostCorrectionAt:serverTimestamp(),updatedAt:serverTimestamp()});
      tx.update(rr,{updatedAt:serverTimestamp()});
    });
    clearCache(rid);
    const {lines}=await getBundle(rid),sums=sumLines(lines);
    const spentTotalsByCurrency={},currentTotalsByCurrency={},pendingTotalsByCurrency={};
    for(const [currency,s] of sums){spentTotalsByCurrency[currency]=s.spent;pendingTotalsByCurrency[currency]=s.commitment;currentTotalsByCurrency[currency]=s.active;}
    let aggregatesUpdated=true;
    try{
      await updateDoc(requestDoc(rid),{spentTotalsByCurrency,pendingTotalsByCurrency,currentTotalsByCurrency,updatedAt:serverTimestamp()});
    }catch(error){
      aggregatesUpdated=false;
      console.warn('La corrección fue guardada, pero el resumen agregado requiere actualización:',error);
    }
    clearCache(rid);
    document.querySelector('#financeFiscalLedger')?.remove();
    document.querySelector('#refreshPurchaseRequests')?.click();
    document.querySelector('#refreshPurchaseBudgets')?.click();
    document.dispatchEvent(new CustomEvent('purchase:finance-reconciled',{detail:{requestId:rid}}));
    await openCorrection(rid);
    alert(aggregatesUpdated
      ? 'Corrección guardada y auditada. Gasto real y presupuesto actualizados; existencias intactas.'
      : 'Corrección guardada y auditada. No se actualizó el resumen agregado de la SC; actualiza la página y revisa el presupuesto. Las existencias no cambiaron.');
  }catch(error){console.error('Corrección de recepción',error);alert(`No se pudo corregir el gasto: ${error.message}`);}
  finally{correctionBusy=false;button.disabled=false;}
}
function decorateCorrectionButton(){
  if(currentRole!=='admin')return;
  const footer=document.querySelector('#purchaseRequestDetailModal .modal-footer');
  if(!footer||footer.querySelector('#financeCorrectReceiptOpen'))return;
  const button=document.createElement('button');button.type='button';button.id='financeCorrectReceiptOpen';
  button.className='btn btn-outline-primary';button.textContent='Corregir gasto real';
  footer.prepend(button);
}
function init(){
  installPopupUpgrade();
  document.addEventListener('click',onPdfClick,true);
  document.addEventListener('click',event=>{
    const t=event.target;
    if(!(t instanceof Element))return;
    const change=t.closest('#financeCorrectReceiptOpen');
    if(change){const id=document.querySelector('#purchaseRequestDetailPdf')?.dataset.requestId;if(id)void openCorrection(id);return;}
    const save=t.closest('.finance-correct-save');if(save){void saveCorrection(save);return;}
    const exportButton=t.closest('.finance-history-xlsx');
    if(exportButton){void exportFinancialXlsx(exportButton.dataset.requestId).catch(e=>alert(e.message));return;}
  });
  document.addEventListener('purchase-request-detail-rendered',decorateCorrectionButton);
  document.addEventListener('purchase:finance-reconciled',event=>{
    const rid=String(event.detail?.requestId||'');clearCache(rid);
    const row=[...document.querySelectorAll('#purchaseRequestHistory .request-history-view')].find(b=>b.dataset.requestId===rid);
    historyFigures.delete(rid);
    if(row)void fillHistoryRow(row);
  });
  document.addEventListener('click',e=>{
    if(e.target.closest?.('#refreshPurchaseRequests')){clearCache();setTimeout(()=>scanHistory(true),900);}
  });
  const bodyWatch=new MutationObserver(()=>{startHistoryWatcher();decorateCorrectionButton();});
  bodyWatch.observe(document.body,{childList:true,subtree:false});
  const initial=setInterval(()=>{startHistoryWatcher();decorateCorrectionButton();if(scannedHistory)clearInterval(initial);},500);
  startHistoryWatcher();decorateCorrectionButton();
}
waitForUser().then(async user=>{
  if(!user)return;
  const profile=await getUserProfile(user.uid);
  currentRole=String(profile?.appRole||profile?.role||'').toLowerCase();
  if(currentRole==='admin'||currentRole==='supervisor')init();
}).catch(err=>console.error('Error al iniciar conciliación avanzada',err));
