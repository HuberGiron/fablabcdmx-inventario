/* FabLab IBERO | Importación supervisada de reportes de Requisición de Material.
 * PDF se lee en el navegador; jamás se carga a servidores externos.
 * Las propuestas no escriben Firestore hasta que el administrador acepta los renglones.
 * El precio "Real" del PDF significa cotizado por Compras, NO gasto recibido.
 */
import {auth,db} from './firebase-app.js';
import {getUserProfile,waitForUser} from './common.js';
import {collection,doc,getDoc,getDocs,getDocsFromServer,runTransaction,updateDoc,serverTimestamp} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import {parseProcurementReport,suggestMatches,matchingScore,externalStage,institutionalRank} from './compras-pdf-parser.js?v=20261017i';
const $=sel=>document.querySelector(sel);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const n=v=>{const x=Number(v);return Number.isFinite(x)?x:0;};
const pending=l=>Math.max(0,n(l.quantityRequested)-n(l.quantityReceived)-n(l.quantityCancelled));
const amount=(v,c='MXN')=>new Intl.NumberFormat('es-MX',{style:'currency',currency:c}).format(n(v));
const dateText=v=>v?new Date(`${v}T12:00:00`).toLocaleDateString('es-MX',{day:'2-digit',month:'short',year:'numeric'}):'Sin fecha';
const lineKey=l=>`${l.requestId}::${l.id}`;
const docLine=l=>doc(db,'purchaseRequests',l.requestId,'items',l.id);
const refs=v=>Array.isArray(v)?v:[];
let role='',profile=null,allLines=[],allRequests=[],parsed=null,proposals=[],activePdfName='',digest='',isBusy=false,boardMode='all';
const admin=()=>role==='admin';
function pendingBudget(l){return pending(l)*n(l.unitPrice);}
function currentStage(l){
 if(pending(l)===0)return n(l.quantityReceived)>0?'Recibido':'Cancelado';
 if(l.warehousePickupPending)return 'En almacén';
 if(l.requisitionStatus==='requisitioned')return 'En requisición';
 return 'En compras';
}
function stageTone(l){const a=currentStage(l);return a==='Recibido'?'success':a==='En almacén'?'orange':a==='En requisición'?'primary':'secondary';}
function importedStageLabel(s){return {requisition:'En requisición',warehouse:'En almacén',received:'Entregado al usuario',partial:'Entregado parcial',unknown:'Sin equivalencia automática',none:'No cambiar'}[s]||s;}
async function loadUser(){const user=auth.currentUser||await waitForUser();if(!user)throw new Error('Inicia sesión.');profile=await getUserProfile(user.uid);role=profile?.appRole||profile?.role||'';if(role!=='admin'&&role!=='supervisor')throw new Error('Este módulo está disponible para Compras.');}
async function listLines(onProgress=()=>{}){
 await loadUser();const snap=await getDocsFromServer(collection(db,'purchaseRequests'));
 allRequests=snap.docs.filter(d=>d.data().status!=='draft').map(d=>({id:d.id,...d.data()}));
 const found=[];let cursor=0,done=0;
 const workers=Array.from({length:Math.min(5,allRequests.length)},async()=>{
  while(cursor<allRequests.length){const req=allRequests[cursor++];
   try{const sub=await getDocsFromServer(collection(db,'purchaseRequests',req.id,'items'));
    for(const d of sub.docs)found.push({id:d.id,...d.data(),requestId:req.id,requestFolio:req.folio||req.id,requestAlias:req.alias||''});}
   catch(e){console.warn('No se pudo consultar SC',req.id,e);}
   onProgress(++done,allRequests.length);
  }
 });await Promise.all(workers);allLines=found;
 return found;
}
function moneyGross(p){
 const q=p.quoted;
 if(!q)return null;
 // Reportes cotizados en USD requieren conversión verificada; no etiquetar USD como MXN.
 if(String(q.currency||'MXN').toUpperCase()==='USD')return null;
 if(Number.isFinite(q.totalWithTax)&&Number.isFinite(q.quantity)&&q.quantity>0)
  return Math.round(q.totalWithTax/q.quantity*100)/100;
  // Se toma el IVA desglosado cuando exista; si falta, se calcula con el 16%.
  // Sólo sobre la cotización REAL (nunca sobre el presupuesto Estimado).
  if(Number.isFinite(q.unitPrice)&&q.unitPrice>=0){
    const iva = Number.isFinite(q.vatTotal)&&q.vatTotal>=0 ? q.vatTotal : q.unitPrice * 0.16;
    return Math.round((q.unitPrice + iva)*100)/100;
  }
 return null;
}
function receiptState(line){
 const received=Math.max(0,n(line?.quantityReceived)), remaining=line?pending(line):0;
 return {received,remaining,fullyReceived:received>0&&remaining===0,
   partiallyReceived:received>0&&remaining>0};
}
function checkRow(tr,checkDuplicates=true){
 const errors=[],product=parsed?.products?.[Number(tr.dataset.index)];
 const key=tr.querySelector('.imp-target')?.value||'';
 const line=allLines.find(l=>lineKey(l)===key);
 const proposedStage=tr.querySelector('.imp-stage-select')?.value||'none';
 if(!product){errors.push('El producto del PDF no está disponible.');return errors;}
 if(!line)errors.push('Vincula una solicitud de compra y SKU del FabLab.');
 const dateActive=tr.querySelector('.imp-date')?.checked;
 const dateValue=tr.querySelector('.imp-date-value')?.value||'';
 if(dateActive&&(!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)||Number.isNaN(Date.parse(dateValue))))errors.push('Completa una fecha estimada válida o desmarca su actualización.');
 const priceActive=tr.querySelector('.imp-price')?.checked;
 const priceRaw=tr.querySelector('.imp-price-value')?.value||'';
 const priceValue=Number(priceRaw);
 if(priceActive&&(!priceRaw.trim()||!Number.isFinite(priceValue)||priceValue<0))errors.push('Completa un precio unitario válido con IVA.');
 if(!['none','requisition','warehouse','received','partial'].includes(proposedStage))errors.push('Selecciona un estado válido.');
 if(line){
   const stock=receiptState(line),actualState=currentStage(line);
   if(stock.remaining>0 && externalStage(product.externalStatus)==='received' && proposedStage!=='received')errors.push('Compras indica «Entregado al usuario». Debes confirmar la recepción pendiente o deseleccionar el artículo; no se puede omitir la confirmación cambiando la etapa.');
   if(stock.fullyReceived && externalStage(product.externalStatus)!=='received')errors.push(`Ya existe recepción en FabLab (${stock.received} pieza(s)) y el PDF trae «${product.externalStatus}». Se bloquea la actualización para no retroceder. Desmarca este artículo.`);
   if(stock.fullyReceived && proposedStage!=='none'&&proposedStage!=='received')errors.push(`Ya contabilizado: ${stock.received} pieza(s) recibidas. No se permite retroceder «${actualState}» a una etapa anterior.`);
   if(stock.remaining===0 && stock.received===0 && proposedStage!=='none')errors.push('Esta línea está cancelada; no se puede cambiar a un estado operativo activo.');
   const oldRank=institutionalRank(line.externalReportedStatus),newRank=institutionalRank(product.externalStatus);
   if(oldRank>=0 && newRank>=0 && newRank<oldRank)errors.push(`El último seguimiento era «${line.externalReportedStatus}». No se permite retroceder a «${product.externalStatus}».`);
   if(parsed?.reportDate && line.externalReportDate && parsed.reportDate<String(line.externalReportDate))errors.push(`Existe un reporte más reciente (${line.externalReportDate}); no puede sobrescribirse.`);
   if(line.requisitionNumber&&String(line.requisitionNumber)!==String(product.folio) && !tr.querySelector('.imp-confirm-reassign')?.checked)errors.push(`La línea pertenece a la requisición ${line.requisitionNumber}. Confirma expresamente la reasignación.`);
   if(line.externalProcurementItemCode&&String(line.externalProcurementItemCode)!==String(product.externalCode) && !tr.querySelector('.imp-confirm-reassign')?.checked)errors.push(`Código institucional diferente: ${line.externalProcurementItemCode}. Confirma su reasignación.`);
   const receiptControl=tr.querySelector('.imp-receive');
   const receive=proposedStage==='received'&&receiptControl?.checked;
   const qtyRaw=tr.querySelector('.imp-receive-qty')?.value||'';
   const qty=Number(qtyRaw);
   if(proposedStage==='received' && stock.remaining>0){
     if(!receive)errors.push('Confirma explícitamente la recepción física para guardar «Entregado al usuario».');
     if(receive && (!qtyRaw.trim()||!Number.isInteger(qty)||qty<1||qty>stock.remaining))errors.push(`Indica una cantidad nueva válida (1–${stock.remaining}).`);
     if(receive && product.quantity!=null && Number.isFinite(Number(product.quantity)) && qty>Math.max(0,Number(product.quantity)-stock.received))errors.push('La cantidad excede el total institucional después de descontar lo ya recibido.');
   }
   if(stock.fullyReceived&&receive)errors.push('Esta recepción ya está contabilizada. No se puede volver a ingresar inventario.');
   const prior=refs(line.externalImportReceiptEvidence);
   const receiptEvidence=`${product.folio}:${product.externalCode}:${product.externalStatus}:${product.quantity}:${product.expectedDate}`;
   const receiptId=`${digest.slice(0,24)}:${product.externalCode}`;
   if(receive&&(refs(line.externalImportReceiptFingerprints).includes(receiptId)||prior.includes(receiptEvidence)))errors.push('Esta recepción del reporte ya fue aplicada anteriormente.');
   const unit=String(product.purchaseUnit||'').toUpperCase();
   if((priceActive||receive)&&unit&&unit!=='PZA'&&unit!=='PZAS'&&!tr.querySelector('.imp-verify-units')?.checked)errors.push(`La presentación institucional es ${unit}. Confirma su equivalencia con la unidad del FabLab.`);
 }
 return errors;
}

