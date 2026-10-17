/** FabLab IBERO | Tablero informativo de etapas institucionales de requisiciones.
 * Funciona con los datos que YA fueron aceptados al importar PDFs.
 * Sólo lectura; no modifica inventario, permisos ni presupuesto.
 */
import {db,auth} from './firebase-app.js';
import {waitForUser,getUserProfile} from './common.js';
import {collection,getDocsFromServer} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import {STATUS_META,statusKey,statusInfo,summarize,selectLines} from './compras-seguimiento-model.js?v=20261017f';
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount=(n,c)=>new Intl.NumberFormat('es-MX',{style:'currency',currency:c||'MXN'}).format(Number(n)||0);
const date=s=>/^\d{4}-\d\d-\d\d$/.test(String(s||''))?String(s).split('-').reverse().join('/'):'—';
let records=[],selectedFolios=new Set(),role='',loading=false,ready=false;
const folioOf=l=>String(l.requisitionNumber||l.externalRequisitionNumber||'SIN-NUMERO');
function css(){if($('#iberoFollowupStyle'))return;const s=document.createElement('style');s.id='iberoFollowupStyle';s.textContent=`
 #iberoFollowupModal .modal-dialog{max-width:1580px;width:min(97vw,1580px)}
 #iberoFollowupModal .followup-selectbox{max-height:175px;overflow:auto;border:1px solid #dee2e6;border-radius:8px;padding:.55rem;background:#fff}
 #iberoFollowupModal .followup-selectbox label{cursor:pointer;padding:.22rem .38rem;border-radius:5px;display:flex;align-items:center;gap:.45rem}
 #iberoFollowupModal .followup-selectbox label:hover{background:#f4f6fa}
 #iberoFollowupModal .followup-kpi{border:1px solid #dee2e6;border-radius:10px;padding:.8rem;background:#fff;min-width:150px;flex:1}
 #iberoFollowupModal .followup-kpi strong{font-size:1.6rem;display:block;line-height:1.2}
 #iberoFollowupModal .followup-stage{padding:.62rem .75rem;border-radius:9px;border:1px solid #dde2e8;background:#fff;min-width:180px;flex:1;cursor:pointer;text-align:left}
 #iberoFollowupModal .followup-stage.active{outline:3px solid #182c50}
 #iberoFollowupModal .followup-stage .followup-count{font-size:1.32rem;font-weight:800;float:right}
 #iberoFollowupModal .followup-progress{display:flex;height:17px;overflow:hidden;border-radius:8px;background:#e9ecef}
 #iberoFollowupModal .followup-progress>span{height:100%;min-width:0}
 #iberoFollowupModal .followup-table{min-width:1100px;font-size:.84rem}
 #iberoFollowupModal .followup-table td{vertical-align:middle}
 #iberoFollowupModal .followup-tag{display:inline-flex;font-weight:700;color:#fff;padding:.23rem .43rem;border-radius:5px;font-size:.75rem}
 #iberoFollowupModal .followup-flow{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
 #iberoFollowupModal .followup-flow small{display:inline-block;padding:.3rem .5rem;border-radius:5px;background:#eff2f6;color:#3e4856;font-weight:700}
 #iberoFollowupModal .followup-warn{background:#fff8e9;border:1px solid #e7ce93;border-radius:7px;padding:.6rem .75rem}
 @media(max-width:760px){#iberoFollowupModal .followup-stage{min-width:130px}#iberoFollowupModal .followup-kpi{min-width:125px}}
 `;document.head.append(s);}
