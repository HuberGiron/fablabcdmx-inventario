/** Cálculos del reporte por áreas. Sin acceso a red ni escrituras. */
export const STAGES = [
  {key:'unsent', label:'Por enviar', color:'#64748b'},
  {key:'ordered', label:'En Compras', color:'#bd8700'},
  {key:'requisition', label:'En requisición', color:'#2563eb'},
  {key:'warehouse', label:'En almacén', color:'#d45a12'},
  {key:'received', label:'Recibido', color:'#15803d'},
];
export const number = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const positive = v => Math.max(0,number(v));
const str = v => String(v??'').trim();
export const normalize = v => str(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es-MX');
export const compare = (a,b) => str(a).localeCompare(str(b),'es',{numeric:true,sensitivity:'base'});
export const pending = l => Math.max(0,positive(l.quantityRequested)-positive(l.quantityReceived)-positive(l.quantityCancelled));
const currency = v => str(v).toUpperCase()||'MXN';
function meta(code,name) {
  const match=str(name).match(/^(\d+(?:\.\d+)*)(?:\.)?\s+(.+)$/);
  return match ? {code:match[1],name:match[2].trim()} : {code:str(code),name:str(name)};
}
const label = (m,fallback) => [m.code,m.name].filter(Boolean).join(' · ')||fallback;
const byId = (rows,field) => {
  const map=new Map();
  for(const row of rows) for(const id of [row[field],row.id]) if(id!=null&&str(id))map.set(str(id),row);
  return map;
};

export function makeRouteResolver({zones=[],subzones=[],locations=[]}={}) {
  const zm=byId(zones,'zoneId'),sm=byId(subzones,'subzoneId'),lm=byId(locations,'locationId');
  return item => {
    const loc=lm.get(str(item.locationId));
    const subId=str(loc?.subzoneId||item.subzoneId), sub=sm.get(subId);
    const zoneId=str(loc?.zoneId||sub?.zoneId||item.zoneId), zone=zm.get(zoneId);
    const zd=meta(zone?.zoneId||zoneId,zone?.name||item.zoneName);
    const sd=meta(sub?.subzoneId||subId,sub?.name||item.subzoneName);
    const rawCode=str(loc?.areaCode||loc?.locationCode||item.locationCode||item.areaCode);
    const ld=meta(rawCode,loc?.name||item.locationName);
    if(ld.code===rawCode&&subId&&sd.code!==subId&&rawCode.startsWith(subId+'.'))ld.code=sd.code+rawCode.slice(subId.length);
    const zoneKey=zoneId||'__none';
    const subKey=JSON.stringify([zoneKey,subId||'__none']);
    const areaKey=JSON.stringify([subKey,str(loc?.locationId||item.locationId||loc?.id)||rawCode||str(item.locationName)||'__none']);
    return {zoneKey,subKey,areaKey,zoneLabel:label(zd,'Sin zona'),subLabel:label(sd,'Sin subzona'),areaLabel:label(ld,'Sin área'),
      zoneCode:zd.code,subCode:sd.code,areaCode:ld.code};
  };
}

/** Una línea parcial produce registros por estado, sin repetir cantidades ni gasto.
 * El faltante por enviar usa el stock operativo y las líneas pendientes reales.
 * Los borradores quedan dentro de ese faltante; nunca se suman otra vez. */
export function buildReport({items=[],bundles=[],zones=[],subzones=[],locations=[]}) {
  const route=makeRouteResolver({zones,subzones,locations});
  const itemMap=byId(items,'id'),skuMap=new Map();
  for(const item of items){const key=str(item.sku);if(key)skuMap.set(key,skuMap.has(key)?null:item);}
  const waiting=new Map(),records=[];
  for(const {request={},lines=[]} of bundles) {
    if(request.status==='draft')continue;
    for(const line of lines) {
      const item=itemMap.get(str(line.itemId||line.id))||skuMap.get(str(line.sku));
      const qty=pending(line),received=positive(line.quantityReceived);
      if(item)waiting.set(str(item.id),(waiting.get(str(item.id))||0)+qty);
      // Mantener costos históricos; la ruta física y el nombre sí usan el catálogo actual.
      const source=item?{...line,...item}:line;
      const base={...route(source),itemId:str(item?.id||line.itemId||line.id),sku:str(source.sku),nombre:str(source.nombre)||'Sin nombre',
        currency:currency(line.currency),requestId:str(request.id),requestFolio:str(request.folio||request.id),
        requisition:str(line.requisitionNumber||line.externalRequisitionNumber),expectedDate:line.externalExpectedDeliveryDate||'',
        receivedDate:line.lastReceivedAt||'',requested:positive(line.quantityRequested),received,cancelled:positive(line.quantityCancelled),
        reportedStatus:str(line.externalReportedStatus)};
      const key=JSON.stringify([request.id,line.id||line.itemId]);
      if(qty>0) {
        const inReq=line.requisitionStatus==='requisitioned';
        const stage=inReq?(line.warehousePickupPending===true?'warehouse':'requisition'):'ordered';
        const unit=positive(inReq?(line.requisitionUnitCost??line.unitPrice):line.unitPrice);
        records.push({...base,key:key+':'+stage,stage,quantity:qty,amount:qty*unit});
      }
      if(received>0) {
        const spent=line.actualCostTotal!=null?positive(line.actualCostTotal):received*positive(line.lastActualUnitCost??line.unitPrice);
        records.push({...base,key:key+':received',stage:'received',quantity:received,amount:spent});
      }
    }
  }
  for(const item of items) {
    if(item.activo===false)continue;
    const stock=positive(item.stockAlmacen)+positive(item.stockPrestadoTemporal);
    const left=Math.max(0,positive(item.inventarioDeseado)-stock-(waiting.get(str(item.id))||0));
    if(left<=0)continue;
    records.push({...route(item),key:'unsent:'+str(item.id),itemId:str(item.id),sku:str(item.sku),nombre:str(item.nombre)||'Sin nombre',
      currency:currency(item.moneda),stage:'unsent',quantity:left,amount:left*positive(item.precioUnitario),
      requestFolio:'',requisition:'',expectedDate:'',receivedDate:'',requested:0,received:0,cancelled:0,reportedStatus:''});
  }
  return records;
}

export function selectRecords(records,filters={},stages=null,search='') {
  const terms=normalize(search).split(/\s+/).filter(Boolean);
  return records.filter(r => (!filters.zone||r.zoneKey===filters.zone)&&(!filters.subzone||r.subKey===filters.subzone)&&
    (!filters.area||r.areaKey===filters.area)&&(!filters.currency||r.currency===filters.currency)&&(!stages||stages.has(r.stage))&&
    terms.every(term=>normalize([r.nombre,r.sku,r.requestFolio,r.requisition,r.zoneLabel,r.subLabel,r.areaLabel].join(' ')).includes(term)));
}
export function summarize(records) {
  const totals={quantity:0,amount:0,stages:Object.fromEntries(STAGES.map(s=>[s.key,{quantity:0,amount:0}]))};
  for(const r of records){totals.quantity+=r.quantity;totals.amount+=r.amount;totals.stages[r.stage].quantity+=r.quantity;totals.stages[r.stage].amount+=r.amount;}
  const received=totals.stages.received.quantity;
  const sent=totals.quantity-totals.stages.unsent.quantity;
  return {...totals,sentQuantity:sent,sentAmount:totals.amount-totals.stages.unsent.amount,
    progress:totals.quantity?100*received/totals.quantity:0,sentProgress:sent?100*received/sent:0};
}
export function groupRecords(records,level='zone') {
  const fields={zone:['zoneKey','zoneLabel'],subzone:['subKey','subLabel'],area:['areaKey','areaLabel']};
  const [key,labelField]=fields[level]||fields.zone,groups=new Map();
  for(const record of records) {
    if(!groups.has(record[key]))groups.set(record[key],{key:record[key],label:record[labelField],route:record,records:[]});
    groups.get(record[key]).records.push(record);
  }
  return [...groups.values()].map(g=>({...g,totals:summarize(g.records)})).sort((a,b)=>
    compare(a.route.zoneCode,b.route.zoneCode)||compare(a.route.subCode,b.route.subCode)||compare(a.route.areaCode,b.route.areaCode)||compare(a.label,b.label));
}
