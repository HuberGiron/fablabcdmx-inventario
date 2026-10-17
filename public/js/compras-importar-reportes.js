/* FabLab IBERO | Importación supervisada de reportes de Requisición de Material.
 * PDF se lee en el navegador; jamás se carga a servidores externos.
 * Las propuestas no escriben Firestore hasta que el administrador acepta los renglones.
 * El precio "Real" del PDF significa cotizado por Compras, NO gasto recibido.
 */
import {auth,db} from './firebase-app.js';
import {getUserProfile,waitForUser} from './common.js';
import {collection,doc,getDoc,getDocs,getDocsFromServer,runTransaction,updateDoc,serverTimestamp} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import {parseProcurementReport,suggestMatches,matchingScore,externalStage,institutionalRank} from './compras-pdf-parser.mjs?v=20261017d';
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
function moneyGross(p){return p.quoted?.totalWithTax!=null&&p.quoted?.quantity>0?
 Math.round(p.quoted.totalWithTax/p.quoted.quantity*100)/100:null;}
function labelLine(l){return `${l.requestFolio} · ${l.sku||''} · ${l.nombre||''} (${n(l.quantityRequested)} solicitadas)`;}
function currentLineHtml(l){return l?`<div class="imp-note mt-1"><strong>Actualmente:</strong> ${esc(currentStage(l))} · ${esc(amount(l.unitPrice,l.currency||'MXN'))} · fecha ${esc(l.externalExpectedDeliveryDate?dateText(l.externalExpectedDeliveryDate):'sin registrar')}</div>`:'<div class="imp-note">Vincula el artículo para ver los datos actuales.</div>';}
function sourceLabel(p){return `${p.externalCode} · ${p.description}`;}
function makeStyles(){if($('#iberoImportStyle'))return;const s=document.createElement('style');s.id='iberoImportStyle';s.textContent=`
  #iberoImportModal .modal-dialog{max-width:1520px}
  #iberoImportModal .imp-table{font-size:.85rem;min-width:1350px}
  #iberoImportModal .imp-table td{vertical-align:top}
  #iberoImportModal .imp-source{min-width:225px;max-width:330px}
  #iberoImportModal .imp-select{min-width:250px}
  #iberoImportModal .imp-meta{min-width:235px}
  #iberoImportModal .imp-money{min-width:175px}
  #iberoImportModal .imp-stage{min-width:175px}
  #iberoImportModal .imp-note{font-size:.76rem;color:#677483}
  #iberoImportModal .imp-ambiguous{background:#fff4ea}
  #iberoImportModal .imp-confidence{font-weight:700}
  #iberoImportModal .imp-conf-high{color:#198754}.imp-conf-medium{color:#b36b00}.imp-conf-low{color:#b02a37}
  #iberoImportModal .imp-status-area{max-height:170px;overflow:auto}
  #iberoImportModal .imp-check{transform:scale(1.15)}
  #iberoImportModal .imp-progress{font-size:.86rem}
  #iberoImportModal .imp-banner{border-left:4px solid #0d6efd;background:#f0f5fd;padding:.7rem 1rem}
  #iberoDeliveryBoardModal .modal-dialog{max-width:1250px}
  #iberoDeliveryBoardModal .delivery-overdue{background:#fff1f0}
  #iberoDeliveryBoardModal .delivery-soon{background:#fff9e8}
  #iberoDeliveryBoardModal .delivery-warehouse{background:#fff0e2}
  #iberoDeliveryBoardModal .delivery-date{font-weight:700;white-space:nowrap}
  #iberoDeliveryBoardModal .table{font-size:.85rem}
  @media(max-width:768px){#iberoImportModal .modal-dialog,#iberoDeliveryBoardModal .modal-dialog{margin:.3rem}}
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
 const suggestion=proposals[i],best=suggestion?.options?.[0],target=suggestion.suggested;
 const conf=best?.score||0,confClass=conf>=.83?'high':conf>=.62?'medium':'low';
 const options=suggestion.options.map(l=>`<option value="${esc(lineKey(l))}" ${target===lineKey(l)?'selected':''}>${esc(labelLine(l))} · ${Math.round(l.score*100)}%</option>`).join('');
 const s=externalStage(p.externalStatus);const gross=moneyGross(p),v=(gross??p.quoted?.unitPrice??best?.unitPrice??0);
 const obs=p.quantity==null?'Cantidad no legible':`PDF: ${p.quantity} ${esc(p.purchaseUnit||'unidad(es)')}`;
 return `<tr class="imp-row ${suggestion.ambiguous?'imp-ambiguous':''}" data-index="${i}">
 <td class="text-center"><input type="checkbox" class="form-check-input imp-apply imp-check" aria-label="Aplicar ${esc(p.description)}"></td>
 <td class="imp-source"><strong>${esc(p.description)}</strong><div class="small text-muted">Código externo: ${esc(p.externalCode)} · ${esc(obs)}</div><div class="small">OC: ${esc(p.purchaseOrder||'—')}</div><div class="small text-primary">${esc(p.externalStatus)}</div></td>
 <td class="imp-select"><select class="form-select form-select-sm imp-target"><option value="">${suggestion.ambiguous?'Selecciona coincidencia':'No vincular'}</option>${options}</select>
 <button class="btn btn-link btn-sm p-0 imp-find" type="button">Buscar otro SKU / SC</button>
 <div class="imp-confidence imp-conf-${confClass}">${best?`Mejor coincidencia: ${Math.round(conf*100)}%`:'Sin coincidencia'}</div>
 ${suggestion.ambiguous?'<div class="imp-note">Requiere confirmación manual.</div>':''}<div class="imp-current">${currentLineHtml(allLines.find(x=>lineKey(x)===target))}</div></td>
 <td class="imp-meta"><div>Requisición: <strong>${esc(p.folio)}</strong></div><div>Fecha estimada: <strong>${esc(dateText(p.expectedDate))}</strong></div>
 <label class="d-flex gap-2 align-items-center mt-2"><input type="checkbox" class="form-check-input imp-date" ${p.expectedDate?'checked':'disabled'}> Guardar fecha</label>
 <label class="small mt-1">Modificar fecha si es necesario</label><input class="form-control form-control-sm imp-date-value" type="date" value="${esc(p.expectedDate)}"></td>
 <td class="imp-money"><div class="small">Sin IVA (${esc(p.quoted?.currency||'MXN')}): ${p.quoted?.unitPrice!=null?esc(amount(p.quoted.unitPrice,p.quoted.currency||'MXN')):'—'}</div><div class="small">Con IVA / unidad: <strong>${gross!=null?esc(amount(gross)):'—'}</strong></div>
 <label class="d-flex gap-2 mt-1"><input class="form-check-input imp-price" type="checkbox" ${p.quoted?.unitPrice!=null?'':'disabled'}> Actualizar precio</label>
 <label class="small">Precio unitario a registrar (MXN, IVA incluido)</label><input class="form-control form-control-sm imp-price-value" type="number" step="0.01" min="0" value="${Number(v).toFixed(2)}"></td>
 <td class="imp-stage"><label class="small">Estado propuesto</label><select class="form-select form-select-sm imp-stage-select">
 <option value="requisition" ${s==='requisition'?'selected':''}>En requisición</option>
 <option value="warehouse" ${s==='warehouse'?'selected':''}>En almacén</option>
 <option value="received" ${s==='received'?'selected':''}>Entregado al usuario</option>
 <option value="partial" ${s==='partial'?'selected':''}>Entrega parcial</option>
 <option value="none" ${s==='unknown'?'selected':''}>No cambiar estado</option></select>
 <label class="d-flex gap-2 mt-2"><input type="checkbox" class="form-check-input imp-receive"> <strong>Confirmo recepción física</strong></label>
 <label class="small">Piezas a ingresar al FabLab</label><input type="number" class="form-control form-control-sm imp-receive-qty" min="0" step="1" value="0">
 <div class="imp-note">Sin confirmación no se aumenta inventario ni gasto ejercido. La etapa institucional quedará como última actualización.</div></td>
 </tr>`;
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
  <div class="d-flex gap-2 align-items-center flex-wrap mb-2"><button class="btn btn-outline-primary btn-sm" id="iberoImportSelectClear" type="button">Seleccionar coincidencias claras</button><button class="btn btn-outline-secondary btn-sm" id="iberoImportClear" type="button">Deseleccionar todo</button><span class="small text-muted">Ningún cambio se realiza hasta pulsar «Aplicar».</span></div>
  <div class="table-responsive"><table class="table table-sm table-bordered imp-table"><thead><tr><th>Aplicar</th><th>Artículo del PDF</th><th>Coincidencia FabLab</th><th>Datos externos</th><th>Cotización / precio</th><th>Estado / recepción</th></tr></thead><tbody>${parsed.products.map(productRow).join('')}</tbody></table></div>`;
  setProgress(`Análisis completo: ${proposals.filter(p=>p.suggested).length} coincidencias claras; ${proposals.filter(p=>!p.suggested).length} artículos requieren revisión manual.`);
  $('#iberoImportSave').disabled=!admin();if(!admin())setProgress('Supervisor: puedes analizar, pero sólo el administrador puede aplicar cambios.');
  updateFooter();
 }catch(e){console.error(e);setProgress(`No se pudo analizar: ${e.message}`);alert(`Error al analizar el reporte: ${e.message}`);}
 finally{isBusy=false;$('#iberoImportRead').disabled=false;}
}
function selectedRows(){return [...document.querySelectorAll('#iberoImportResults .imp-row')].filter(r=>r.querySelector('.imp-apply')?.checked);}
function updateFooter(){const selected=selectedRows().length;const el=$('#iberoImportFooter');if(el)el.textContent=`${selected} de ${parsed?.products?.length||0} artículos seleccionados para revisión y actualización`;
 if($('#iberoImportSave'))$('#iberoImportSave').disabled=!admin()||isBusy||!selected;}