function labelLine(l){return `${l.requestFolio} · ${l.sku||''} · ${l.nombre||''} (${n(l.quantityRequested)} solicitadas)`;}
function currentLineHtml(l){
 if(!l)return '<div class="imp-unlinked">Aún no hay una coincidencia vinculada al FabLab. Selecciona el artículo correcto antes de aplicar.</div>';
 return `<div class="imp-fablab-details">
  <div class="imp-inline-meta"><strong>SC:</strong> ${esc(l.requestFolio||l.requestId||'—')}
   ${l.requestAlias?`<span class="imp-alias">Alias: ${esc(l.requestAlias)}</span>`:''}</div>
  <div class="imp-inline-meta"><strong>SKU FabLab:</strong> ${esc(l.sku||'—')} · <strong>Solicitado:</strong> ${n(l.quantityRequested)} · <strong>Pendiente:</strong> ${pending(l)}</div>
  <div class="imp-fablab-name">${esc(l.nombre||'Sin nombre')}</div>
  <div class="imp-description"><strong>Descripción del inventario FabLab:</strong> ${esc(l.descripcion||'No registrada')}</div>
  <div class="imp-note mt-2"><strong>Actualmente:</strong> ${esc(currentStage(l))} · ${esc(amount(l.unitPrice,l.currency||'MXN'))} · fecha ${esc(l.externalExpectedDeliveryDate?dateText(l.externalExpectedDeliveryDate):'sin registrar')}</div>
 </div>`;
}
function sourceLabel(p){return `${p.externalCode} · ${p.description}`;}
function makeStyles(){if($('#iberoImportStyle'))return;const s=document.createElement('style');s.id='iberoImportStyle';s.textContent=`
 #iberoImportModal .modal-dialog{max-width:1580px;width:min(96vw,1580px);margin-left:auto;margin-right:auto}
 #iberoImportModal .modal-body{overflow-x:hidden}
 #iberoImportModal .imp-products{display:grid;gap:1rem}
 #iberoImportModal .imp-row{background:#fff;border:1px solid #cdd5df;border-radius:11px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)}
 #iberoImportModal .imp-row-heading{display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap;padding:.85rem 1rem;background:#f5f7fa;border-bottom:1px solid #dee3ea}
 #iberoImportModal .imp-row-heading .form-check{margin:0}
 #iberoImportModal .imp-compare{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1rem;padding:1rem}
 #iberoImportModal .imp-source,#iberoImportModal .imp-select{min-width:0;border-radius:8px;padding:1rem;border:1px solid #d9e0ea;background:#fff}
 #iberoImportModal .imp-target{display:block;box-sizing:border-box;width:100%;max-width:100%;min-width:0}
 #iberoImportModal .imp-source{border-left:5px solid #5b6575}
 #iberoImportModal .imp-select{border-left:5px solid #c8102e}
 #iberoImportModal .imp-section-title{font-size:.73rem;letter-spacing:.05em;text-transform:uppercase;font-weight:800;margin-bottom:.6rem;color:#4b5563}
 #iberoImportModal .imp-product-name{font-size:1rem;line-height:1.45;font-weight:750;overflow-wrap:anywhere}
 #iberoImportModal .imp-description{font-size:.84rem;line-height:1.5;white-space:normal;overflow-wrap:anywhere;margin-top:.5rem}
 #iberoImportModal .imp-fablab-name{font-size:.96rem;font-weight:750;line-height:1.4;margin-top:.5rem;overflow-wrap:anywhere}
 #iberoImportModal .imp-inline-meta{font-size:.79rem;margin-top:.35rem;overflow-wrap:anywhere}
 #iberoImportModal .imp-alias{display:inline-block;background:#fff3cd;color:#362706;border-radius:5px;padding:.15rem .35rem;margin-left:.4rem}
 #iberoImportModal .imp-unlinked{font-size:.84rem;font-weight:650;color:#8b1e28;border:1px dashed #d9a4aa;background:#fff7f7;border-radius:6px;padding:.6rem;margin-top:.5rem}
 #iberoImportModal .imp-match-suggestion{font-size:.8rem;margin-top:.5rem;padding:.55rem;border:1px solid #d8e0ee;background:#f9fbff;border-radius:6px;overflow-wrap:anywhere}
 #iberoImportModal .imp-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.8rem;padding:0 1rem 1rem}
 #iberoImportModal .imp-data-box{min-width:0;border:1px solid #dee3e9;border-radius:8px;padding:.8rem .85rem;background:#fff}
 #iberoImportModal .imp-data-box .form-control,#iberoImportModal .imp-data-box .form-select{width:100%;min-width:0}
 #iberoImportModal .imp-note{font-size:.76rem;color:#596575;line-height:1.45}
 #iberoImportModal .imp-confidence{border-radius:7px;border:2px solid transparent;padding:.38rem .65rem;display:inline-flex;gap:.35rem;align-items:center;white-space:normal;font-size:.84rem;font-weight:800}
 #iberoImportModal .imp-conf-high{background:#146c43;border-color:#0e5030;color:#fff}
 #iberoImportModal .imp-conf-medium{background:#ffca2c;border-color:#9d6500;color:#191919}
 #iberoImportModal .imp-conf-low{background:#a61d32;border-color:#771226;color:#fff}
 #iberoImportModal .imp-ambiguous{border-left:5px solid #b02a37}
  #iberoImportModal .imp-validation{margin:0 1rem 1rem;padding:.65rem .9rem;border:1px solid #dc3545;background:#fff6f6;color:#7a1825;border-radius:7px;font-size:.85rem}
  #iberoImportModal .imp-validation.is-valid{border-color:#198754;background:#f2faf5;color:#0e5e38}
  #iberoImportModal .imp-locked{margin-top:.45rem;padding:.55rem .65rem;border-radius:7px;background:#fff3cd;color:#5d4200;border:1px solid #ddb653;font-size:.8rem}
  #iberoImportModal .imp-controls{border-top:1px solid #e0e5ea;padding:.65rem 1rem;background:#f9fafb}
 #iberoImportModal .imp-check{transform:scale(1.12)}
 #iberoImportModal .imp-banner{border-left:4px solid #0d6efd;background:#f0f5fd;padding:.7rem 1rem}
 #iberoImportModal .imp-progress{font-size:.86rem}
 #iberoImportModal .imp-receipt-box{border-left:4px solid #198754;background:#f0faf4;padding:.65rem;margin-top:.6rem;border-radius:5px}
 #iberoImportModal .imp-data-box[hidden],#iberoImportModal .imp-receipt-box[hidden]{display:none!important}
 #iberoDeliveryBoardModal .modal-dialog{max-width:1250px}
 #iberoDeliveryBoardModal .delivery-overdue{background:#fff1f0}
 #iberoDeliveryBoardModal .delivery-soon{background:#fff9e8}
 #iberoDeliveryBoardModal .delivery-warehouse{background:#fff0e2}
 #iberoDeliveryBoardModal .delivery-date{font-weight:700;white-space:nowrap}
 #iberoDeliveryBoardModal .table{font-size:.85rem}
 @media(max-width:1050px){#iberoImportModal .imp-actions{grid-template-columns:repeat(2,minmax(0,1fr))}}
 @media(max-width:760px){#iberoImportModal .modal-dialog,#iberoDeliveryBoardModal .modal-dialog{width:calc(100vw - 1rem);margin:.5rem}#iberoImportModal .imp-compare,#iberoImportModal .imp-actions{grid-template-columns:minmax(0,1fr)}#iberoImportModal .imp-row-heading{align-items:flex-start}#iberoImportModal .imp-source,#iberoImportModal .imp-select{padding:.8rem}}
 `;document.head.append(s);}