function modal(){let m=$('#iberoFollowupModal');if(m)return m;
 m=document.createElement('div');m.id='iberoFollowupModal';m.className='modal fade';m.tabIndex=-1;
 m.innerHTML=`<div class="modal-dialog modal-xl modal-dialog-scrollable"><div class="modal-content">
 <div class="modal-header"><div><h5 class="modal-title">Seguimiento institucional de requisiciones</h5><div class="small text-muted">No Generada → Firma Electrónica → Por Surtir → En Almacén → Entregado al Usuario</div></div><button class="btn-close" type="button" data-bs-dismiss="modal" aria-label="Cerrar"></button></div>
 <div class="modal-body">
 <div class="followup-warn small mb-3"><strong>Vista de seguimiento.</strong> Las etapas institucionales provienen de los PDF revisados y aprobados. No cambian los estados generales del FabLab. «Entregado al Usuario» no registra existencias ni gasto sin confirmar una recepción.</div>
 <div class="row g-3 align-items-start mb-3"><div class="col-lg-4"><label class="form-label fw-semibold" for="iberoFollowupFolioFilter">Requisiciones a comparar</label><input id="iberoFollowupFolioFilter" class="form-control form-control-sm mb-2" type="search" placeholder="Buscar número de requisición"><div class="d-flex flex-wrap gap-2 mb-2"><button class="btn btn-sm btn-outline-secondary" id="iberoFollowupAll" type="button">Todas</button><button class="btn btn-sm btn-outline-secondary" id="iberoFollowupNone" type="button">Ninguna</button><span class="small text-muted align-self-center" id="iberoFollowupSelected"></span></div><div class="followup-selectbox" id="iberoFollowupFolios" role="group" aria-label="Seleccionar requisiciones"></div></div>
 <div class="col-lg-8"><div class="row g-2"><div class="col-md-7"><label class="form-label fw-semibold" for="iberoFollowupSearch">Buscar artículos, SKU, SC o compra externa</label><input id="iberoFollowupSearch" type="search" class="form-control" placeholder="Buscar en requisiciones seleccionadas"></div><div class="col-md-5"><label class="form-label fw-semibold" for="iberoFollowupStage">Filtrar etapa</label><select id="iberoFollowupStage" class="form-select"><option value="all">Todas las etapas</option>${STATUS_META.map(x=>`<option value="${x.key}">${esc(x.label)}</option>`).join('')}</select></div></div><div id="iberoFollowupMetrics" class="mt-3"></div></div></div>
 <div id="iberoFollowupStatus" class="small text-muted mb-2" role="status"></div>
 <div id="iberoFollowupResults"></div>
 </div><div class="modal-footer"><button id="iberoFollowupRefresh" class="btn btn-outline-primary" type="button">Actualizar desde Firestore</button><button id="iberoFollowupPrint" class="btn btn-outline-dark" type="button">Imprimir análisis</button><button class="btn btn-secondary" data-bs-dismiss="modal" type="button">Cerrar</button></div>
 </div></div>`;
 document.body.append(m);return m;
}
function launcher(){const host=$('#iberoRequisitionsPanel .offcanvas-header');if(!host)return;
 if($('#iberoFollowupOpen'))return;const btn=document.createElement('button');btn.id='iberoFollowupOpen';btn.type='button';btn.className='btn btn-primary btn-sm';btn.textContent='Seguimiento de estados';host.insertBefore(btn,host.lastElementChild);
}
async function load(){if(loading)return;loading=true;$('#iberoFollowupRefresh').disabled=true;$('#iberoFollowupStatus').textContent='Consultando solicitudes y requisiciones…';
 try{
  const snap=await getDocsFromServer(collection(db,'purchaseRequests'));
  const reqs=snap.docs.filter(d=>d.data().status!=='draft').map(d=>({id:d.id,...d.data()}));
  const result=[];let cursor=0,failed=0;
  await Promise.all(Array.from({length:Math.min(5,reqs.length)},async()=>{
   while(cursor<reqs.length){const req=reqs[cursor++];try{const lines=await getDocsFromServer(collection(db,'purchaseRequests',req.id,'items'));
    for(const lineDoc of lines.docs){const l=lineDoc.data();if(l.requisitionStatus==='requisitioned'||l.externalRequisitionNumber||l.requisitionNumber){result.push({id:lineDoc.id,...l,requestId:req.id,requestFolio:req.folio||req.id,requestAlias:req.alias||''});}}
   }catch(e){failed++;console.warn('Seguimiento: SC no consultada',req.id,e);}
   }
  }));
  records=result.sort((a,b)=>folioOf(a).localeCompare(folioOf(b),'es',{numeric:true})||String(a.nombre||'').localeCompare(String(b.nombre||''),'es'));
  const available=new Set(records.map(folioOf));if(!ready){selectedFolios=new Set(available);ready=true;}else selectedFolios=new Set([...selectedFolios].filter(x=>available.has(x)));
  drawCheckboxes();render();$('#iberoFollowupStatus').textContent=`${records.length} líneas de requisición consultadas en ${reqs.length-failed} SC.${failed?` Atención: ${failed} SC no pudieron leerse; análisis parcial.`:''}`;
 }catch(e){console.error(e);$('#iberoFollowupStatus').textContent=`No se pudo cargar: ${e.message}`;}
 finally{loading=false;$('#iberoFollowupRefresh').disabled=false;}
}
function drawCheckboxes(){const container=$('#iberoFollowupFolios');if(!container)return;
 const current=$('#iberoFollowupFolioFilter')?.value?.trim().toLowerCase()||'';
 const folios=[...new Set(records.map(folioOf))].sort((a,b)=>a.localeCompare(b,'es',{numeric:true}));
 const scrollPosition=container.scrollTop;
 container.innerHTML=folios.filter(f=>f.toLowerCase().includes(current)).map(f=>{
  const count=records.filter(l=>folioOf(l)===f).length;
  return `<label><input type="checkbox" class="form-check-input iberoFollowupFolio" value="${esc(f)}" ${selectedFolios.has(f)?'checked':''}><span><strong>${esc(f==='SIN-NUMERO'?'Sin número':f)}</strong> <small class="text-muted">${count} SKU</small></span></label>`;
 }).join('')||'<p class="small text-muted mb-0">Sin requisiciones con ese número.</p>';
 container.scrollTop=scrollPosition;
 $('#iberoFollowupSelected').textContent=`${selectedFolios.size}/${folios.length} seleccionadas`;
}
function tag(l){const i=statusInfo(l);return `<span class="followup-tag" style="background:${i.color}">${esc(i.label)}</span>`;}
function progression(s){return `<div class="followup-flow mb-2">${STATUS_META.slice(0,6).map((m,i)=>`<small style="${m.key===s?'background:'+m.color+';color:white':''}">${i+1}. ${esc(m.label.replace(' al Usuario',''))}</small>`).join('<span class="text-muted">›</span>')}</div>`;}
function render(){const host=$('#iberoFollowupResults');if(!host)return;
 const selected=selectLines(records,selectedFolios,$('#iberoFollowupSearch')?.value||'',$('#iberoFollowupStage')?.value||'all');
 const summary=summarize(selected);
 const ALL=summarize(selectLines(records,selectedFolios,$('#iberoFollowupSearch')?.value||'','all'));
 const mk=(label,value)=>`<div class="followup-kpi"><span class="small text-muted">${label}</span><strong>${esc(value)}</strong></div>`;
 const finances=[...summary.currencies].map(([c,v])=>`<span class="small me-3"><strong>${esc(c)}</strong>: gasto recibido ${esc(amount(v.spent,c))} · compromiso ${esc(amount(v.committed,c))}</span>`).join('');
 $('#iberoFollowupMetrics').innerHTML=`<div class="d-flex flex-wrap gap-2">${mk('Artículos visibles',summary.total)}${mk('Requisiciones',summary.requisitions)}${mk('SC involucradas',summary.scs)}${mk('Piezas pendientes',summary.pending)}</div><div class="small text-muted mt-2">${finances||'Selecciona requisiciones para ver el análisis.'}</div>`;
 const bar=STATUS_META.map(s=>({s,count:ALL.counts[s.key]}));
 const steps=`<div class="d-flex flex-wrap gap-2 mb-2">${bar.map(({s,count})=>`<button class="followup-stage ${$('#iberoFollowupStage')?.value===s.key?'active':''}" data-stage="${s.key}" type="button"><span class="followup-count" style="color:${s.color}">${count}</span><div class="small fw-semibold">${esc(s.label)}</div><div class="small text-muted">${ALL.total?(count/ALL.total*100).toFixed(0):0}%</div></button>`).join('')}</div><div class="followup-progress mb-3" title="Distribución por artículo">${bar.filter(x=>x.count).map(({s,count})=>`<span style="width:${ALL.total?100*count/ALL.total:0}%;background:${s.color}" title="${esc(s.label)}: ${count}"></span>`).join('')}</div>`;
 const groups=new Map();for(const l of selected){const key=folioOf(l);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(l);}
 const ordered=[...groups].sort((a,b)=>a[0].localeCompare(b[0],'es',{numeric:true}));
 const dateVal=l=>String(l.externalExpectedDeliveryDate||'');
 host.innerHTML=steps+`<div class="small text-muted mb-2">${ordered.length} requisiciones visibles · Almacenado en la SC: etapa institucional, precio y fecha de su último reporte aprobado.</div>`+
 (ordered.length?ordered.map(([folio,rows])=>{
  const s=summarize(rows);const top=STATUS_META.filter(m=>s.counts[m.key]);
  const prices=[...s.currencies].map(([c,v])=>`${c}: gasto ${amount(v.spent,c)}, compromiso ${amount(v.committed,c)}`).join(' · ');
  return `<details class="border rounded-3 mb-3 p-3" open><summary class="fw-semibold" style="cursor:pointer">Requisición ${esc(folio==='SIN-NUMERO'?'sin número':folio)} · ${rows.length} SKU · ${new Set(rows.map(l=>l.requestId)).size} SC</summary><div class="small text-muted mt-2 mb-2">${esc(prices)}</div>${progression(top.length===1?top[0].key:'')}
  <div class="d-flex gap-2 flex-wrap mb-2">${top.map(m=>`<span class="followup-tag" style="background:${m.color}">${esc(m.label)}: ${s.counts[m.key]}</span>`).join('')}</div>
  <div class="followup-progress mb-3" aria-label="Distribución de estados de la requisición">${top.map(m=>`<span style="background:${m.color};width:${s.total?100*s.counts[m.key]/s.total:0}%" title="${esc(m.label)}: ${s.counts[m.key]} SKU"></span>`).join('')}</div>
  <div class="table-responsive"><table class="table table-sm table-striped followup-table"><thead><tr><th>Artículo (FabLab)</th><th>SC / SKU</th><th>Etapa institucional</th><th>Estado FabLab</th><th>Último reporte</th><th>Orden de compra</th><th>Entrega estimada</th><th class="text-end">Pendiente</th></tr></thead><tbody>
  ${rows.sort((a,b)=>statusInfo(a).order-statusInfo(b).order||String(a.nombre||'').localeCompare(String(b.nombre||''),'es')).map(l=>{const remaining=Math.max(0,(Number(l.quantityRequested)||0)-(Number(l.quantityReceived)||0)-(Number(l.quantityCancelled)||0));
   const local=remaining===0?(Number(l.quantityReceived)>0?'Recibido':'Cancelado'):l.warehousePickupPending?'En almacén':l.requisitionStatus==='requisitioned'?'En requisición':'En compras';
   const discrep=(statusKey(l)==='entregado'||statusKey(l)==='parcial')&&remaining>0?'<span class="small text-warning-emphasis">Confirmar recepción física</span>':'';
   return `<tr><td><strong>${esc(l.nombre||'')}</strong><div class="small text-muted">${esc(l.externalProcurementItemCode||'')} ${esc(l.descripcion||'').slice(0,100)}</div></td><td>${esc(l.requestFolio||'')}<div class="small text-muted">${esc(l.sku||'')}</div></td><td>${tag(l)}<div class="mt-1">${discrep}</div></td><td>${esc(local)}</td><td>${esc(l.externalReportDate||l.externalReportFile||'Sin fecha de reporte')}</td><td>${esc(l.externalPurchaseOrderNumber||'—')}</td><td>${esc(date(dateVal(l)))}</td><td class="text-end fw-semibold">${remaining}</td></tr>`;
  }).join('')}</tbody></table></div></details>`;
 }).join(''):'<div class="alert alert-info">No hay artículos para esta combinación de filtros.</div>');
}
function printView(){const w=window.open('','_blank');if(!w){alert('Habilita las ventanas emergentes para imprimir.');return;}
 const html=$('#iberoFollowupResults')?.innerHTML||'';
 w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Seguimiento de requisiciones FabLab</title><style>body{font:11px Arial,sans-serif;color:#222}h1{font-size:19px}table{border-collapse:collapse;width:100%}th,td{padding:5px;border-bottom:1px solid #bbb}th{text-align:left;background:#eee}.followup-tag{font-weight:bold;color:white;padding:2px 5px;border-radius:4px}.followup-stage{border:1px solid #ccc;background:white;padding:6px;margin:2px}.followup-count{font-weight:bold}.followup-kpi{display:inline-block;padding:7px;border:1px solid #ddd;margin:3px}.followup-progress{display:flex;height:12px;background:#eee}.followup-progress span{height:100%}.followup-flow small{display:inline-block;padding:4px;margin:3px;border:1px solid #ddd}details{break-inside:avoid}summary{font-size:13px;margin-top:10px;font-weight:bold}@page{size:A4 landscape;margin:10mm}</style></head><body><h1>FabLab IBERO · Seguimiento institucional de requisiciones</h1><p>Generado: ${new Date().toLocaleString('es-MX')}. Sólo estados de reportes importados y aprobados; no implica recepción física.</p>${html}<script>window.onload=()=>window.print();<\/script></body></html>`);w.document.close();}
function show(){const m=modal();const panel=$('#iberoRequisitionsPanel');const fn=()=>{bootstrap.Modal.getOrCreateInstance(m).show();void load();};
 if(panel?.classList.contains('show')){panel.addEventListener('hidden.bs.offcanvas',fn,{once:true});bootstrap.Offcanvas.getOrCreateInstance(panel).hide();}else fn();
}
async function init(){const user=auth.currentUser||await waitForUser();if(!user)return;const profile=await getUserProfile(user.uid);role=profile?.appRole||profile?.role||'';if(!['admin','supervisor'].includes(role))return;
 css();modal();launcher();const observer=new MutationObserver(launcher);observer.observe(document.body,{childList:true,subtree:true});
 document.addEventListener('click',e=>{const target=e.target;if(!(target instanceof Element))return;
  if(target.closest('#iberoFollowupOpen'))show();
  else if(target.closest('#iberoFollowupRefresh'))void load();
  else if(target.closest('#iberoFollowupPrint'))printView();
  else if(target.closest('#iberoFollowupAll')){selectedFolios=new Set(records.map(folioOf));drawCheckboxes();render();}
  else if(target.closest('#iberoFollowupNone')){selectedFolios.clear();drawCheckboxes();render();}
  else if(target.closest('.followup-stage')){$('#iberoFollowupStage').value=target.closest('.followup-stage').dataset.stage;render();}
 });
 document.addEventListener('input',e=>{if(e.target?.id==='iberoFollowupFolioFilter')drawCheckboxes();else if(e.target?.id==='iberoFollowupSearch')render();});
 document.addEventListener('change',e=>{if(e.target?.matches?.('.iberoFollowupFolio')){if(e.target.checked)selectedFolios.add(e.target.value);else selectedFolios.delete(e.target.value);drawCheckboxes();render();}else if(e.target?.id==='iberoFollowupStage')render();});
}
init().catch(e=>console.error('Seguimiento institucional:',e));
