/** Vista analítica pura de estados institucionales. No realiza escrituras. */
export const STATUS_META = [
 {key:'no_generada',label:'No Generada',color:'#64748b',order:0,local:'En requisición'},
 {key:'firma',label:'Firma Electrónica',color:'#8053bd',order:1,local:'En requisición'},
 {key:'surtir',label:'Por Surtir',color:'#0d6efd',order:2,local:'En requisición'},
 {key:'almacen',label:'En Almacén',color:'#d35400',order:3,local:'En almacén'},
 {key:'parcial',label:'Entregado Parcial al Usuario',color:'#087f8c',order:4,local:'Recepción parcial'},
 {key:'entregado',label:'Entregado al Usuario',color:'#198754',order:5,local:'Recibido (por confirmar)'},
 {key:'sin_reporte',label:'Sin reporte institucional',color:'#9ca3af',order:6,local:'Conservar estado FabLab'},
 {key:'cancelado',label:'Cancelado en FabLab',color:'#575d65',order:7,local:'Cancelado'},
];
const normalized=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
export function statusKey(line){
 const q=Math.max(0,Number(line.quantityRequested||0)-Number(line.quantityReceived||0)-Number(line.quantityCancelled||0));
 if(q===0&&Number(line.quantityReceived||0)===0&&Number(line.quantityCancelled||0)>0)return 'cancelado';
 const s=normalized(line.externalReportedStatus);
 if(/entregado\s+parcial/.test(s))return 'parcial';
 if(/entregado\s+al\s+usuario/.test(s))return 'entregado';
 if(/en\s+almacen/.test(s))return 'almacen';
 if(/por\s+surtir/.test(s))return 'surtir';
 if(/firma\s+electronica/.test(s))return 'firma';
 if(/no\s+generada/.test(s))return 'no_generada';
 // Si el aviso manual de almacén está activo, mostrarlo aun sin PDF importado.
 if(q>0&&line.warehousePickupPending===true)return 'almacen';
 return 'sin_reporte';
}
export const statusInfo=line=>STATUS_META.find(s=>s.key===statusKey(line))||STATUS_META[6];
export function summarize(lines){
 const counts=Object.fromEntries(STATUS_META.map(s=>[s.key,0]));
 const requisitions=new Set(),scs=new Set();let requested=0,received=0,pending=0,spent=0,committed=0;
 const currencies=new Map();
 for(const line of lines){
  counts[statusKey(line)]++;
  requisitions.add(String(line.requisitionNumber||line.externalRequisitionNumber||'SIN-NUMERO'));
  scs.add(String(line.requestId||''));
  const q=Number(line.quantityRequested)||0,r=Number(line.quantityReceived)||0,c=Number(line.quantityCancelled)||0;
  const left=Math.max(0,q-r-c);requested+=q;received+=r;pending+=left;
  const currency=String(line.currency||'MXN').toUpperCase();
  const actual=line.actualCostTotal!=null?Number(line.actualCostTotal)||0:r*(Number(line.lastActualUnitCost??line.unitPrice)||0);
  const unit=Number(line.requisitionStatus==='requisitioned'?(line.requisitionUnitCost??line.unitPrice):line.unitPrice)||0;
  const due=left*unit;
  const total=currencies.get(currency)||{spent:0,committed:0};total.spent+=actual;total.committed+=due;currencies.set(currency,total);
  if(currency==='MXN'){spent+=actual;committed+=due;}
 }
 return {counts,total:lines.length,requisitions:requisitions.size,scs:scs.size,requested,received,pending,currencies,spentMXN:spent,committedMXN:committed};
}
export function selectLines(lines,selectedFolios,search='',status='all'){
 const terms=normalized(search).split(/\s+/).filter(Boolean);
 return lines.filter(l=>{
  const folio=String(l.requisitionNumber||l.externalRequisitionNumber||'SIN-NUMERO');
  if(selectedFolios&&!selectedFolios.has(folio))return false;
  if(status!=='all'&&statusKey(l)!==status)return false;
  const words=normalized([folio,l.externalProcurementItemCode,l.requestFolio,l.requestAlias,l.sku,l.nombre,l.externalPurchaseOrderNumber,l.externalReportedStatus].join(' '));
  return terms.every(t=>words.includes(t));
 });
}
