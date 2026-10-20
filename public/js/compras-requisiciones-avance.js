/** FabLab IBERO · Reporte de estados y avance por requisición.
 * Consulta exclusiva a Firestore. No modifica SC, folios, precios ni inventario.
 */
import {auth,db} from './firebase-app.js';
import {waitForUser,getUserProfile} from './common.js';
import {collection,getDocsFromServer} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import {STATUS_META,statusKey} from './compras-seguimiento-model.js?v=20261017i';
import {collectRequisitions,summarizeRequisition,groupFolio} from './compras-requisiciones-avance-model.js?v=20261020c';

const $ = selector => document.querySelector(selector);
const escapeHtml = v => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normalized = v => String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es-MX').trim();
const stampDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value||'')) ? String(value).split('-').reverse().join('/'):'—';
const STAGES=STATUS_META.filter(x=>x.key!=='cancelado');
let role='',groups=[],selected=new Set(),loaded=false,loading=false,failedRequests=0;

function style(){if($('#iberoReqProgressCss'))return;
 const css=document.createElement('style');css.id='iberoReqProgressCss';css.textContent=`
 #iberoRequisitionsPanel .req-utilities{margin:0 0 1.15rem;padding:1rem;border:1px solid #d9dee6;border-radius:12px;background:#f7f9fc}
 #iberoRequisitionsPanel .req-utilities-actions{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap}
 #iberoRequisitionsPanel .req-utilities-actions button{font-size:.86rem}
 #iberoReqProgressModal .modal-dialog{width:min(97vw,1460px);max-width:1460px}
 #iberoReqProgressModal .req-choose{max-height:170px;overflow:auto;border:1px solid #d8dee8;border-radius:8px;padding:.6rem}
 #iberoReqProgressModal .req-choose label{display:inline-flex;align-items:center;gap:.4rem;margin:.12rem .55rem .12rem 0;padding:.25rem .45rem;border-radius:6px;cursor:pointer}
 #iberoReqProgressModal .req-choose label:hover{background:#f0f3fa}
 #iberoReqProgressModal .req-prog-card{border:1px solid #d8dee8;border-radius:12px;padding:1rem;margin:0 0 .95rem;break-inside:avoid;background:#fff}
 #iberoReqProgressModal .req-prog-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
 #iberoReqProgressModal .req-prog-kpis{display:flex;gap:.5rem;flex-wrap:wrap;margin:.65rem 0}
 #iberoReqProgressModal .req-prog-kpi{border:1px solid #dfe5eb;border-radius:8px;padding:.65rem .9rem;background:#f8fafc;min-width:135px;flex:1}
 #iberoReqProgressModal .req-prog-kpi strong{display:block;font-size:1.3rem;line-height:1.3}
 #iberoReqProgressModal .req-prog-bar{display:flex;height:18px;overflow:hidden;border-radius:8px;background:#eef1f5}
 #iberoReqProgressModal .req-prog-bar .segment{height:100%;min-width:0}
 #iberoReqProgressModal .req-prog-table{width:100%;border-collapse:collapse;font-size:.84rem}
 #iberoReqProgressModal .req-prog-table th,#iberoReqProgressModal .req-prog-table td{padding:.4rem .55rem;border-bottom:1px solid #e5e9ef;text-align:left}
 #iberoReqProgressModal .req-prog-table th:last-child,#iberoReqProgressModal .req-prog-table td:last-child{text-align:right}
 #iberoReqProgressModal .req-prog-dot{display:inline-block;width:11px;height:11px;border-radius:2px;margin-right:7px;vertical-align:middle}
 #iberoReqProgressModal .req-prog-note{font-size:.82rem;color:#4b5563}
 #iberoReqProgressModal .req-prog-summary{border:1px solid #cbd5e1;border-left:5px solid #c8102e;border-radius:8px;padding:12px;margin-bottom:12px}
 @media(max-width:650px){#iberoReqProgressModal .req-prog-kpi{min-width:110px}}
 `;document.head.append(css);
}

