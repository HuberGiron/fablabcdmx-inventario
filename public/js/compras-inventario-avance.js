/** Reporte de inventario y avance por zona/subzona/área. Sólo lectura. */
import {db} from './firebase-app.js';
import {waitForUser,getUserProfile} from './common.js';
import {collection,getDocsFromServer,query,where} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import {STAGES,buildReport,selectRecords,summarize,groupRecords,compare,makeRouteResolver} from './compras-inventario-avance-model.js?v=20261023a';

const root=document.getElementById('inventoryAreaReport');
const $=id=>root.querySelector('#iar'+id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const qty=v=>Number(v).toLocaleString('es-MX',{maximumFractionDigits:2});
const pct=v=>Number(v).toLocaleString('es-MX',{maximumFractionDigits:1})+'%';
const money=(v,code=currentCurrency())=>{
  try{return new Intl.NumberFormat('es-MX',{style:'currency',currency:code,maximumFractionDigits:2}).format(v)+' '+code;}
  catch{return qty(v)+' '+code;}
};
const stageInfo=key=>STAGES.find(s=>s.key===key);
let records=[],loaded=false,busy=false,stale=false,page=1,loadedAt='',chartPage=1;
let zoneOptions=[],subzoneOptions=[],areaOptions=[];
const PAGE_SIZE=35,CHART_SIZE=15;
let stageSelection=new Set(STAGES.map(s=>s.key));
function currentCurrency(){return $('Currency')?.value||'MXN';}
function filters(){return {zone:$('Zone').value,subzone:$('Subzone').value,area:$('Area').value,currency:currentCurrency()};}
function scope(){return selectRecords(records,filters());}
function selected(){return selectRecords(records,filters(),stageSelection,$('Search').value);}
function dateText(value) {
  if(!value)return 'Sin fecha';
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(value)))return String(value).split('-').reverse().join('/');
  const date=typeof value.toDate==='function'?value.toDate():new Date(value.seconds!=null?value.seconds*1000:value);
  return Number.isNaN(date.getTime())?'Sin fecha':date.toLocaleDateString('es-MX',{timeZone:'America/Mexico_City'});
}
function deliveryText(r){return r.stage==='received'?'Últ. recepción: '+dateText(r.receivedDate):r.stage==='unsent'?'Por definir':dateText(r.expectedDate);}