function draftChanges(){
 const changes=[],keys=new Set();
 for(const tr of selectedRows()){
  const i=Number(tr.dataset.index),product=parsed.products[i],key=tr.querySelector('.imp-target').value;
  if(!key)throw new Error(`Selecciona el SKU/SC correspondiente a «${product.description}».`);
  if(keys.has(key))throw new Error(`Una línea del FabLab fue seleccionada para más de un producto externo (${key}).`);keys.add(key);
  const line=allLines.find(l=>lineKey(l)===key);if(!line)throw new Error('La línea seleccionada ya no está disponible. Actualiza el listado.');
  const proposedStage=tr.querySelector('.imp-stage-select').value;
  const changePrice=tr.querySelector('.imp-price').checked;
  const unitPrice=Number(tr.querySelector('.imp-price-value').value);
  if(changePrice&&(!Number.isFinite(unitPrice)||unitPrice<0))throw new Error(`Precio inválido: ${product.description}`);
  const saveDate=tr.querySelector('.imp-date').checked,expectedDate=tr.querySelector('.imp-date-value').value;
  if(saveDate && expectedDate && !/^\d{4}-\d{2}-\d{2}$/.test(expectedDate))throw new Error(`Fecha inválida: ${product.description}`);
  const receive=tr.querySelector('.imp-receive').checked,receiveQty=Number(tr.querySelector('.imp-receive-qty').value);
  // El PDF puede expresar cajas, paquetes o juegos: una caja NO equivale
  // automáticamente a una pieza del inventario.
  const unit=String(product.purchaseUnit||'').toUpperCase();
  if((receive||changePrice)&&unit&&unit!=='PZA'&&unit!=='PZAS'){
   if(!confirm(`ATENCIÓN: «${product.description}» está cotizado por ${unit}, pero el inventario podría medir piezas. ¿Confirmas que revisaste la presentación y que el precio/cantidad corresponden a la unidad del FabLab?`))continue;
  }
  const storedDate=String(line.externalReportDate||'');
  if(parsed.reportDate&&storedDate&&parsed.reportDate<storedDate){
   alert(`Se omitirá ${line.sku}: el PDF corresponde al ${parsed.reportDate}, pero el registro ya contiene un reporte más reciente (${storedDate}).`);
   continue;
  }
  const oldRank=institutionalRank(line.externalReportedStatus),newRank=institutionalRank(product.externalStatus);
  if(oldRank>=0&&newRank>=0&&newRank<oldRank && (!parsed.reportDate||!storedDate||parsed.reportDate<=storedDate)){
   if(!confirm(`ATENCIÓN: ${line.sku} retrocedería de «${line.externalReportedStatus}» a «${product.externalStatus}». ¿Revisaste que el cambio reportado sea correcto?`))continue;
  }
  const externallyAvailable=Math.max(0,n(product.quantity||line.quantityRequested)-n(line.quantityReceived));
  if(receive && (!Number.isInteger(receiveQty)||receiveQty<1||receiveQty>pending(line)||receiveQty>externallyAvailable))throw new Error(`Indica una recepción válida para ${product.description}: máximo ${Math.min(pending(line),externallyAvailable)} según cantidad del PDF y recepciones ya registradas.`);
  if(receive && (proposedStage==='none'||proposedStage==='requisition'))throw new Error(`Para recibir ${product.description}, selecciona primero «Entregado al usuario» o «Entrega parcial».`);
  if(line.requisitionNumber && line.requisitionNumber!==product.folio && proposedStage!=='none'){
   if(!confirm(`ATENCIÓN: ${line.sku} ya pertenece a la requisición ${line.requisitionNumber}, pero el PDF corresponde a ${product.folio}. ¿Reasignar el artículo conservando historial?`))continue;
  }
  if(line.externalProcurementItemCode && line.externalProcurementItemCode!==product.externalCode){
   if(!confirm(`ATENCIÓN: ${line.sku} estaba vinculado al código institucional ${line.externalProcurementItemCode} y el PDF propone ${product.externalCode}. ¿Corregir ese vínculo?`))continue;
  }
  changes.push({product,line,proposedStage,changePrice,unitPrice,saveDate,expectedDate,receive,receiveQty});
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
    externalReportLastImportedAt:serverTimestamp(),
    externalProcurementHistory:[...imported,{file:activePdfName,fileDigest:digest,code:p.externalCode,folio:p.folio,status:p.externalStatus,at:changeStamp,uid:auth.currentUser.uid,priceChanged:changePrice,warehouseFlag:stage==='warehouse',receiptQuantity:receive?receiveQty:0,notes:'Importación aprobada artículo por artículo'}],
    updatedAt:serverTimestamp()
  };
  if(saveDate){linePatch.externalExpectedDeliveryDate=expectedDate||null;linePatch.externalExpectedDeliveryAtUpdated=serverTimestamp();}
  let willRequisition=stage!=='none';
  if(willRequisition){
   linePatch.requisitionStatus='requisitioned';linePatch.requisitionNumber=p.folio;
   if(l.requisitionNumber && String(l.requisitionNumber)!==p.folio){const history=refs(l.requisitionNumberHistory);if(history.length>=200)throw new Error(`${choice.sku}: historial de folios lleno.`);linePatch.requisitionNumberHistory=[...history,{previous:String(l.requisitionNumber),current:p.folio,at:changeStamp,by:auth.currentUser.uid,reason:'Reporte PDF institucional'}];}
   if(l.requisitionStatus!=='requisitioned'){
    linePatch.requisitionedAt=serverTimestamp();linePatch.requisitionedBy=auth.currentUser.uid;linePatch.requisitionedByName=profile?.nombre||auth.currentUser.email||'';
   }
  }
  if(changePrice){
   linePatch.unitPrice=newPrice;linePatch.requisitionUnitCost=newPrice;
   if(!Object.prototype.hasOwnProperty.call(l,'originalUnitPrice'))linePatch.originalUnitPrice=oldPrice;
   linePatch.priceChangedAt=serverTimestamp();linePatch.priceChangedBy=auth.currentUser.uid;
  }
  const itemPatch={updatedAt:serverTimestamp()};
  if(changePrice){itemPatch.precioUnitario=newPrice;itemPatch.moneda=l.currency||'MXN';itemPatch.financePriceSourceMillis=Date.now();}
  let receiptUnits=0;
  if(receive){
   receiptUnits=receiveQty;const currentReceived=n(l.quantityReceived);
   const actualUnitCost=p.quoted?.unitPrice!=null && Number.isFinite(unitPrice)&&unitPrice>=0?unitPrice:n(l.lastActualUnitCost??l.unitPrice);
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
  if(t.closest?.('#iberoProcurementImportLauncher, #iberoProcurementImportLauncherTop')){void loadUser().then(()=>{if(!admin()){alert('El supervisor puede consultar, pero sólo el administrador puede importar actualizaciones.');return;}openImportModal(ensureModal());}).catch(e=>alert(e.message));}
  if(t.closest?.('#iberoDeliveryBoardLauncher, #iberoDeliveryBoardLauncherTop'))void showBoard();
  if(t.closest?.('.iberoMatchClose'))chooseModal().close();
  if(t.closest?.('#iberoImportRead'))void reviewFile();
  if(t.closest?.('#iberoImportSelectClear')){document.querySelectorAll('.imp-row').forEach(row=>{const key=row.querySelector('.imp-target')?.value;row.querySelector('.imp-apply').checked=Boolean(key);});updateFooter();}
  if(t.closest?.('#iberoImportClear')){document.querySelectorAll('.imp-apply').forEach(e=>e.checked=false);updateFooter();}
  if(t.closest?.('#iberoImportSave'))void applySelected();
  const find=t.closest?.('.imp-find');if(find){const tr=find.closest('.imp-row');searchingRow=Number(tr.dataset.index);$('#iberoMatchDescription').textContent=sourceLabel(parsed.products[searchingRow]);$('#iberoMatchSearch').value=parsed.products[searchingRow].description.split(' ').slice(0,2).join(' ');renderCandidates();chooseModal().showModal();}
  const choice=t.closest?.('.iberoMatchChoice');if(choice){const tr=document.querySelector(`.imp-row[data-index="${searchingRow}"]`);let select=tr?.querySelector('.imp-target');const l=allLines.find(x=>lineKey(x)===choice.dataset.key);if(select&&l){const o=document.createElement('option');o.value=lineKey(l);o.textContent=labelLine(l);select.append(o);select.value=o.value;tr.classList.remove('imp-ambiguous');tr.querySelector('.imp-apply').checked=true;tr.querySelector('.imp-current').innerHTML=currentLineHtml(l);updateFooter();}chooseModal().close();}
  if(t.closest?.('#iberoBoardRefresh'))void showBoard();
  if(t.closest?.('#iberoBoardPrint'))printBoard();
 });
 document.addEventListener('input',e=>{if(e.target?.id==='iberoMatchSearch')renderCandidates();if(e.target?.id==='iberoBoardSearch')drawBoard();});
 document.addEventListener('change',e=>{if(e.target?.matches?.('.imp-apply,.imp-target')){const tr=e.target.closest('.imp-row');if(e.target.matches('.imp-target')&&tr){const target=allLines.find(l=>lineKey(l)===e.target.value);tr.querySelector('.imp-current').innerHTML=currentLineHtml(target);}updateFooter();}if(e.target?.id==='iberoBoardFilter'){boardMode=e.target.value;drawBoard();}});
 const observer=new MutationObserver(()=>injectButtons());observer.observe(document.body,{childList:true,subtree:true});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