function ensureMenu(){
 const panel=$('#iberoRequisitionsPanel');if(!panel)return;
 const body=panel.querySelector('.offcanvas-body');if(!body)return;
 let bar=body.querySelector('#iberoReqTools');
 if(!bar){bar=document.createElement('section');bar.id='iberoReqTools';bar.className='req-utilities';
  bar.innerHTML='<div class="fw-semibold mb-1">Herramientas de requisiciones</div><p class="small text-muted mb-2">Importación, fechas y reportes agrupados por folio institucional.</p><div class="req-utilities-actions" id="iberoReqToolsButtons"></div>';
  body.insertBefore(bar,body.firstChild);
 }
 const wrap=bar.querySelector('#iberoReqToolsButtons');
 for(const id of ['iberoProcurementImportLauncher','iberoDeliveryBoardLauncher','iberoFollowupOpen']){
  const btn=document.getElementById(id);
  if(btn&&btn.parentElement!==wrap)wrap.appendChild(btn);
 }
 if(!$('#iberoReqProgressLauncher')){
  const button=document.createElement('button');button.type='button';button.id='iberoReqProgressLauncher';
  button.className='btn btn-outline-primary btn-sm';button.textContent='Reporte de avance por requisición';wrap.appendChild(button);
 }
}

function ensureModal(){if($('#iberoReqProgressModal'))return;
 const modal=document.createElement('div');modal.id='iberoReqProgressModal';modal.className='modal fade';modal.tabIndex=-1;
 modal.innerHTML=`<div class="modal-dialog modal-xl modal-dialog-scrollable"><div class="modal-content">
 <div class="modal-header"><div><h5 class="modal-title">Reporte de estados y avance por requisición</h5><p class="small text-muted mb-0">Distribución de artículos por etapa institucional, avance del trámite y recepción real en FabLab</p></div><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button></div>
 <div class="modal-body">
 <div class="alert alert-light border small">El avance institucional es un <strong>indicador aproximado</strong> basado en hitos del proceso; no representa un porcentaje oficial de Compras. La recepción confirmada se calcula con las cantidades efectivamente registradas en el FabLab.</div>
 <div class="row g-3 mb-3"><div class="col-lg-4"><label class="form-label fw-semibold" for="iberoReqProgressFolioSearch">Filtrar números de requisición</label><input class="form-control form-control-sm mb-2" id="iberoReqProgressFolioSearch" type="search" placeholder="Buscar un folio"><div class="d-flex flex-wrap gap-2 mb-2"><button class="btn btn-outline-secondary btn-sm" id="iberoReqProgressAll" type="button">Todas</button><button class="btn btn-outline-secondary btn-sm" id="iberoReqProgressNone" type="button">Ninguna</button><span class="small text-muted align-self-center" id="iberoReqProgressSelected"></span></div><div id="iberoReqProgressFolios" class="req-choose" role="group" aria-label="Requisiciones seleccionadas"></div></div>
 <div class="col-lg-8"><div class="row g-2"><div class="col-lg-7"><label class="form-label fw-semibold" for="iberoReqProgressTextSearch">Buscar artículos, SC o alias</label><input id="iberoReqProgressTextSearch" class="form-control" type="search" placeholder="Artículo, SKU, SC, alias o folio"></div><div class="col-lg-5"><label for="iberoReqProgressStage" class="form-label fw-semibold">Requisiciones que contengan</label><select id="iberoReqProgressStage" class="form-select"><option value="all">Cualquier estado</option>${STATUS_META.map(s=>`<option value="${escapeHtml(s.key)}">${escapeHtml(s.label)}</option>`).join('')}</select></div></div><p class="req-prog-note mt-2">Los filtros seleccionan requisiciones completas; sus porcentajes siempre se calculan con todos los artículos del grupo.</p><div class="small text-muted" id="iberoReqProgressLoading" role="status"></div></div></div>
 <div id="iberoReqProgressResults"></div>
 </div><div class="modal-footer"><button id="iberoReqProgressRefresh" type="button" class="btn btn-outline-primary">Actualizar desde Firestore</button><button id="iberoReqProgressPrint" type="button" class="btn btn-outline-dark">Imprimir / Guardar PDF</button><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cerrar</button></div>
 </div></div>`;
 document.body.append(modal);
}