function setup(){
  $('Body').innerHTML=`
  <div class="iar-filters">
    <label>Zona<select id="iarZone" class="form-select form-select-sm"><option value="">Todas las zonas</option></select></label>
    <label>Subzona<select id="iarSubzone" class="form-select form-select-sm"><option value="">Todas las subzonas</option></select></label>
    <label>Área / ubicación<select id="iarArea" class="form-select form-select-sm"><option value="">Todas las áreas</option></select></label>
    <label>Moneda<select id="iarCurrency" class="form-select form-select-sm"><option>MXN</option></select></label>
    <button id="iarReset" class="btn btn-outline-secondary btn-sm" type="button">Limpiar</button>
  </div>
  <div class="iar-load-line"><span id="iarLoadStatus" role="status" aria-live="polite"></span><button id="iarRefresh" type="button" class="btn btn-outline-primary btn-sm">Actualizar datos</button></div>
  <div id="iarResults" hidden>
    <div id="iarKpis" class="iar-kpis"></div>
    <div id="iarProgress" class="iar-progress-note"></div>
    <p class="iar-note">Costo total = compromiso por enviar (estimado) + pendientes enviados + gasto recibido. Por enviar incluye borradores; se descuenta el stock operativo y lo ya pendiente en SC. El inventario previo sin SC no se valora como gasto de compra. Cancelaciones excluidas. Sin conversión de divisas.</p>
    <div class="iar-section-head"><h3>Estados del área seleccionada</h3><div><button type="button" id="iarAll" class="btn btn-link btn-sm">Todos</button><button type="button" id="iarNone" class="btn btn-link btn-sm">Ninguno</button></div></div>
    <div id="iarStages" class="iar-stages" role="group" aria-label="Estados incluidos en gráficas y listado"></div>
    <div class="iar-section-head iar-chart-tools">
      <h3>Distribución por <span id="iarLevelLabel">zona</span></h3>
      <div class="iar-inline-controls">
        <label>Agrupar<select id="iarGroup" class="form-select form-select-sm"><option value="zone">Zonas</option><option value="subzone">Subzonas</option><option value="area">Áreas</option></select></label>
        <label>Medir<select id="iarMetric" class="form-select form-select-sm"><option value="amount">Costo</option><option value="quantity">Cantidades</option></select></label>
      </div>
    </div>
    <p class="iar-note">Cada barra representa el 100% del total de su zona, subzona o área en los estados seleccionados. Los colores muestran la proporción de cada estado. Las gráficas y el listado incluyen la búsqueda; el porcentaje recibido conserva todos los estados del alcance. Pulsa un nombre para entrar al área o un segmento para ver ese estado.</p>
    <div id="iarCharts" class="iar-charts"></div>
    <div class="iar-pager"><button type="button" id="iarChartPrev" class="btn btn-outline-secondary btn-sm">Anterior</button><span id="iarChartPages"></span><button type="button" id="iarChartNext" class="btn btn-outline-secondary btn-sm">Siguiente</button></div>
    <div class="iar-section-head iar-detail-tools"><h3>Elementos en los estados seleccionados</h3><div class="iar-inline-controls"><label><span class="visually-hidden">Buscar en el reporte</span><input type="search" id="iarSearch" class="form-control form-control-sm" placeholder="Nombre, SKU, SC o requisición"></label><label><span class="visually-hidden">Ordenar listado</span><select id="iarSort" class="form-select form-select-sm"><option value="route">Zona / área</option><option value="name">Nombre</option><option value="date">Fecha de entrega</option><option value="stage">Estado</option></select></label></div></div>
    <div id="iarDetailCount" class="iar-note" aria-live="polite"></div>
    <div class="iar-table-wrap"><table class="iar-table"><thead><tr><th>Elemento / área</th><th>Estado</th><th>Cant.</th><th>Requisición / SC</th><th>Entrega prevista / recepción</th><th>Importe</th></tr></thead><tbody id="iarRows"></tbody></table></div>
    <div class="iar-pager"><button id="iarPrev" type="button" class="btn btn-outline-secondary btn-sm">Anterior</button><span id="iarPages"></span><button id="iarNext" type="button" class="btn btn-outline-secondary btn-sm">Siguiente</button></div>
    <div class="iar-export"><button type="button" id="iarCsv" class="btn btn-outline-success btn-sm">Descargar listado CSV</button><button type="button" id="iarPrint" class="btn btn-outline-dark btn-sm">Imprimir / Guardar PDF</button></div>
  </div>`;
}