function ensureModal(){
 let m=$('#iberoImportModal');if(m)return m;
 m=document.createElement('div');m.id='iberoImportModal';m.className='modal fade';m.tabIndex=-1;
 m.innerHTML=`<div class="modal-dialog modal-xl modal-dialog-scrollable"><div class="modal-content">
 <div class="modal-header"><div><h5 class="modal-title">Importar reporte institucional de requisición</h5><div class="small text-muted">PDF de intraweb · análisis local y aprobación por artículo</div></div><button class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button></div>
 <div class="modal-body">
 <div class="d-flex flex-wrap align-items-end gap-3 mb-3"><div class="flex-grow-1"><label class="form-label" for="iberoImportFile">Reporte de Requisición de Material (.pdf)</label><input id="iberoImportFile" class="form-control" accept="application/pdf,.pdf" type="file"></div>
 <button id="iberoImportRead" class="btn btn-primary" type="button">Analizar PDF y buscar coincidencias</button></div>
 <div class="imp-banner small mb-3"><strong>Regla contable:</strong> el precio «Real» del PDF es una cotización institucional, incluso si el estado es «Por Surtir». Registrar una recepción requiere marcar la casilla correspondiente e indicar cuántas piezas llegaron. Los precios propuestos incluyen IVA por defecto, pero no se modifican sin tu autorización.</div>
 <div id="iberoImportProgress" class="imp-progress text-muted mb-2" role="status"></div>
 <div id="iberoImportResults"></div></div>
 <div class="modal-footer"><span id="iberoImportFooter" class="small text-muted me-auto"></span><button class="btn btn-secondary" data-bs-dismiss="modal" type="button">Cerrar</button><button id="iberoImportSave" type="button" class="btn btn-success" disabled>Aplicar cambios seleccionados</button></div>
 </div></div>`;document.body.append(m);return m;
}
function boardModal(){let m=$('#iberoDeliveryBoardModal');if(m)return m;
 m=document.createElement('div');m.id='iberoDeliveryBoardModal';m.className='modal fade';m.tabIndex=-1;
 m.innerHTML=`<div class="modal-dialog modal-xl modal-dialog-scrollable"><div class="modal-content">
 <div class="modal-header"><div><h5 class="modal-title">Tablero de fechas de entrega · FabLab</h5><div class="small text-muted">Fecha prometida por Compras, estado y requisición institucional</div></div><button class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button></div>
 <div class="modal-body"><div class="d-flex gap-2 flex-wrap align-items-center mb-3"><select id="iberoBoardFilter" class="form-select" style="max-width:270px"><option value="all">Todos los artículos</option><option value="pending">Pendientes por recibir</option><option value="overdue">Fechas vencidas</option><option value="warehouse">En almacén por recoger</option><option value="received">Recibidos</option></select><input id="iberoBoardSearch" class="form-control" type="search" style="max-width:350px" placeholder="Buscar requisición, SKU o producto"><button id="iberoBoardRefresh" class="btn btn-outline-primary" type="button">Actualizar</button></div>
 <div id="iberoBoardBody" class="table-responsive"></div></div><div class="modal-footer"><button class="btn btn-outline-dark" id="iberoBoardPrint" type="button">Imprimir tablero</button><button class="btn btn-secondary" data-bs-dismiss="modal">Cerrar</button></div></div></div>`;
 document.body.append(m);return m;}