async function fetchData(){
 if(loading)return;loading=true;
 const refresh=$('#iberoReqProgressRefresh');if(refresh)refresh.disabled=true;
 $('#iberoReqProgressLoading').textContent='Consultando solicitudes y artículos en Firestore…';
 try{
  const root=await getDocsFromServer(collection(db,'purchaseRequests'));
  const requests=root.docs.filter(d=>d.data().status!=='draft').map(d=>({id:d.id,...d.data()}));
  let cursor=0,failed=0;const rows=[];
  await Promise.all(Array.from({length:Math.min(5,requests.length)},async()=>{
   while(cursor<requests.length){const req=requests[cursor++];
    try{const snap=await getDocsFromServer(collection(db,'purchaseRequests',req.id,'items'));
     for(const docSnap of snap.docs){const data=docSnap.data();
      if(data.requisitionStatus==='requisitioned'||data.requisitionNumber||data.externalRequisitionNumber){
       rows.push({id:docSnap.id,...data,requestId:req.id,requestFolio:req.folio||req.id,requestAlias:req.alias||''});
      }
     }
    }catch(error){failed++;console.warn('Avance requisiciones: SC inaccesible',req.id,error);}
   }
  }));
  const next=collectRequisitions(rows);const valid=new Set(next.map(g=>g.key));
  if(!loaded){selected=new Set(valid);loaded=true;}else selected=new Set([...selected].filter(key=>valid.has(key)));
  groups=next;failedRequests=failed;renderSelector();render();
  $('#iberoReqProgressLoading').textContent=`${rows.length} artículos en ${groups.length} grupos; ${requests.length-failed} SC consultadas.${failed?' Advertencia: '+failed+' SC no pudieron consultarse; reporte parcial.':''}`;
 }catch(error){console.error('Reporte de avance:',error);$('#iberoReqProgressLoading').textContent=`Error al consultar Firestore: ${error.message}`;}
 finally{loading=false;if(refresh)refresh.disabled=false;}
}
function renderSelector(){
 const host=$('#iberoReqProgressFolios');if(!host)return;
 const term=normalized($('#iberoReqProgressFolioSearch')?.value);
 const shown=groups.filter(g=>normalized(g.folio||`Sin número ${g.lines[0]?.requestFolio||''}`).includes(term));
 const y=host.scrollTop;
 host.innerHTML=shown.map(g=>`<label><input type="checkbox" class="form-check-input iberoReqProgressSelect" data-key="${escapeHtml(g.key)}" ${selected.has(g.key)?'checked':''}><span>${escapeHtml(g.folio||'Sin número')} <small class="text-muted">${g.lines.length} SKU${g.folio?'':' · '+escapeHtml(g.lines[0]?.requestFolio||'')}</small></span></label>`).join('')||'<p class="small text-muted mb-0">Sin coincidencias.</p>';
 host.scrollTop=y;$('#iberoReqProgressSelected').textContent=`${selected.size}/${groups.length} seleccionadas`;
}
function displayedGroups(){
 const term=normalized($('#iberoReqProgressTextSearch')?.value||'');
 const words=term.split(/\s+/).filter(Boolean);
 const stage=$('#iberoReqProgressStage')?.value||'all';
 return groups.filter(g=>selected.has(g.key)&&(!words.length||words.every(w=>normalized([
    g.folio,...g.lines.flatMap(l=>[l.nombre,l.sku,l.requestFolio,l.requestAlias,l.externalPurchaseOrderNumber])
  ].join(' ')).includes(w)))&&(stage==='all'||g.lines.some(l=>statusKey(l)===stage)));
}
const percent=n=>`${Math.round(n)}%`;
function progressBar(stats){
 const spans=STAGES.filter(m=>stats.counts[m.key]>0).map(m=>`<span class="segment" style="width:${stats.shares[m.key]}%;background:${m.color}" title="${escapeHtml(m.label)}: ${stats.counts[m.key]} (${percent(stats.shares[m.key])})"></span>`).join('');
 const canceled=STATUS_META.find(m=>m.key==='cancelado');
 const tail=stats.counts.cancelado?`<span class="segment" style="width:${stats.shares.cancelado}%;background:${canceled.color}" title="Cancelados: ${stats.counts.cancelado}"></span>`:'';
 return `<div class="req-prog-bar" role="img" aria-label="Distribución porcentual: ${escapeHtml(STATUS_META.filter(s=>stats.counts[s.key]).map(s=>`${s.label} ${percent(stats.shares[s.key])}`).join(', '))}">${spans}${tail}</div>`;
}
function card(group){
 const stats=summarizeRequisition(group.lines);
 const first=group.lines[0];
 const rows=STATUS_META.map(s=>`<tr><td><span class="req-prog-dot" style="background:${s.color}"></span>${escapeHtml(s.label)}</td><td>${stats.counts[s.key]}</td><td>${percent(stats.shares[s.key])}</td></tr>`).join('');
 const milestones=`<div class="req-prog-kpis"><div class="req-prog-kpi"><span class="small text-muted">Avance institucional estimado</span><strong>${stats.progressPct}%</strong></div><div class="req-prog-kpi"><span class="small text-muted">Unidades recibidas en FabLab</span><strong>${stats.receivedPct}%</strong><small>${stats.received} de ${stats.effectiveRequested} piezas no canceladas</small></div><div class="req-prog-kpi"><span class="small text-muted">Artículos</span><strong>${stats.count}</strong><small>${stats.scs} SC · ${stats.pending} piezas pendientes</small></div></div>`;
 return `<article class="req-prog-card"><div class="req-prog-head"><div><h3 class="h5 mb-1">Requisición ${escapeHtml(group.folio||'sin número asignado')}</h3><span class="small text-muted">${escapeHtml(!group.folio?first?.requestFolio||'':group.lines.map(l=>l.requestFolio).filter((v,i,a)=>a.indexOf(v)===i).join(' · '))}</span></div><div class="small text-muted">Último reporte: ${escapeHtml(stampDate(stats.lastReport))}<br>Próxima fecha prometida: ${escapeHtml(stampDate(stats.nextDelivery))}</div></div>${milestones}<div class="small fw-semibold mb-2">Distribución de ${stats.count} artículos por estado institucional</div>${progressBar(stats)}<details class="mt-2"><summary class="small fw-semibold" style="cursor:pointer">Ver desglose por etapa y artículos (${stats.count})</summary><div class="table-responsive mt-2"><table class="req-prog-table"><thead><tr><th>Estado</th><th>Artículos</th><th>Porcentaje</th></tr></thead><tbody>${rows}</tbody></table><table class="req-prog-table req-prog-lines mt-3"><thead><tr><th>SKU / SC</th><th>Artículo</th><th>Etapa de Compras</th><th>Fecha esperada</th></tr></thead><tbody>${group.lines.map(l=>`<tr><td>${escapeHtml(l.sku||'')}<small class="d-block text-muted">${escapeHtml(l.requestFolio||'')}</small></td><td>${escapeHtml(l.nombre||'')}</td><td>${escapeHtml(STATUS_META.find(s=>s.key===statusKey(l))?.label||'Sin reporte')}</td><td>${escapeHtml(stampDate(l.externalExpectedDeliveryDate))}</td></tr>`).join('')}</tbody></table></div></details></article>`;
}
function render(){const host=$('#iberoReqProgressResults');if(!host)return;const visible=displayedGroups();
 const total=visible.reduce((s,g)=>s+g.lines.length,0);
 host.innerHTML=`<div class="req-prog-summary"><strong>${visible.length} requisición${visible.length===1?'':'es'}</strong> · ${total} artículo${total===1?'':'s'} en los filtros actuales. <span class="small text-muted">Cada barra suma 100% de artículos de esa requisición.</span></div>${visible.length?visible.map(card).join(''):'<div class="alert alert-info">No hay requisiciones con los filtros seleccionados.</div>'}`;
}
function printReport(){
 const visible=displayedGroups();if(!visible.length){alert('Selecciona al menos una requisición con artículos para imprimir.');return;}
 const popup=window.open('','_blank');if(!popup){alert('Habilita ventanas emergentes para guardar el PDF.');return;}
 const styleText=$('#iberoReqProgressCss')?.textContent||'';
 const report=visible.map(card).join('').replaceAll('<details class="mt-2">','<details class="mt-2" open>');
 const styles=`${styleText.replaceAll('#iberoReqProgressModal ','#reportContent ')}
 body{font:10pt Arial,sans-serif;color:#1c2430;margin:8mm}h1{font-size:19pt;margin:0}header{border-bottom:3px solid #c8102e;padding-bottom:7mm;margin-bottom:6mm}
 #reportContent .req-prog-kpi strong{font-size:14pt}#reportContent .req-prog-card{border:1px solid #cbd5e1;page-break-inside:avoid}
 #reportContent .req-prog-bar{print-color-adjust:exact;-webkit-print-color-adjust:exact}
 #reportContent details{display:block}#reportContent details>summary{display:none}#reportContent details .req-prog-lines{display:none!important}
 @page{size:A4 landscape;margin:10mm}.toolbar{display:flex;justify-content:flex-end;margin-bottom:15px}
 @media print{.toolbar{display:none}#reportContent .req-prog-card{break-inside:avoid}}
 `;
 popup.document.open();popup.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Avance de requisiciones · FabLab</title><style>${styles}</style></head><body><div class="toolbar"><button onclick="window.print()">Imprimir / Guardar PDF</button><button onclick="window.close()">Cerrar</button></div><header><div style="color:#c8102e;font-weight:700">Universidad Iberoamericana Ciudad de México · FabLab</div><h1>Reporte de avance por requisición</h1><div style="font-size:9pt;color:#666">Generado: ${escapeHtml(new Date().toLocaleString('es-MX'))} · ${visible.length} requisiciones · indicadores no oficiales del proceso institucional</div></header><p style="font-size:9pt">Avance estimado: No Generada 0%, Generada 10%, Firma Electrónica 20%, Cotizado 35%, Por Surtir 60%, En Almacén 80%, Entrega parcial 90%, Entregado al Usuario 100%. Los registros cancelados no intervienen en el promedio. La recepción de FabLab se calcula por unidades físicas registradas.</p><main id="reportContent">${report}</main></body></html>`);popup.document.close();
}
function show(){ensureModal();const modal=$('#iberoReqProgressModal');const sidebar=$('#iberoRequisitionsPanel');const open=()=>{window.bootstrap.Modal.getOrCreateInstance(modal).show();void fetchData();};
 if(sidebar?.classList.contains('show')){sidebar.addEventListener('hidden.bs.offcanvas',open,{once:true});window.bootstrap.Offcanvas.getOrCreateInstance(sidebar).hide();}else open();
}
async function init(){
 const user=auth.currentUser||await waitForUser();if(!user)return;
 const profile=await getUserProfile(user.uid);role=String(profile?.appRole||profile?.role||'');if(!['admin','supervisor'].includes(role))return;
 style();ensureModal();ensureMenu();
 const observer=new MutationObserver(ensureMenu);observer.observe(document.body,{childList:true,subtree:true});
 document.addEventListener('click',e=>{const t=e.target;if(!(t instanceof Element))return;
  if(t.closest('#iberoReqProgressLauncher'))show();
  else if(t.closest('#iberoReqProgressRefresh'))void fetchData();
  else if(t.closest('#iberoReqProgressAll')){selected=new Set(groups.map(g=>g.key));renderSelector();render();}
  else if(t.closest('#iberoReqProgressNone')){selected.clear();renderSelector();render();}
  else if(t.closest('#iberoReqProgressPrint'))printReport();
 });
 document.addEventListener('change',e=>{
  if(e.target?.matches('.iberoReqProgressSelect')){const k=e.target.dataset.key;if(e.target.checked)selected.add(k);else selected.delete(k);renderSelector();render();}
  else if(e.target?.id==='iberoReqProgressStage')render();
 });
 document.addEventListener('input',e=>{if(e.target?.id==='iberoReqProgressFolioSearch')renderSelector();else if(e.target?.id==='iberoReqProgressTextSearch')render();});
}
init().catch(e=>console.error('Reporte avance Requisiciones: no se pudo iniciar',e));
