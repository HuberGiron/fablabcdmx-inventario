/* Agrupación y cálculos puros para el catálogo informativo de requisiciones.
   No modifica Firestore; no mezcla monedas ni suma gasto cancelado. */
export const n = value => { const x=Number(value); return Number.isFinite(x)?x:0; };
export const q = value => Math.max(0,Math.trunc(n(value)));
export const pending = l => Math.max(0,q(l.quantityRequested)-q(l.quantityReceived)-q(l.quantityCancelled));
export const folioKey = value => String(value||'').trim().replace(/\s+/g,' ').toLocaleUpperCase('es-MX');
export const cleanFolio = value => String(value||'').trim().replace(/\s+/g,' ');
export function amounts(l) {
  const received=q(l.quantityReceived), outstanding=pending(l);
  const unit=Math.max(0,n(l.requisitionStatus==='requisitioned'?(l.requisitionUnitCost??l.unitPrice):l.unitPrice));
  const spent=Object.prototype.hasOwnProperty.call(l,'actualCostTotal')?Math.max(0,n(l.actualCostTotal)):
    received*Math.max(0,n(l.lastActualUnitCost??l.unitPrice));
  return {requested:q(l.quantityRequested),received,cancelled:q(l.quantityCancelled),pending:outstanding,
    spent,committed:outstanding*unit,used:spent+outstanding*unit,currency:String(l.currency||'MXN').toUpperCase()};
}
export function stage(l) {
  const t=amounts(l);
  if(t.pending>0&&t.received>0)return 'Recepción parcial';
  if(t.pending>0&&t.cancelled>0)return 'Requisición parcial / cancelación';
  if(t.pending>0)return 'En requisición';
  if(t.received>0&&t.cancelled>0)return 'Recepción y cancelación';
  if(t.received>0)return 'Recibido';
  return 'Cancelado';
}
export function groupRequisitions(requestBundles) {
  const groups=new Map();
  for(const bundle of requestBundles) {
    const request=bundle.request||{};
    if(request.status==='draft')continue;
    for(const raw of (bundle.lines||[])) {
      if(raw.requisitionStatus!=='requisitioned')continue;
      const line={...raw,requestId:request.id,requestFolio:request.folio||request.id,requestAlias:request.alias||''};
      const folio=cleanFolio(line.requisitionNumber);
      const key=folio?`folio:${folioKey(folio)}`:`sin-folio:${request.id}`;
      if(!groups.has(key))groups.set(key,{key,folio,unassigned:!folio,requestIds:new Set(),lines:[],currencies:new Map()});
      const group=groups.get(key),t=amounts(line);
      group.lines.push(line);group.requestIds.add(request.id);
      if(!group.currencies.has(t.currency))group.currencies.set(t.currency,{requested:0,received:0,cancelled:0,pending:0,spent:0,committed:0,used:0});
      const v=group.currencies.get(t.currency);
      for(const col of ['requested','received','cancelled','pending','spent','committed','used'])v[col]+=t[col];
    }
  }
  return [...groups.values()].sort((a,b)=>(a.unassigned-b.unassigned)||a.folio.localeCompare(b.folio,'es',{numeric:true})||a.key.localeCompare(b.key));
}
