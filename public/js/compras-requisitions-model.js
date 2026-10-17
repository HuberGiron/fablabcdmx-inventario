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
// Aviso logístico: NO es recepción física ni gasto ejecutado. Sólo tiene
// vigencia para piezas pendientes de una línea que está en requisición.
export const warehouseReady = l => l.requisitionStatus==='requisitioned' && pending(l)>0 && l.warehousePickupPending===true;
export const stateTone = l => warehouseReady(l)?'warehouse':pending(l)>0?'requisition':q(l.quantityReceived)>0?'received':'cancelled';
export const stateRank = l => ({warehouse:0,requisition:1,received:2,cancelled:3})[stateTone(l)];
export function stage(l) {
  if(warehouseReady(l))return 'En almacén · por recoger';
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


// Los importes se ordenan sólo dentro de una misma moneda. La comparación
// entre MXN y otras divisas sería incorrecta sin tipo de cambio.
const collate=(a,b)=>String(a||'').localeCompare(String(b||''),'es',{numeric:true,sensitivity:'base'});
const moneyCurrency=l=>String(l.currency||'MXN').toUpperCase();
const currencyOrder=(a,b)=>a===b?0:((a==='MXN'?-1:b==='MXN'?1:0)||collate(a,b));
const fallback=(a,b)=>collate(a.nombre,b.nombre)||collate(a.sku,b.sku)||collate(a.requestFolio,b.requestFolio);
export function sortRequisitionLines(lines, mode='folio') {
  return [...lines].sort((a,b)=>{
    if(mode==='estado')return stateRank(a)-stateRank(b)||fallback(a,b);
    if(mode==='nombre')return fallback(a,b);
    if(mode==='gasto_desc'||mode==='gasto_asc'){
      const currency=currencyOrder(moneyCurrency(a),moneyCurrency(b));
      if(currency)return currency;
      const difference=amounts(a).spent-amounts(b).spent;
      return (mode==='gasto_desc'?-difference:difference)||fallback(a,b);
    }
    return collate(a.sku,b.sku)||fallback(a,b);
  });
}
export function sortRequisitionGroups(groups,mode='folio') {
  const out=groups.map(g=>({...g,lines:sortRequisitionLines(g.lines,mode)}));
  const groupCurrency=g=>[...g.currencies.keys()].sort(currencyOrder)[0]||'MXN';
  const groupSpent=g=>n(g.currencies.get(groupCurrency(g))?.spent);
  const groupName=g=>[...g.lines].map(l=>String(l.nombre||'')).sort(collate)[0]||'';
  const byFolio=(a,b)=>Number(a.unassigned)-Number(b.unassigned)||collate(a.folio,b.folio)||collate(a.key,b.key);
  return out.sort((a,b)=>{
    if(mode==='estado')return Math.min(...a.lines.map(stateRank))-Math.min(...b.lines.map(stateRank))||byFolio(a,b);
    if(mode==='nombre')return collate(groupName(a),groupName(b))||byFolio(a,b);
    if(mode==='gasto_desc'||mode==='gasto_asc'){
      const c=currencyOrder(groupCurrency(a),groupCurrency(b));
      if(c)return c;
      const delta=groupSpent(a)-groupSpent(b);
      return (mode==='gasto_desc'?-delta:delta)||byFolio(a,b);
    }
    return byFolio(a,b);
  });
}
