/** FabLab IBERO | Cálculos puros del reporte de avance institucional.
 * Los pesos describen hitos del proceso, NO porcentajes oficiales de Compras.
 * Nunca se usan para presupuesto, existencias ni recepción de inventario.
 */
import {STATUS_META,statusKey} from './compras-seguimiento-model.js';

export const PROGRESS_WEIGHTS = Object.freeze({
  sin_reporte:0, no_generada:0, generada:10, firma:20,
  cotizado:35, surtir:60, almacen:80, parcial:90, entregado:100,
  cancelado:null,
});
export const qty = value => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
export const groupFolio = line => String(line.requisitionNumber || line.externalRequisitionNumber || '').trim();
export function collectRequisitions(lines){
  const map = new Map();
  for(const line of lines){
    const folio=groupFolio(line);
    const requestId=String(line.requestId||'');
    const key=folio?`folio:${folio.toLocaleUpperCase('es-MX')}`:`pending:${requestId}`;
    if(!map.has(key))map.set(key,{key,folio,requestId,lines:[]});
    map.get(key).lines.push(line);
  }
  return [...map.values()].sort((a,b)=>a.folio&&b.folio?a.folio.localeCompare(b.folio,'es',{numeric:true}):a.folio?-1:b.folio?1:a.requestId.localeCompare(b.requestId));
}
export function summarizeRequisition(lines){
  const counts=Object.fromEntries(STATUS_META.map(s=>[s.key,0]));
  let pointSum=0,activeLines=0,received=0,effectiveRequested=0,pending=0;
  const scs=new Set();let lastReport='',nextDelivery='';
  for(const l of lines){
    const stage=statusKey(l);counts[stage]=(counts[stage]||0)+1;
    const score=PROGRESS_WEIGHTS[stage];
    if(score!==null&&score!==undefined){activeLines++;pointSum+=score;}
    const requested=qty(l.quantityRequested),r=qty(l.quantityReceived),c=qty(l.quantityCancelled);
    effectiveRequested+=Math.max(0,requested-c);
    received+=r;
    const remaining=Math.max(0,requested-r-c);
    pending+=remaining;
    scs.add(String(l.requestId||''));
    const date=String(l.externalReportDate||'');
    if(/^\d{4}-\d{2}-\d{2}$/.test(date)&&date>lastReport)lastReport=date;
    const delivery=String(l.externalExpectedDeliveryDate||'');
    if(remaining>0&&/^\d{4}-\d{2}-\d{2}$/.test(delivery)&&(!nextDelivery||delivery<nextDelivery))nextDelivery=delivery;
  }
  const count=lines.length;
  const shares=Object.fromEntries(STATUS_META.map(s=>[s.key,count?100*counts[s.key]/count:0]));
  return {count,counts,shares,progressPct:activeLines?Math.round(pointSum/activeLines):0,
    activeLines,receivedPct:effectiveRequested?Math.round(100*Math.min(1,received/effectiveRequested)):0,
    received,effectiveRequested,pending,scs:scs.size,lastReport,nextDelivery};
}