function injectButtons(){const host=$('#iberoRequisitionsPanel .offcanvas-header');if(!host||$('#iberoProcurementImportLauncher'))return;
 host.classList.add('flex-wrap','gap-2');const btns=document.createElement('div');btns.className='d-flex flex-wrap gap-2 ms-2';btns.innerHTML=`<button id="iberoProcurementImportLauncher" type="button" class="btn btn-outline-primary btn-sm">Importar PDF Compras</button><button id="iberoDeliveryBoardLauncher" type="button" class="btn btn-outline-secondary btn-sm">Fechas de entrega</button>`;
 host.insertBefore(btns,host.lastElementChild);
}
function setProgress(text){const el=$('#iberoImportProgress');if(el)el.textContent=text;}
let pdfPromise=null;
function pdfLibrary(){if(pdfPromise)return pdfPromise;
 pdfPromise=new Promise((resolve,reject)=>{
  if(window.pdfjsLib){resolve(window.pdfjsLib);return;}
  const src='https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  const s=document.createElement('script');s.src=src;s.onload=()=>window.pdfjsLib?resolve(window.pdfjsLib):reject(new Error('No se pudo cargar PDF.js.'));s.onerror=()=>reject(new Error('No se pudo descargar PDF.js. Comprueba tu conexión o CSP.'));
  document.head.append(s);
 }).then(pdf=>{pdf.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';return pdf;}).catch(e=>{pdfPromise=null;throw e;});return pdfPromise;
}
async function parsePdf(file){
 const pdfjs=await pdfLibrary();const bytes=new Uint8Array(await file.arrayBuffer());
 let hex='';if(window.crypto?.subtle){const hash=await crypto.subtle.digest('SHA-256',bytes);hex=Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');}
 else {let h=2166136261;for(const v of bytes)h=Math.imul(h^v,16777619);hex=(h>>>0).toString(16);}
 const task=pdfjs.getDocument({data:bytes});const pdf=await task.promise;const pages=[];
 for(let i=1;i<=pdf.numPages;i++){
  setProgress(`Leyendo página ${i} de ${pdf.numPages}…`);
  const page=await pdf.getPage(i),view=page.getViewport({scale:1}),content=await page.getTextContent();
  pages.push({items:content.items.filter(t=>t.str&&t.transform).map(t=>({str:t.str,x:t.transform[4]/view.width*595.32,y:(view.height-t.transform[5])/view.height*841.92}))});
 }
 const report=parseProcurementReport(pages);
 if(!report.recognized)throw new Error(`No se pudo interpretar el formato del reporte. ${report.notes.join(' ')}`);
 return {report,hash:hex};
}
function productRow(p,i){
 const suggestion=proposals[i]||{options:[],suggested:'',ambiguous:true},best=suggestion.options?.[0],target=suggestion.suggested||'';
 const conf=best?.score||0,confClass=conf>=.83?'high':conf>=.62?'medium':'low';
 const selectedLine=allLines.find(x=>lineKey(x)===target);
 const options=(suggestion.options||[]).map(l=>`<option value="${esc(lineKey(l))}" ${target===lineKey(l)?'selected':''}>${esc(labelLine(l))} · ${Math.round(l.score*100)}%</option>`).join('');
 const s=externalStage(p.externalStatus),gross=moneyGross(p);
 const priceValid=gross!==null&&Number.isFinite(gross)&&gross>=0;
 const quoteUnit=String(p.quoted?.currency||'MXN').toUpperCase();
 const priceText=priceValid?Number(gross).toFixed(2):'';
 const isVatEstimated=Boolean(p.quoted && !Number.isFinite(p.quoted.totalWithTax) && !Number.isFinite(p.quoted.vatTotal) && Number.isFinite(p.quoted.unitPrice));
 const obs=p.quantity==null?'Cantidad no legible':`PDF: ${p.quantity} ${p.purchaseUnit||'unidad(es)'}`;
 const confLabel=best?`${Math.round(conf*100)}% de similitud`:'Sin coincidencia';
 const suggested=best?`<div class="imp-match-suggestion"><strong>Mejor propuesta (no vinculada):</strong> ${esc(best.nombre||'Sin nombre')}<br><strong>SC:</strong> ${esc(best.requestFolio||'—')} ${best.requestAlias?`· <strong>Alias:</strong> ${esc(best.requestAlias)}`:''}<br><strong>SKU:</strong> ${esc(best.sku||'—')}</div>`:'';
 return `<article class="imp-row ${suggestion.ambiguous?'imp-ambiguous':''}" data-index="${i}">
  <div class="imp-row-heading">
    <label class="form-check d-flex gap-2 align-items-center fw-bold"><input type="checkbox" class="form-check-input imp-apply imp-check" checked aria-label="Aplicar ${esc(p.description)}"> Agregar o actualizar este artículo</label>
    <span class="imp-confidence imp-conf-${confClass}" role="status">${esc(confLabel)}</span>
  </div>
  <div class="imp-compare">
    <section class="imp-source" aria-label="Datos institucionales de Compras">
      <div class="imp-section-title">Descripción del reporte institucional de Compras</div>
      <div class="imp-product-name">${esc(p.description||'Sin descripción')}</div>
      <div class="imp-inline-meta"><strong>Código de Compras:</strong> ${esc(p.externalCode||'—')} · ${esc(obs)}</div>
      <div class="imp-inline-meta"><strong>Orden de compra:</strong> ${esc(p.purchaseOrder||'—')}</div>
      <div class="imp-inline-meta"><strong>Estado institucional:</strong> ${esc(p.externalStatus||'—')}</div>
    </section>
    <section class="imp-select" aria-label="Propuesta de correspondencia del FabLab">
      <div class="imp-section-title">Descripción propuesta del inventario FabLab</div>
      <label class="form-label small fw-semibold mb-1">Seleccionar SC y SKU correspondientes</label>
      <select class="form-select form-select-sm imp-target"><option value="">Selecciona una coincidencia</option>${options}</select>
      <button class="btn btn-link btn-sm p-0 mt-2 imp-find" type="button">Buscar otro SKU / SC</button>
      <div class="imp-suggested">${!target?suggested:''}</div>
      <div class="imp-current">${currentLineHtml(selectedLine)}</div>
    </section>
  </div>
  <div class="imp-actions">
    <section class="imp-data-box"><div class="imp-section-title">Requisición y fecha estimada</div>
      <div><strong>Requisición:</strong> ${esc(p.folio||'—')}</div><div class="small mt-1">Entrega esperada: ${esc(dateText(p.expectedDate))}</div>
      <label class="d-flex gap-2 align-items-center mt-2"><input type="checkbox" class="form-check-input imp-date" ${p.expectedDate?'checked':'disabled'}> Guardar fecha estimada</label>
      <label class="form-label small mt-2 mb-1">Ajustar fecha, si es necesario</label><input class="form-control form-control-sm imp-date-value" type="date" value="${esc(p.expectedDate)}">
    </section>
    <section class="imp-data-box"><div class="imp-section-title">Cotización final de Compras</div>
      <div class="small">Sin IVA (${esc(quoteUnit)}): <strong>${p.quoted?.unitPrice!=null?esc(amount(p.quoted.unitPrice,quoteUnit==='USD'?'USD':'MXN')):'—'}</strong></div>
      <div class="small mt-1">Con IVA / unidad en MXN: <strong>${priceValid?esc(amount(gross)):'No disponible'}</strong></div>
      ${isVatEstimated?'<div class="small mt-1 text-primary fw-semibold">IVA no desglosado: se calculó el 16% sobre el precio real institucional.</div>':''}
      <label class="d-flex gap-2 align-items-center mt-2"><input class="form-check-input imp-price" type="checkbox" ${priceValid?'checked':'disabled'}> <strong>Actualizar precio</strong></label>
      <label class="form-label small mt-2 mb-1">Precio unitario a registrar (MXN, IVA incluido)</label><input class="form-control form-control-sm imp-price-value" type="number" step="0.01" min="0" value="${priceText}" ${priceValid?'':'disabled'}>
      ${!priceValid?'<div class="imp-note mt-2 text-danger fw-semibold">El PDF no permite calcular con certeza el precio unitario con IVA. Se omite la actualización del precio hasta revisarlo.</div>':''}
    </section>
    <section class="imp-data-box"><div class="imp-section-title">Etapa propuesta y recepción física</div>
      <label class="form-label small mb-1">Estado institucional que se guardará</label>
      <select class="form-select form-select-sm imp-stage-select">
       <option value="requisition" ${s==='requisition'?'selected':''}>En requisición</option>
       <option value="warehouse" ${s==='warehouse'?'selected':''}>En almacén</option>
       <option value="received" ${s==='received'?'selected':''}>Entregado al usuario</option>
       <option value="partial" ${s==='partial'?'selected':''}>Entregado parcial (informativo)</option>
       <option value="none" ${s==='unknown'?'selected':''}>No cambiar etapa</option>
      </select>
      <div class="imp-receipt-box" ${s==='received'?'':'hidden'}>
        <label class="d-flex gap-2 align-items-center"><input type="checkbox" class="form-check-input imp-receive"> <strong>Confirmo recepción física en FabLab</strong></label>
        <label class="form-label small mt-2 mb-1">Piezas que efectivamente recibimos</label><input type="number" class="form-control form-control-sm imp-receive-qty" min="0" step="1" value="0">
        <div class="imp-note mt-1">Confirma únicamente las piezas nuevas que todavía no se hayan registrado. Esta acción aumenta existencias y gasto real una sola vez.</div>
      </div>
      <div class="imp-note mt-2">Los demás estados guardan seguimiento sin recibir material. Si el artículo ya está recibido, no se duplica inventario y no se permite retroceder de estado.</div>
      <div class="imp-receipt-accounted imp-locked" ${s==='received'&&selectedLine&&receiptState(selectedLine).fullyReceived?'':'hidden'}>Recepción ya contabilizada en FabLab. No se volverán a agregar unidades ni a registrar gasto.</div>
    </section>
  </div>
  <div class="imp-controls">
   <label class="d-flex gap-2 align-items-center small imp-unit-verification" hidden><input type="checkbox" class="form-check-input imp-verify-units"> Confirmo que revisé la equivalencia entre la presentación del PDF y la unidad registrada en FabLab.</label>
   <label class="d-flex gap-2 align-items-center small imp-reassign-verification" hidden><input type="checkbox" class="form-check-input imp-confirm-reassign"> Autorizo corregir el folio o código institucional asociado anteriormente a este SKU.</label>
  </div>
  <div class="imp-validation" role="status" aria-live="polite"></div>
 </article>`;
}
function refreshMatchCard(row){
 if(!row)return;
 const index=Number(row.dataset.index),product=parsed?.products?.[index];
 const selected=allLines.find(l=>lineKey(l)===row.querySelector('.imp-target')?.value);
 const best=proposals[index]?.options?.[0];
 const score=selected&&product?matchingScore(product,selected):(best?.score||0);
 const tone=score>=.83?'high':score>=.62?'medium':'low';
 const badge=row.querySelector('.imp-confidence');
 if(badge){badge.className=`imp-confidence imp-conf-${tone}`;badge.textContent=best||selected?`${Math.round(score*100)}% de similitud`:'Sin coincidencia';}
 const box=row.querySelector('.imp-suggested');
 if(box)box.hidden=Boolean(selected);
 const current=row.querySelector('.imp-current');
 if(current)current.innerHTML=currentLineHtml(selected);
 row.classList.toggle('imp-ambiguous',!selected||score<.83);
}
function syncReceiptVisibility(row){
 if(!row)return;
 const product=parsed?.products?.[Number(row.dataset.index)];
 const line=allLines.find(l=>lineKey(l)===row.querySelector('.imp-target')?.value);
 const state=receiptState(line),sel=row.querySelector('.imp-stage-select');
 const show=sel?.value==='received'&&(!line||state.remaining>0);
 const section=row.querySelector('.imp-receipt-box');if(section)section.hidden=!show;
 const accounted=row.querySelector('.imp-receipt-accounted');if(accounted)accounted.hidden=sel?.value!=='received'||!state.fullyReceived;
 const check=row.querySelector('.imp-receive'),qty=row.querySelector('.imp-receive-qty');
 if(!show){if(check)check.checked=false;if(qty)qty.value='0';}
 if(check)check.disabled=!show;
 if(qty){qty.disabled=!show;qty.max=String(state.remaining);}
 if(line && state.fullyReceived&&sel && !['none','received'].includes(sel.value))sel.value='none';
 const unit=String(product?.purchaseUnit||'').toUpperCase();
 const needUnit=Boolean(unit&&unit!=='PZA'&&unit!=='PZAS'&&(row.querySelector('.imp-price')?.checked||check?.checked));
 const unitField=row.querySelector('.imp-unit-verification');if(unitField)unitField.hidden=!needUnit;
 if(!needUnit){const confirm=row.querySelector('.imp-verify-units');if(confirm)confirm.checked=false;}
 const needsReassign=Boolean(line&&((line.requisitionNumber&&String(line.requisitionNumber)!==String(product?.folio))||(line.externalProcurementItemCode&&String(line.externalProcurementItemCode)!==String(product?.externalCode))));
 const reassignField=row.querySelector('.imp-reassign-verification');if(reassignField)reassignField.hidden=!needsReassign;
 if(!needsReassign){const confirm=row.querySelector('.imp-confirm-reassign');if(confirm)confirm.checked=false;}
}
function renderValidation(){
 const seen=new Map();let blocked=0,valid=0;
 for(const row of document.querySelectorAll('#iberoImportResults .imp-row')){
  const selected=row.querySelector('.imp-apply')?.checked;
  const errors=selected?checkRow(row):[];
  const key=row.querySelector('.imp-target')?.value||'';
  if(selected&&key){if(seen.has(key)){errors.push('Este SKU ya está asignado a otro artículo seleccionado.');const previous=seen.get(key);const prev=row.querySelector('.imp-validation');if(prev)prev.innerHTML='';previous.dataset.duplicate='true';}else seen.set(key,row);}
  const box=row.querySelector('.imp-validation');
  if(box){box.hidden=!selected;
   box.classList.toggle('is-valid',selected&&!errors.length);
   box.innerHTML=selected?(errors.length?`<strong>Pendiente de corregir:</strong><ul class="mb-0 mt-1">${errors.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:'<strong>Lista para aplicar.</strong> Datos y confirmaciones completos.'):'';
  }
  row.classList.toggle('imp-ambiguous',selected&&errors.length>0);
  if(selected){if(errors.length)blocked++;else valid++;}
 }
 // Duplicados detectados después del primer seleccionado: invalidar también al primero.
 for(const row of document.querySelectorAll('#iberoImportResults .imp-row[data-duplicate="true"]')){
  const box=row.querySelector('.imp-validation');if(box){box.hidden=false;box.classList.remove('is-valid');box.textContent='Pendiente de corregir: este SKU ya está asignado a otro artículo seleccionado.';}
  row.classList.add('imp-ambiguous');row.removeAttribute('data-duplicate');blocked++;valid=Math.max(0,valid-1);
 }
 const selected=selectedRows().length;
 const footer=$('#iberoImportFooter');if(footer)footer.textContent=`${selected} de ${parsed?.products?.length||0} seleccionados · ${valid} completos · ${blocked} pendientes de corregir`;
 const save=$('#iberoImportSave');if(save){save.disabled=!admin()||isBusy||!selected||blocked>0;save.title=blocked?`${blocked} artículos seleccionados requieren completar o corregir datos.`:'';}
}
let searchingRow=-1;
function chooseModal(){let m=$('#iberoImportMatchModal');if(m)return m;
 m=document.createElement('dialog');m.className='rounded-3 border shadow-lg p-0';m.id='iberoImportMatchModal';m.style.cssText='width:min(850px,96vw);max-height:85vh;z-index:2000;';
 m.innerHTML=`<div class="p-3"><div class="d-flex justify-content-between align-items-center mb-3"><h5 class="mb-0">Vincular artículo al inventario FabLab</h5><button class="btn-close iberoMatchClose" type="button" aria-label="Cerrar"></button></div><div><p class="small" id="iberoMatchDescription"></p><input id="iberoMatchSearch" type="search" class="form-control mb-3" placeholder="Nombre, SKU, SC o alias"><div id="iberoMatchList" class="list-group" style="max-height:60vh;overflow:auto"></div></div><div class="d-flex justify-content-end mt-3"><button class="btn btn-secondary iberoMatchClose" type="button">Cerrar</button></div></div>`;
 document.body.append(m);return m;
}
function renderCandidates(){
 const list=$('#iberoMatchList');if(!list)return;const p=parsed?.products?.[searchingRow];if(!p)return;
 const query=($('#iberoMatchSearch')?.value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
 const words=query.split(/\s+/).filter(Boolean);
 const candidates=allLines.filter(l=>words.every(w=>`${l.sku} ${l.nombre} ${l.requestFolio} ${l.requestAlias}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().includes(w)))
  .map(l=>({...l,match:matchingScore(p,l)})).sort((a,b)=>b.match-a.match).slice(0,65);
 list.innerHTML=candidates.length?candidates.map(l=>`<button type="button" class="list-group-item list-group-item-action iberoMatchChoice" data-key="${esc(lineKey(l))}"><strong>${esc(l.sku||'')}</strong> ${esc(l.nombre||'')}<div class="small text-muted">${esc(l.requestFolio)} · ${esc(l.requestAlias)} · ${Math.round(l.match*100)}% similitud</div></button>`).join(''):'<p class="small text-muted">Sin coincidencias. Prueba términos más cortos.</p>';
}
async function reviewFile(){if(isBusy)return;const file=$('#iberoImportFile')?.files?.[0];if(!file){alert('Selecciona un archivo PDF.');return;}
 if(!/\.pdf$/i.test(file.name)||file.size>18_000_000){alert('Selecciona un PDF de hasta 18 MB.');return;}
 isBusy=true;$('#iberoImportRead').disabled=true;$('#iberoImportSave').disabled=true;
 try{
  const r=await parsePdf(file);parsed=r.report;digest=r.hash;activePdfName=file.name;
  setProgress(`Leídos ${parsed.products.length} artículos de ${parsed.pageCount} página(s). Consultando solicitudes del FabLab…`);
  await listLines((done,total)=>setProgress(`Buscando coincidencias: ${done} de ${total} solicitudes consultadas…`));
  proposals=suggestMatches(parsed.products,allLines);
  $('#iberoImportResults').innerHTML=`<div class="alert alert-light border mb-3"><strong>Requisición institucional ${esc(parsed.folio)}</strong> · Reporte del ${esc(parsed.reportDate||'día no identificado')} · ${parsed.products.length} artículos · ${allLines.length} líneas de ${allRequests.length} SC · ${esc(parsed.observations||'Sin observaciones')}
  ${parsed.notes.length?`<div class="text-warning">${parsed.notes.map(esc).join(' · ')}</div>`:''}</div>
  <div class="d-flex gap-2 align-items-center flex-wrap mb-3"><button class="btn btn-outline-primary btn-sm" id="iberoImportSelectClear" type="button">Seleccionar todos</button><button class="btn btn-outline-secondary btn-sm" id="iberoImportOnlyLinked" type="button">Sólo artículos vinculados</button><button class="btn btn-outline-secondary btn-sm" id="iberoImportClear" type="button">Deseleccionar todo</button><span class="small text-muted">Los artículos y los precios disponibles vienen seleccionados. Revisa la correspondencia SC/SKU antes de aplicar; ninguna escritura es automática.</span></div>
  <div class="imp-products">${parsed.products.map(productRow).join('')}</div>`;
  document.querySelectorAll('#iberoImportResults .imp-row').forEach(syncReceiptVisibility);
  setProgress(`Análisis completo: ${proposals.filter(p=>p.suggested).length} coincidencias claras; ${proposals.filter(p=>!p.suggested).length} artículos requieren revisión manual.`);
  $('#iberoImportSave').disabled=true;if(!admin())setProgress('Supervisor: puedes analizar, pero sólo el administrador puede aplicar cambios.');
  updateFooter();
 }catch(e){console.error(e);setProgress(`No se pudo analizar: ${e.message}`);alert(`Error al analizar el reporte: ${e.message}`);}
 finally{isBusy=false;$('#iberoImportRead').disabled=false;}
}
function selectedRows(){return [...document.querySelectorAll('#iberoImportResults .imp-row')].filter(r=>r.querySelector('.imp-apply')?.checked);}
function updateFooter(){renderValidation();}
function draftChanges(){
 const changes=[],keys=new Set();
 for(const tr of selectedRows()){
  const errors=checkRow(tr);if(errors.length)throw new Error(`No se puede aplicar: ${errors.join(' ')}`);
  const i=Number(tr.dataset.index),product=parsed.products[i],key=tr.querySelector('.imp-target').value;
  if(!key)throw new Error(`Selecciona el SKU/SC correspondiente a «${product.description}».`);
  if(keys.has(key))throw new Error(`Una línea del FabLab fue seleccionada para más de un producto externo (${key}).`);keys.add(key);
  const line=allLines.find(l=>lineKey(l)===key);if(!line)throw new Error('La línea seleccionada ya no está disponible. Actualiza el listado.');
  const proposedStage=tr.querySelector('.imp-stage-select').value;
  const changePrice=tr.querySelector('.imp-price').checked;
  const unitPrice=Number(tr.querySelector('.imp-price-value').value);
  if(changePrice&&(!Number.isFinite(unitPrice)||unitPrice<0))throw new Error(`Precio inválido: ${product.description}`);
  const saveDate=tr.querySelector('.imp-date').checked,expectedDate=tr.querySelector('.imp-date-value').value;
  if(saveDate && (!expectedDate || !/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)))throw new Error(`Fecha inválida: ${product.description}`);
  const receive=proposedStage==='received'&&tr.querySelector('.imp-receive').checked,receiveQty=Number(tr.querySelector('.imp-receive-qty').value);
  // El PDF puede expresar cajas, paquetes o juegos: una caja NO equivale
  // automáticamente a una pieza del inventario.
  const unit=String(product.purchaseUnit||'').toUpperCase();
  if((receive||changePrice)&&unit&&unit!=='PZA'&&unit!=='PZAS'&&!tr.querySelector('.imp-verify-units')?.checked)throw new Error(`Verifica explícitamente las unidades de ${product.description}.`);
  const storedDate=String(line.externalReportDate||'');
  if(parsed.reportDate&&storedDate&&parsed.reportDate<storedDate){
   alert(`Se omitirá ${line.sku}: el PDF corresponde al ${parsed.reportDate}, pero el registro ya contiene un reporte más reciente (${storedDate}).`);
   continue;
  }
  const oldRank=institutionalRank(line.externalReportedStatus),newRank=institutionalRank(product.externalStatus);
  if(oldRank>=0&&newRank>=0&&newRank<oldRank)throw new Error(`${line.sku}: no se permite retroceder de «${line.externalReportedStatus}» a «${product.externalStatus}».`);
  const externallyAvailable=Math.max(0,n(product.quantity||line.quantityRequested)-n(line.quantityReceived));
  if(receive && (!Number.isInteger(receiveQty)||receiveQty<1||receiveQty>pending(line)||receiveQty>externallyAvailable))throw new Error(`Indica una recepción válida para ${product.description}: máximo ${Math.min(pending(line),externallyAvailable)} según cantidad del PDF y recepciones ya registradas.`);
  if(receive && proposedStage!=='received')throw new Error(`La recepción física de ${product.description} sólo se permite con el estado «Entregado al usuario».`);
  if(((line.requisitionNumber&&String(line.requisitionNumber)!==String(product.folio))||(line.externalProcurementItemCode&&String(line.externalProcurementItemCode)!==String(product.externalCode)))&&!tr.querySelector('.imp-confirm-reassign')?.checked)throw new Error(`${line.sku}: confirma expresamente el cambio del vínculo institucional.`);
  changes.push({product,line,proposedStage,changePrice,unitPrice,saveDate,expectedDate,receive,receiveQty,confirmUnits:Boolean(tr.querySelector('.imp-verify-units')?.checked),confirmReassign:Boolean(tr.querySelector('.imp-confirm-reassign')?.checked)});
 }
 return changes;
}
function mergeRef(collectionRefs,requestId,itemId,key,qty,folio){
 const existing=refs(collectionRefs).filter(r=>!(String(r.requestId)===requestId&&String(r.lineId||r.itemId)===itemId));
 if(qty>0)existing.push({requestId,lineId:itemId,folio,requisitionQty:qty,requisitionNumber:key});
 return existing;
}
async function applyChange(c){
 const {product:p,line:choice,proposedStage:stage,changePrice,unitPrice,saveDate,expectedDate,receive,receiveQty}=c;
 const changeStamp=new Date().toISOString(),receiptId=`${digest.slice(0,24)}:${p.externalCode}`;
 const lineDoc=docLine(choice),requestDoc=doc(db,'purchaseRequests',choice.requestId),itemDoc=doc(db,'items',String(choice.itemId||choice.id));
 const result=await runTransaction(db,async tx=>{
  const [ls,rs,is]=await Promise.all([tx.get(lineDoc),tx.get(requestDoc),tx.get(itemDoc)]);
  if(!ls.exists()||!rs.exists()||!is.exists())throw new Error(`${choice.sku}: línea, SC o inventario no encontrados.`);
  if(rs.data().status==='draft')throw new Error(`${choice.sku}: la solicitud está en borrador.`);
  const l=ls.data(),req=rs.data(),item=is.data();const q=pending(l);
  const oldRank=institutionalRank(l.externalReportedStatus),newRank=institutionalRank(p.externalStatus);
  if(oldRank>=0&&newRank>=0&&newRank<oldRank)throw new Error(`${choice.sku}: el estado institucional en Firestore está más avanzado. No se admite un retroceso.`);
  if(q>0 && externalStage(p.externalStatus)==='received' && stage!=='received')throw new Error(`${choice.sku}: falta confirmar la recepción del material entregado antes de actualizar.`);
  if(n(l.quantityReceived)>0&&q===0&&externalStage(p.externalStatus)!=='received')throw new Error(`${choice.sku}: recibido previamente; el PDF está en etapa anterior y no se actualizará.`);
  if(n(l.quantityReceived)>0&&q===0&&stage!=='none'&&stage!=='received')throw new Error(`${choice.sku}: la recepción ya fue contabilizada. No puede volver a una etapa anterior.`);
  if(q===0&&n(l.quantityReceived)===0&&stage!=='none')throw new Error(`${choice.sku}: el artículo está cancelado.`);
  if(((l.requisitionNumber&&String(l.requisitionNumber)!==String(p.folio))||(l.externalProcurementItemCode&&String(l.externalProcurementItemCode)!==String(p.externalCode)))&&!c.confirmReassign)throw new Error(`${choice.sku}: se requiere confirmar el cambio de vínculo institucional.`);
  if((receive||changePrice)&&String(p.purchaseUnit||'').toUpperCase()&&!['PZA','PZAS'].includes(String(p.purchaseUnit).toUpperCase())&&!c.confirmUnits)throw new Error(`${choice.sku}: falta verificar la unidad de compra.`);
  if(receive&&q<=0)throw new Error(`${choice.sku}: la recepción ya está contabilizada, no hay unidades pendientes.`);
  if(receive&&(receiveQty>q||receiveQty>Math.max(0,n(p.quantity||l.quantityRequested)-n(l.quantityReceived))))throw new Error(`${choice.sku}: la recepción propuesta supera el pendiente o la cantidad del documento descontando lo ya recibido.`);
  // Una segunda consulta dentro de la transacción evita que la fecha haya
  // cambiado entre la revisión y la aprobación de las propuestas.
  if(parsed.reportDate && l.externalReportDate && parsed.reportDate<String(l.externalReportDate))
   throw new Error(`${choice.sku}: existe un reporte institucional posterior (${l.externalReportDate}).`);
  const imported=refs(l.externalProcurementHistory);
  if(imported.length>120)throw new Error(`${choice.sku}: historial institucional lleno; requiere archivado administrativo.`);
  const oldReceipt=refs(l.externalImportReceiptFingerprints);
  const receiptEvidence=`${p.folio}:${p.externalCode}:${p.externalStatus}:${p.quantity}:${p.expectedDate}`;
  const priorEvidence=refs(l.externalImportReceiptEvidence);
  if(receive && (oldReceipt.includes(receiptId)||priorEvidence.includes(receiptEvidence)))
   throw new Error(`${choice.sku}: ya existe una recepción importada con los mismos datos institucionales, aunque se haya vuelto a imprimir el PDF. Verifica el registro antes de recibir otra vez.`);
  const oldPrice=n(l.unitPrice),newPrice=changePrice?unitPrice:oldPrice;
  const itemId=String(choice.itemId||choice.id),linePatch={
    externalRequisitionNumber:p.folio,externalProcurementItemCode:p.externalCode,
    externalPurchaseOrderNumber:p.purchaseOrder||'',externalReportedStatus:p.externalStatus,
    externalQuotedUnitCost:p.quoted?.unitPrice??null,externalQuotedTotalGross:p.quoted?.totalWithTax??null,
    externalQuotedUnitCostGross:moneyGross(p),externalReportFile:activePdfName,
    externalReportDate:parsed.reportDate||l.externalReportDate||'', 
    externalReportLastImportedAt:serverTimestamp(),
    externalProcurementHistory:[...imported,{file:activePdfName,fileDigest:digest,code:p.externalCode,folio:p.folio,status:p.externalStatus,at:changeStamp,uid:auth.currentUser.uid,priceChanged:changePrice,warehouseFlag:stage==='warehouse',receiptQuantity:receive?receiveQty:0,notes:'Importación aprobada artículo por artículo'}],
    updatedAt:serverTimestamp()
  };
  if(saveDate){linePatch.externalExpectedDeliveryDate=expectedDate||null;linePatch.externalExpectedDeliveryAtUpdated=serverTimestamp();}
  let willRequisition=stage!=='none';
  if(willRequisition){
   if(q>0)linePatch.requisitionStatus='requisitioned';
   linePatch.requisitionNumber=p.folio;
   if(l.requisitionNumber && String(l.requisitionNumber)!==p.folio){const history=refs(l.requisitionNumberHistory);if(history.length>=200)throw new Error(`${choice.sku}: historial de folios lleno.`);linePatch.requisitionNumberHistory=[...history,{previous:String(l.requisitionNumber),current:p.folio,at:changeStamp,by:auth.currentUser.uid,reason:'Reporte PDF institucional'}];}
   if(l.requisitionStatus!=='requisitioned'){
    linePatch.requisitionedAt=serverTimestamp();linePatch.requisitionedBy=auth.currentUser.uid;linePatch.requisitionedByName=profile?.nombre||auth.currentUser.email||'';
   }
  }
  if(changePrice){
   if(n(l.quantityReceived)>0 && l.actualCostTotal==null)linePatch.actualCostTotal=n(l.quantityReceived)*n(l.lastActualUnitCost??l.unitPrice);
   linePatch.unitPrice=newPrice;linePatch.requisitionUnitCost=newPrice;
   if(!Object.prototype.hasOwnProperty.call(l,'originalUnitPrice'))linePatch.originalUnitPrice=oldPrice;
   linePatch.priceChangedAt=serverTimestamp();linePatch.priceChangedBy=auth.currentUser.uid;
  }
  const itemPatch={updatedAt:serverTimestamp()};
  if(changePrice){itemPatch.precioUnitario=newPrice;itemPatch.moneda=l.currency||'MXN';itemPatch.financePriceSourceMillis=Date.now();}
  let receiptUnits=0;
  if(receive){
   receiptUnits=receiveQty;const currentReceived=n(l.quantityReceived);
   const actualUnitCost=changePrice?unitPrice:n(l.lastActualUnitCost??l.unitPrice);
   const oldSpent=Object.prototype.hasOwnProperty.call(l,'actualCostTotal')?n(l.actualCostTotal):currentReceived*n(l.lastActualUnitCost??l.unitPrice);
   const history=refs(l.receiptHistory);
   if(history.length>=200)throw new Error(`${choice.sku}: historial de recepciones lleno; requiere revisión administrativa.`);
   linePatch.quantityReceived=currentReceived+receiptUnits;
   linePatch.status=(q-receiptUnits)>0?'partial':'received';
   linePatch.actualCostTotal=oldSpent+receiptUnits*actualUnitCost;
   linePatch.lastActualUnitCost=actualUnitCost;
   linePatch.lastActualCostAt=serverTimestamp();linePatch.lastReceivedAt=serverTimestamp();
   linePatch.receiptHistory=[...history,{quantity:receiptUnits,unitCost:actualUnitCost,at:changeStamp,userId:auth.currentUser.uid,currency:l.currency||'MXN',source:'pdf-compras',externalRequisition:p.folio,externalItemCode:p.externalCode,sourceDigest:digest}];
   linePatch.externalImportReceiptFingerprints=[...oldReceipt,receiptId];
   linePatch.externalImportReceiptEvidence=[...priorEvidence,receiptEvidence];
   itemPatch.stockAlmacen=n(item.stockAlmacen)+receiptUnits;
   const pendingRefs=refs(item.purchasePendingRefs).map(r=>(String(r.requestId)===choice.requestId&&String(r.lineId||r.itemId)===itemId)?{...r,pendingQty:Math.max(0,n(r.pendingQty)-receiptUnits)}:r).filter(r=>n(r.pendingQty)>0);
   itemPatch.purchasePendingRefs=pendingRefs;
   itemPatch.purchasePendingQty=Math.max(0,n(item.purchasePendingQty)-receiptUnits);
   linePatch.warehousePickupPending=false;
  }else if(stage==='warehouse'&&q>0){
   linePatch.warehousePickupPending=true;
   if(!l.warehousePickupPending)linePatch.warehousePickupSetAt=serverTimestamp();
   linePatch.warehousePickupUpdatedAt=serverTimestamp();linePatch.warehousePickupUpdatedBy=auth.currentUser.uid;
  }
  if(willRequisition && (q>0||refs(item.purchaseRequisitionRefs).some(r=>r.requestId===choice.requestId))){
   const effectiveQty=Math.max(0,q-receiptUnits),nextRefs=mergeRef(item.purchaseRequisitionRefs,choice.requestId,itemId,p.folio,effectiveQty,req.folio||choice.requestId);
   itemPatch.purchaseRequisitionRefs=nextRefs;
   itemPatch.purchaseRequisitionQty=nextRefs.reduce((s,r)=>s+n(r.requisitionQty),0);
  }else if(receiptUnits>0 && l.requisitionStatus==='requisitioned'){
   const nextRefs=refs(item.purchaseRequisitionRefs).map(r=>(String(r.requestId)===choice.requestId&&String(r.lineId||r.itemId)===itemId)?{...r,requisitionQty:Math.max(0,n(r.requisitionQty)-receiptUnits)}:r).filter(r=>n(r.requisitionQty)>0);
   itemPatch.purchaseRequisitionRefs=nextRefs;itemPatch.purchaseRequisitionQty=nextRefs.reduce((s,r)=>s+n(r.requisitionQty),0);
  }
  tx.update(lineDoc,linePatch);tx.update(itemDoc,itemPatch);tx.update(requestDoc,{updatedAt:serverTimestamp()});
  return {receiptUnits,newPrice,folio:p.folio};
 });return result;
}
async function refreshRequestTotals(requestId){
 const snap=await getDocsFromServer(collection(db,'purchaseRequests',requestId,'items'));
 const lines=snap.docs.map(s=>s.data());const sums={},spent={},pendingTotals={};let received=0,cancelled=0,remain=0,qty=0;
 for(const l of lines){const c=l.currency||'MXN',q=pending(l);qty+=n(l.quantityRequested);received+=n(l.quantityReceived);cancelled+=n(l.quantityCancelled);remain+=q;
  sums[c]=(sums[c]||0)+n(l.quantityRequested)*n(l.unitPrice);
  spent[c]=(spent[c]||0)+(l.actualCostTotal!=null?n(l.actualCostTotal):n(l.quantityReceived)*n(l.lastActualUnitCost??l.unitPrice));
  pendingTotals[c]=(pendingTotals[c]||0)+q*n(l.unitPrice);
 }
 const currentTotals={};for(const c of new Set([...Object.keys(spent),...Object.keys(pendingTotals)]))currentTotals[c]=(spent[c]||0)+(pendingTotals[c]||0);
 await updateDoc(doc(db,'purchaseRequests',requestId),{itemCount:lines.length,totalQty:qty,totalsByCurrency:sums,
  spentTotalsByCurrency:spent,pendingTotalsByCurrency:pendingTotals,currentTotalsByCurrency:currentTotals,
  status:remain?(received||cancelled?'partial':'sent'):(received?'completed':'cancelled'),updatedAt:serverTimestamp()});
}
async function applySelected(){if(isBusy||!admin())return;
 updateFooter();if($('#iberoImportSave')?.disabled)return;
 let changes;try{changes=draftChanges();if(!changes.length){alert('Selecciona productos y verifica sus correspondencias.');return;}}catch(e){alert(e.message);return;}
 const receipts=changes.filter(c=>c.receive).length,prices=changes.filter(c=>c.changePrice).length;
 if(!confirm(`¿Aplicar ${changes.length} actualizaciones de la requisición ${parsed.folio}?\n\nCambios de precios: ${prices}. Recepciones físicas explícitamente confirmadas: ${receipts}.\n\nEl proceso guarda cada artículo en una transacción; si falla uno, no se revertirán los anteriores. ¿Continuar?`))return;
 isBusy=true;$('#iberoImportSave').disabled=true;$('#iberoImportRead').disabled=true;
 let done=0;const errors=[],touched=new Set();
 try{
  for(const c of changes){
   try{await applyChange(c);done++;touched.add(c.line.requestId);
    const tr=[...document.querySelectorAll('.imp-row')].find(r=>Number(r.dataset.index)===c.product.ordinal-1);
    if(tr){tr.querySelector('.imp-apply').checked=false;tr.classList.add('table-success');}
    Object.assign(c.line,{requisitionNumber:c.product.folio,externalProcurementItemCode:c.product.externalCode,externalReportedStatus:c.product.externalStatus,externalReportDate:parsed.reportDate,...(c.changePrice?{unitPrice:c.unitPrice}:{}),...(c.receive?{quantityReceived:n(c.line.quantityReceived)+c.receiveQty}:{}),...(c.saveDate?{externalExpectedDeliveryDate:c.expectedDate}:{})});
   }catch(e){errors.push(`${c.product.externalCode}: ${e.message}`);console.error(e);}
   setProgress(`Aplicando: ${done} guardados; ${errors.length} pendientes por error; ${done+errors.length} de ${changes.length} procesados.`);
  }
  for(const requestId of touched){try{await refreshRequestTotals(requestId);}catch(e){errors.push(`Recalcular SC ${requestId}: ${e.message}`);}}
  if(touched.size){document.querySelector('#refreshPurchaseRequests')?.click();
   document.dispatchEvent(new CustomEvent('purchase:finance-reconciled',{detail:{requestIds:[...touched]}}));}
  alert(`${done} artículos actualizados. ${errors.length?`Errores que requieren revisión:\n${errors.join('\n')}`:'Sin errores.'}\n\nLos valores del PDF no contabilizados como recepción siguen siendo compromiso pendiente.`);
 }finally{isBusy=false;$('#iberoImportRead').disabled=false;updateFooter();}
}
function drawBoard(){const host=$('#iberoBoardBody');if(!host)return;
 const term=($('#iberoBoardSearch')?.value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
 const now=new Date().toISOString().slice(0,10);
 let lines=allLines.filter(l=>l.externalExpectedDeliveryDate);
 lines=lines.filter(l=>`${l.requisitionNumber||l.externalRequisitionNumber||''} ${l.sku||''} ${l.nombre||''} ${l.requestFolio||''}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().includes(term));
 if(boardMode==='pending')lines=lines.filter(l=>pending(l)>0);
 if(boardMode==='overdue')lines=lines.filter(l=>pending(l)>0&&l.externalExpectedDeliveryDate<now);
 if(boardMode==='warehouse')lines=lines.filter(l=>pending(l)>0&&l.warehousePickupPending);
 if(boardMode==='received')lines=lines.filter(l=>pending(l)===0&&n(l.quantityReceived)>0);
 lines.sort((a,b)=>String(a.externalExpectedDeliveryDate).localeCompare(String(b.externalExpectedDeliveryDate))||String(a.requisitionNumber||a.externalRequisitionNumber).localeCompare(String(b.requisitionNumber||b.externalRequisitionNumber)));
 const late=lines.filter(l=>pending(l)>0&&l.externalExpectedDeliveryDate<now).length;
 host.innerHTML=`<p class="small text-muted">${lines.length} productos con fecha · ${late} con fecha vencida y pendiente de recepción · ${lines.filter(l=>pending(l)>0&&l.warehousePickupPending).length} por recoger en almacén.</p>
 ${lines.length?`<table class="table table-sm table-striped align-middle"><thead><tr><th>Fecha estimada</th><th>Requisición</th><th>SC</th><th>SKU</th><th>Artículo</th><th>Estado actual</th><th>Pendiente</th><th>Compromiso</th></tr></thead><tbody>${lines.map(l=>{
   const cls=pending(l)>0&&l.warehousePickupPending?'delivery-warehouse':pending(l)>0&&l.externalExpectedDeliveryDate<now?'delivery-overdue':pending(l)>0&&l.externalExpectedDeliveryDate<=new Date(Date.now()+7*86400000).toISOString().slice(0,10)?'delivery-soon':'';
   return `<tr class="${cls}"><td class="delivery-date">${esc(dateText(l.externalExpectedDeliveryDate))}</td><td>${esc(l.requisitionNumber||l.externalRequisitionNumber||'Sin número')}</td><td>${esc(l.requestFolio)}</td><td>${esc(l.sku)}</td><td>${esc(l.nombre)}</td><td><span class="badge text-bg-${stageTone(l)==='orange'?'warning':stageTone(l)}">${esc(currentStage(l))}</span><div class="small text-muted">${esc(l.externalReportedStatus||'')}</div></td><td>${pending(l)}</td><td>${esc(amount(pendingBudget(l),l.currency||'MXN'))}</td></tr>`}).join('')}</tbody></table>`:'<p class="alert alert-info">No hay fechas que coincidan con el filtro.</p>'}`;
}
async function showBoard(){const modal=boardModal();$('#iberoBoardBody').innerHTML='<p class="text-muted">Consultando fechas de entrega…</p>';openImportModal(modal);try{await listLines();drawBoard();}catch(e){$('#iberoBoardBody').textContent=`No se pudo cargar: ${e.message}`;}}
function printBoard(){const w=window.open('','_blank');if(!w){alert('Permite ventanas emergentes para imprimir.');return;}
 const table=$('#iberoBoardBody')?.innerHTML||'';w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Tablero de fechas de entrega · FabLab</title><style>body{font:12px Arial,sans-serif;margin:20px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccc;padding:6px;text-align:left}th{background:#eee}.badge{display:inline-block;border-radius:5px;padding:3px 6px;color:#fff;background:#0d6efd}.text-bg-success{background:#198754}.text-bg-warning{background:#d35400}.text-bg-secondary{background:#6c757d}h1{font-size:20px}@page{size:landscape;margin:10mm}@media print{button{display:none}}</style></head><body><h1>FabLab IBERO · Fechas previstas de entrega</h1><p>Generado el ${new Date().toLocaleString('es-MX')} · Los importes pendientes no son gasto ejercido.</p>${table}<script>window.onload=()=>window.print();<\/script></body></html>`);w.document.close();}
function openImportModal(m){
 const canvas=$('#iberoRequisitionsPanel');
 const show=()=>bootstrap.Modal.getOrCreateInstance(m).show();
 if(canvas?.classList.contains('show') && bootstrap.Offcanvas){canvas.addEventListener('hidden.bs.offcanvas',show,{once:true});bootstrap.Offcanvas.getOrCreateInstance(canvas).hide();}
 else show();
}
function bind(){makeStyles();ensureModal();boardModal();chooseModal();injectButtons();void loadUser().catch(e=>console.warn('Rol de Compras:',e.message));
 document.addEventListener('click',event=>{
  const t=event.target;
  if(t.closest?.('#iberoProcurementImportLauncher')){void loadUser().then(()=>{if(!admin()){alert('El supervisor puede consultar, pero sólo el administrador puede importar actualizaciones.');return;}openImportModal(ensureModal());}).catch(e=>alert(e.message));}
  if(t.closest?.('#iberoDeliveryBoardLauncher'))void showBoard();
  if(t.closest?.('.iberoMatchClose'))chooseModal().close();
  if(t.closest?.('#iberoImportRead'))void reviewFile();
  if(t.closest?.('#iberoImportSelectClear')){document.querySelectorAll('#iberoImportResults .imp-apply').forEach(e=>e.checked=true);updateFooter();}
  if(t.closest?.('#iberoImportOnlyLinked')){document.querySelectorAll('#iberoImportResults .imp-row').forEach(row=>{row.querySelector('.imp-apply').checked=Boolean(row.querySelector('.imp-target')?.value);});updateFooter();}
  if(t.closest?.('#iberoImportClear')){document.querySelectorAll('.imp-apply').forEach(e=>e.checked=false);updateFooter();}
  if(t.closest?.('#iberoImportSave'))void applySelected();
  const find=t.closest?.('.imp-find');if(find){const tr=find.closest('.imp-row');searchingRow=Number(tr.dataset.index);$('#iberoMatchDescription').textContent=sourceLabel(parsed.products[searchingRow]);$('#iberoMatchSearch').value=parsed.products[searchingRow].description.split(' ').slice(0,2).join(' ');renderCandidates();chooseModal().showModal();}
  const choice=t.closest?.('.iberoMatchChoice');if(choice){const tr=document.querySelector(`.imp-row[data-index="${searchingRow}"]`);let select=tr?.querySelector('.imp-target');const l=allLines.find(x=>lineKey(x)===choice.dataset.key);if(select&&l){const o=document.createElement('option');o.value=lineKey(l);o.textContent=labelLine(l);select.append(o);select.value=o.value;tr.querySelector('.imp-apply').checked=true;refreshMatchCard(tr);syncReceiptVisibility(tr);updateFooter();}chooseModal().close();}
  if(t.closest?.('#iberoBoardRefresh'))void showBoard();
  if(t.closest?.('#iberoBoardPrint'))printBoard();
 });
 document.addEventListener('input',e=>{if(e.target?.id==='iberoMatchSearch')renderCandidates();if(e.target?.id==='iberoBoardSearch')drawBoard();if(e.target?.matches?.('.imp-receive-qty,.imp-price-value,.imp-date-value'))updateFooter();});
 document.addEventListener('change',e=>{
  if(e.target?.matches?.('.imp-apply,.imp-target')){
   const tr=e.target.closest('.imp-row');if(e.target.matches('.imp-target')&&tr){
    refreshMatchCard(tr);syncReceiptVisibility(tr);
   }
   updateFooter();
  }
  if(e.target?.matches?.('.imp-stage-select,.imp-price,.imp-receive,.imp-target'))syncReceiptVisibility(e.target.closest('.imp-row'));
  if(e.target?.matches?.('.imp-stage-select,.imp-price,.imp-receive,.imp-target,.imp-receive-qty,.imp-price-value,.imp-date,.imp-date-value,.imp-verify-units,.imp-confirm-reassign'))updateFooter();
  if(e.target?.id==='iberoBoardFilter'){boardMode=e.target.value;drawBoard();}
 });
 const observer=new MutationObserver(()=>injectButtons());observer.observe(document.body,{childList:true,subtree:true});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