function setOptions(id,rows,key,label,placeholder){
  const el=$(id),value=el.value,map=new Map();
  for(const row of rows)if(!map.has(row[key]))map.set(row[key],row);
  const sorted=[...map.values()].sort((a,b)=>compare(a.zoneCode,b.zoneCode)||compare(a.subCode,b.subCode)||compare(a.areaCode,b.areaCode)||compare(a[label],b[label]));
  el.innerHTML=`<option value="">${placeholder}</option>`+sorted.map(r=>`<option value="${esc(r[key])}">${esc(r[label])}</option>`).join('');
  if(map.has(value))el.value=value;
}
function fillFilters(){
  setOptions('Zone',zoneOptions,'zoneKey','zoneLabel','Todas las zonas');
  const z=$('Zone').value;
  setOptions('Subzone',subzoneOptions.filter(r=>!z||r.zoneKey===z),'subKey','subLabel','Todas las subzonas');
  const s=$('Subzone').value;
  setOptions('Area',areaOptions.filter(r=>(!z||r.zoneKey===z)&&(!s||r.subKey===s)),'areaKey','areaLabel','Todas las áreas');
  const code=currentCurrency(),currencies=[...new Set(records.map(r=>r.currency))].sort((a,b)=>(a==='MXN'?-1:b==='MXN'?1:compare(a,b)));
  $('Currency').innerHTML=(currencies.length?currencies:['MXN']).map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('Currency').value=currencies.includes(code)?code:(currencies[0]||'MXN');
}
async function fetchData(){
  if(busy)return;busy=true;$('Refresh').disabled=true;$('Results').hidden=true;
  $('LoadStatus').textContent='Consultando inventario y solicitudes…';root.setAttribute('aria-busy','true');
  try{
    const user=await waitForUser(),profile=user?await getUserProfile(user.uid):null;
    if(!['admin','supervisor'].includes(profile?.appRole||profile?.role))throw new Error('Se requiere acceso de Administrador o Supervisor.');
    const snapshots=await Promise.all([
      getDocsFromServer(query(collection(db,'items'),where('activo','==',true))),
      getDocsFromServer(collection(db,'zones')),getDocsFromServer(collection(db,'subzones')),
      getDocsFromServer(collection(db,'locations')),getDocsFromServer(collection(db,'purchaseRequests')),
    ]);
    const [items,zones,subzones,locations,requests]=snapshots.map(s=>s.docs.map(d=>({...d.data(),id:d.id})));
    const sent=requests.filter(r=>r.status!=='draft'),bundles=new Array(sent.length);
    let cursor=0,completed=0;
    const tasks=await Promise.allSettled(Array.from({length:Math.min(5,sent.length)},async()=>{
      while(cursor<sent.length){const index=cursor++,request=sent[index];
        const snap=await getDocsFromServer(collection(db,'purchaseRequests',request.id,'items'));
        bundles[index]={request,lines:snap.docs.map(d=>({...d.data(),id:d.id}))};
        completed++;$('LoadStatus').textContent=`Consultando SC ${completed} de ${sent.length}…`;
      }
    }));
    if(tasks.some(t=>t.status==='rejected'))throw new Error('No se pudieron leer todas las solicitudes. Pulsa Actualizar datos para reintentar el reporte completo.');
    records=buildReport({items,zones,subzones,locations,bundles});
    const resolve=makeRouteResolver({zones,subzones,locations});
    areaOptions=[...records,...items.map(resolve),...locations.filter(l=>l.active!==false).map(l=>resolve({locationId:l.locationId||l.id,zoneId:l.zoneId,subzoneId:l.subzoneId,locationName:l.name}))];
    zoneOptions=[...areaOptions,...zones.map(z=>resolve({zoneId:z.zoneId||z.id,zoneName:z.name}))];
    subzoneOptions=[...areaOptions,...subzones.map(s=>resolve({zoneId:s.zoneId,subzoneId:s.subzoneId||s.id,subzoneName:s.name}))];
    loaded=true;stale=false;
    loadedAt=new Date().toLocaleString('es-MX',{timeZone:'America/Mexico_City',dateStyle:'short',timeStyle:'short'});
    fillFilters();page=1;chartPage=1;$('Results').hidden=false;render();
    $('LoadStatus').textContent=`Actualizado ${loadedAt} (CDMX) · ${sent.length} SC · ${items.length} artículos activos. Todos los años.`;
  }catch(error){loaded=false;console.error('Reporte por áreas:',error);$('LoadStatus').textContent=`No se generó el reporte: ${error.message}`;}
  finally{busy=false;$('Refresh').disabled=false;root.setAttribute('aria-busy','false');}
}
function renderKpis(t){
  const cards=[['Costo total del área',money(t.amount)],['Compromiso por enviar',money(t.stages.unsent.amount)],['Solicitado vigente',money(t.sentAmount)],['Gasto recibido',money(t.stages.received.amount)]];
  $('Kpis').innerHTML=cards.map(([name,value])=>`<div class="iar-kpi"><span>${name}</span><strong>${value}</strong></div>`).join('');
  $('Progress').innerHTML=`<strong>${pct(t.progress)} recibido del alcance total</strong><progress max="100" value="${t.progress}" aria-label="Porcentaje recibido del alcance total"></progress><span>${qty(t.stages.received.quantity)} de ${qty(t.quantity)} unidades · De lo enviado: ${pct(t.sentProgress)} recibido (${qty(t.stages.received.quantity)}/${qty(t.sentQuantity)}). Avance por cantidades.</span>`;
  $('Stages').innerHTML=STAGES.map(s=>{
    const v=t.stages[s.key];
    return `<label class="iar-stage ${stageSelection.has(s.key)?'is-on':''}" style="--iar-tone:${s.color}"><input id="iarStage-${s.key}" type="checkbox" value="${s.key}" ${stageSelection.has(s.key)?'checked':''}><span><strong>${s.label}</strong><span>${money(v.amount)}</span><small>${qty(v.quantity)} unidades</small></span></label>`;
  }).join('');
}
function renderCharts(rows){
  const level=$('Group').value,metric=$('Metric').value,groups=groupRecords(rows,level),pages=Math.max(1,Math.ceil(groups.length/CHART_SIZE));
  const contextTotals=new Map(groupRecords(selectRecords(records,filters(),null,$('Search').value),level).map(g=>[g.key,g.totals]));
  chartPage=Math.min(chartPage,pages);$('LevelLabel').textContent={zone:'zona',subzone:'subzona',area:'área'}[level];
  $('Charts').innerHTML=groups.slice((chartPage-1)*CHART_SIZE,chartPage*CHART_SIZE).map(g=>{
    const t=g.totals,r=g.route,context=level==='zone'?'':level==='subzone'?r.zoneLabel:r.zoneLabel+' / '+r.subLabel;
    const whole=metric==='amount'?money(t.amount):qty(t.quantity)+' unidades';
    const segments=STAGES.filter(s=>t.stages[s.key][metric]>0).map(s=>{
      const value=t.stages[s.key][metric],text=metric==='amount'?money(value):qty(value)+' unidades';
      const share=t[metric]?value/t[metric]*100:0;
      return `<button type="button" class="iar-segment" style="width:${share}%;background:${s.color}" data-stage="${s.key}" title="${esc(s.label+': '+text+' · '+pct(share))}" aria-label="${esc(g.label+' · '+s.label+': '+text+' · '+pct(share)+'. Filtrar este estado')}"></button>`;
    }).join('');
    const progress=contextTotals.get(g.key)?.progress||0;
    return `<div class="iar-chart-row"><div class="iar-chart-label"><button type="button" data-route="${esc(g.key)}" title="Filtrar esta ubicación">${esc(g.label)}</button>${context?`<small>${esc(context)}</small>`:''}</div><div class="iar-bar" aria-label="${esc(g.label+': '+whole)}">${segments||'<span class="iar-zero">Sin importe registrado</span>'}</div><strong>${esc(whole)}<small>${pct(progress)} recibido</small></strong></div>`;
  }).join('')||'<p class="iar-empty">No hay elementos en los estados seleccionados para este filtro.</p>';
  $('ChartPages').textContent=`${groups.length} grupos · ${chartPage}/${pages}`;
  $('ChartPrev').disabled=chartPage<=1;$('ChartNext').disabled=chartPage>=pages;
}
function sortedRows(){
  const mode=$('Sort').value,rank=key=>STAGES.findIndex(s=>s.key===key);
  const date=r=>r.stage==='received'?'':String(r.expectedDate||'');
  return selected().sort((a,b)=>{
    let delta=0;
    if(mode==='name')delta=compare(a.nombre,b.nombre);
    if(mode==='stage')delta=rank(a.stage)-rank(b.stage);
    if(mode==='date')delta=(date(a)?0:1)-(date(b)?0:1)||compare(date(a),date(b));
    return delta||compare(a.zoneCode,b.zoneCode)||compare(a.subCode,b.subCode)||compare(a.areaCode,b.areaCode)||compare(a.nombre,b.nombre)||compare(a.sku,b.sku)||compare(a.requestFolio,b.requestFolio)||rank(a.stage)-rank(b.stage);
  });
}
function tableRows(rows){
  return rows.map(r=>{
    const s=stageInfo(r.stage),context=[r.zoneLabel,r.subLabel,r.areaLabel].join(' / ');
    return `<tr><td><strong>${esc(r.nombre)}</strong><small>${esc(r.sku||'Sin SKU')} · ${esc(context)}</small></td><td><span class="iar-badge" style="--iar-tone:${s.color}">${s.label}</span></td><td class="iar-number" title="${esc(r.stage==='unsent'?'Faltante aún no enviado':`SC: ${qty(r.requested)} solicitadas, ${qty(r.received)} recibidas, ${qty(r.cancelled)} canceladas`)}">${qty(r.quantity)}</td><td>${esc(r.requisition||'Sin requisición')}<small>${esc(r.requestFolio||'Sin SC enviada')}</small></td><td>${esc(deliveryText(r))}${r.reportedStatus?`<small>Reporte externo: ${esc(r.reportedStatus)}</small>`:''}</td><td class="iar-number">${esc(money(r.amount,r.currency))}</td></tr>`;
  }).join('');
}
function renderTable(){
  const rows=sortedRows(),t=summarize(rows),pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE));
  page=Math.min(page,pages);
  $('Rows').innerHTML=tableRows(rows.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE))||'<tr><td colspan="6" class="iar-empty">No hay elementos con los filtros y estados seleccionados.</td></tr>';
  $('DetailCount').textContent=`${new Set(rows.map(r=>r.itemId||r.sku)).size} artículos · ${rows.length} renglones por SC/estado · ${qty(t.quantity)} unidades · ${money(t.amount)}. Una recepción parcial aparece en sus estados, con las cantidades separadas.`;
  $('Pages').textContent=`Página ${page} de ${pages}`;$('Prev').disabled=page<=1;$('Next').disabled=page>=pages;
}
function render(){if(!loaded)return;const focusId=document.activeElement?.id;renderKpis(summarize(scope()));renderCharts(selected());renderTable();if(focusId?.startsWith('iarStage-'))document.getElementById(focusId)?.focus({preventScroll:true});}
function applyRoute(key){
  const level=$('Group').value,keyField={zone:'zoneKey',subzone:'subKey',area:'areaKey'}[level],row=records.find(r=>r[keyField]===key);
  if(!row)return;
  $('Zone').value=row.zoneKey;$('Subzone').value='';$('Area').value='';fillFilters();
  if(level!=='zone'){$('Subzone').value=row.subKey;fillFilters();}
  if(level==='area')$('Area').value=row.areaKey;
  $('Group').value=level==='zone'?'subzone':'area';page=1;chartPage=1;render();
}
function downloadCsv(){
  const header=['Zona','Subzona','Área','SKU','Nombre','Estado','Cantidad en estado','Requisición','SC','Entrega / recepción','Importe','Moneda'];
  // Evitar fórmulas al abrir texto externo en Excel.
  const cell=v=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
  const lines=sortedRows().map(r=>[r.zoneLabel,r.subLabel,r.areaLabel,r.sku,r.nombre,stageInfo(r.stage).label,r.quantity,r.requisition,r.requestFolio,deliveryText(r),r.amount,r.currency]);
  const blob=new Blob(['\uFEFF'+[header,...lines].map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='Fablab_avance_por_areas.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function printReport(){
  const popup=window.open('','_blank');if(!popup){$('LoadStatus').textContent='Permite ventanas emergentes para imprimir el reporte.';return;}
  const styleLink=new URL('css/compras-inventario-avance.css?v=20261023a',window.location.href).href;
  const scopeLabel=['Zone','Subzone','Area'].map(id=>$(id).selectedOptions[0]?.textContent).join(' / ');
  const rows=sortedRows(),t=summarize(rows);
  // Imprimir todas las páginas de gráficas y listado, conservando filtros.
  const groups=groupRecords(rows,$('Group').value),metric=$('Metric').value;
  const groupLabel=g=>$('Group').value==='zone'?g.label:$('Group').value==='subzone'?g.route.zoneLabel+' / '+g.label:g.route.zoneLabel+' / '+g.route.subLabel+' / '+g.label;
  const charts=groups.map(g=>`<div class="iar-print-chart"><strong>${esc(groupLabel(g))}</strong><div class="iar-bar">${STAGES.map(s=>`<span style="display:block;height:100%;background:${s.color};width:${g.totals[metric]?g.totals.stages[s.key][metric]/g.totals[metric]*100:0}%"></span>`).join('')}</div><span>${esc(metric==='amount'?money(g.totals.amount):qty(g.totals.quantity)+' unidades')}</span></div>`).join('');
  popup.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Avance por áreas · FabLab IBERO</title><link rel="stylesheet" href="${esc(styleLink)}"></head><body class="iar-print"><div class="iar-print-controls"><button id="printNow">Imprimir / Guardar PDF</button></div><section id="inventoryAreaReport"><h1>FabLab IBERO · Inventario y avance por áreas</h1><p>${esc(scopeLabel)} · ${esc(currentCurrency())}<br>Actualizado ${esc(loadedAt)} (CDMX)${stale?' · DATOS PENDIENTES DE ACTUALIZAR':''}</p><div class="iar-kpis">${$('Kpis').innerHTML}</div><p>${esc($('Progress').textContent)}</p><p class="iar-note">${esc(root.querySelector('.iar-note').textContent)}</p><p>Estados: ${esc(STAGES.filter(s=>stageSelection.has(s.key)).map(s=>s.label).join(', ')||'Ninguno')} · Búsqueda: ${esc($('Search').value||'Todas')} · Selección: ${esc(money(t.amount))} / ${qty(t.quantity)} unidades</p><div class="iar-print-legend">${STAGES.map(s=>`<span style="border-left:9px solid ${s.color};padding-left:5px;margin-right:10px">${s.label}</span>`).join('')}</div><p class="iar-note">Cada barra representa el 100% del total de su grupo en los estados seleccionados; los colores muestran la proporción de cada estado.</p>${charts}<table class="iar-table"><thead>${root.querySelector('thead').innerHTML}</thead><tbody>${tableRows(rows)}</tbody></table></section></body></html>`);
  popup.document.close();
  popup.document.getElementById('printNow').addEventListener('click',()=>popup.print());
}
function markStale(){if(!loaded)return;stale=true;$('LoadStatus').textContent='Hay cambios de compras o inventario. Pulsa Actualizar datos para recalcular este reporte.';}

if(root){
  setup();
  $('Toggle').addEventListener('click',()=>{
    const open=$('Body').hidden;$('Body').hidden=!open;$('Toggle').setAttribute('aria-expanded',String(open));$('Toggle').textContent=open?'Ocultar reporte':'Ver reporte por áreas';
    if(open)fetchData();
  });
  root.addEventListener('change',event=>{
    const id=event.target.id;
    if(event.target.matches('#iarStages input')){
      if(event.target.checked)stageSelection.add(event.target.value);else stageSelection.delete(event.target.value);
    }else if(id==='iarZone'){$('Subzone').value='';$('Area').value='';fillFilters();$('Group').value=$('Zone').value?'subzone':'zone';}
    else if(id==='iarSubzone'){
      const row=subzoneOptions.find(r=>r.subKey===$('Subzone').value);if(row)$('Zone').value=row.zoneKey;
      $('Area').value='';fillFilters();$('Group').value=$('Subzone').value?'area':($('Zone').value?'subzone':'zone');
    }else if(id==='iarArea'){
      const row=areaOptions.find(r=>r.areaKey===$('Area').value);
      if(row){$('Zone').value=row.zoneKey;fillFilters();$('Subzone').value=row.subKey;fillFilters();$('Area').value=row.areaKey;$('Group').value='area';}
    }
    page=1;chartPage=1;render();
  });
  let searchTimer;
  $('Search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{page=1;chartPage=1;renderCharts(selected());renderTable();},150);});
  root.addEventListener('click',event=>{
    const target=event.target.closest('button');if(!target)return;
    if(target.dataset.stage){stageSelection=new Set([target.dataset.stage]);page=1;chartPage=1;render();return;}
    if(target.dataset.route){applyRoute(target.dataset.route);return;}
    switch(target.id){
      case 'iarRefresh':fetchData();break;
      case 'iarAll':stageSelection=new Set(STAGES.map(s=>s.key));page=1;chartPage=1;render();break;
      case 'iarNone':stageSelection.clear();page=1;chartPage=1;render();break;
      case 'iarReset':$('Zone').value='';$('Subzone').value='';$('Area').value='';$('Search').value='';$('Group').value='zone';$('Metric').value='amount';$('Sort').value='route';stageSelection=new Set(STAGES.map(s=>s.key));fillFilters();page=1;chartPage=1;render();break;
      case 'iarPrev':page--;renderTable();break;
      case 'iarNext':page++;renderTable();break;
      case 'iarChartPrev':chartPage--;renderCharts(selected());break;
      case 'iarChartNext':chartPage++;renderCharts(selected());break;
      case 'iarCsv':downloadCsv();break;
      case 'iarPrint':printReport();break;
    }
  });
  for(const event of ['purchase:finance-reconciled','purchase:catalog-refreshed','purchase:items-local-updated'])document.addEventListener(event,markStale);
  document.addEventListener('click',event=>{
    if(event.target.closest('.request-draft-send,.request-line-requisition,.request-line-receive,.request-line-cancel,.request-history-cancel,.request-history-delete,#purchaseRequestCancelAll,#purchaseRequestDelete,#purchaseGroupBatchSave,#requestWideRequisitionSave,#requestPriceModalSave'))markStale();
  });
  // Las extensiones antiguas no siempre emiten eventos. Un regreso a la página
  // invalida la fecha de corte sin lanzar lecturas repetidas en segundo plano.
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)markStale();});
}

