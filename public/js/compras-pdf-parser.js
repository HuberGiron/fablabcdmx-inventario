/** Parser de los reportes institucionales "Requisición de Material".
 * Lectura determinista por columnas y bloques, calibrada con diez PDF
 * reales de octubre de 2026. No escribe ni infiere entregas físicas.
 */
const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export const normalizeProduct = norm;
const number = s => {
 const v=String(s??'').replace(/x$/i,'').replace(/[^\d.,\-]/g,'').replace(/,/g,'');
 if(!v)return null;const n=Number(v);return Number.isFinite(n)?n:null;
};
function clusterLines(items){
 const arr=(items||[]).filter(t=>String(t.str||'').trim()&&Number.isFinite(t.y)&&Number.isFinite(t.x))
  .map(t=>({...t,str:String(t.str).trim()})).sort((a,b)=>a.page-b.page||a.y-b.y||a.x-b.x);
 const lines=[];
 for(const item of arr){let last=lines[lines.length-1];if(!last||last.page!==item.page||Math.abs(last.y-item.y)>2.6){last={page:item.page,y:item.y,tokens:[]};lines.push(last);}last.tokens.push(item);}
 for(const l of lines){l.tokens.sort((a,b)=>a.x-b.x);l.text=l.tokens.map(x=>x.str).join(' ').replace(/\s+/g,' ').trim();}
 return lines;
}
const inRange=(line,min,max)=>line.tokens.filter(t=>t.x>=min&&t.x<max).map(t=>t.str).join(' ').replace(/\s+/g,' ').trim();
const moneyRange=(line,min,max)=>{
 const t=line.tokens.filter(t=>t.x>=min&&t.x<max).find(t=>/\d/.test(t.str));return t?number(t.str):null;
};
function dateISO(str){const m=String(str).match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
 if(!m)return '';const d=+m[1],mo=+m[2];return d>=1&&d<=31&&mo>=1&&mo<=12?`${m[3]}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`:'';
}
function parseMoneyBand(line){
 // PDF.js agrupa a veces «1 PZA» en un único fragmento; no se puede depender
 // de que cantidad y unidad sean tokens independientes del texto.
 const unitIndex=line.tokens.findIndex(t=>/^(?:PZA|PZAS|CAJA|CAJAS|PAQ|PAQUETE|JGO|JUEGO|LT|LTS|ROLLO|METRO|MTS)$/i.test(t.str));
 const combined=line.text.match(/\b(\d+(?:[.,]\d+)?)\s+(PZA|PZAS|CAJA|CAJAS|PAQ|PAQUETE|JGO|JUEGO|LT|LTS|ROLLO|METRO|MTS)\b/i);
 const quantity=unitIndex>0?number(line.tokens[unitIndex-1].str):combined?number(combined[1]):null;
 const unit=line.tokens[unitIndex]?.str||combined?.[2]||'';
 const currencyText=inRange(line,218,265);
 const currency=/\b(?:DLLS|USD|DOLARES)\b/i.test(currencyText+' '+line.text)?'USD':'MXN';
 const values=[...line.text.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)].map(m=>number(m[1]));
 const validBand=values.length>=4;
 return {
  quantity,unit,
  unitPrice:validBand?values[0]:moneyRange(line,162,220),
  exchangeRate:validBand?values[1]:null,
  vatTotal:validBand?values[2]:moneyRange(line,294,340),
  totalWithTax:validBand?values[3]:moneyRange(line,340,410),
  currency,expectedDate:dateISO(line.text),
 };
}
const STATUSES=[
 ['Entregado Parcial al Usuario',/entregado\s+parcial\s+al\s+usuario/i],
 ['Entregado al Usuario',/entregado\s+al\s+usuario/i],
 ['En Almacén',/en\s+almac[eé]n/i],
 ['Por Surtir',/por\s+surtir/i],
 ['Cotizado',/\bcotizad[oa]s?\b/i],
 ['Firma Electrónica',/firma\s+electr[oó]nica/i],
 ['No Generada',/no\s+generada/i],
 ['Generada',/\bgenerada\b/i],
];
function parseRawItem(segment,record,notes){
 const desc=[];let status='',order='',estimated=null,quoted=null;
 for(const line of segment){
  const description=inRange(line,38,149),label=inRange(line,38,113);
  if(!/\bActividad aprobada\b|^\s*Total Real\b/i.test(line.text)&&!/^(?:Estimado\s*:|Real\s*$|ver\s+archivo)/i.test(label)){
   // Extraer únicamente la columna de descripción, nunca costos ni estado.
   const cleaned=description.replace(/\(\s*\d{5,9}\s*\)/g,'').replace(/\bver archivo\b/gi,'')
    .replace(/^\d{1,3}\s+/,'').replace(/\s+\d{1,3}$/,'').trim();
   if(cleaned&&!/^\d{1,3}$|^\(?\d{5,9}\)?$|^#$/i.test(cleaned) && !/^Requisici[oó]n de Material/i.test(line.text)) desc.push(cleaned);
  }
  const statusArea=inRange(line,265,411);
  for(const [label,re] of STATUSES)if(re.test(statusArea)){status=label;break;}
  const m=line.text.match(/Orden\s+compra\s+(\d+)/i);if(m)order=m[1];
  if(/^Estimado\s*:/i.test(label))estimated=parseMoneyBand(line);
  if(/^Real\s*$/i.test(label))quoted=parseMoneyBand(line);
 }
 const description=desc.join(' ').replace(/\s+/g,' ').trim();
 if(!description)notes.push(`Descripción ausente del producto ${record.externalCode}.`);
 if(!estimated&&!quoted)notes.push(`Producto ${record.externalCode}: sin importe legible.`);
 if(!status)notes.push(`Producto ${record.externalCode}: estado institucional no reconocido.`);
 return {...record,description,externalStatus:status||'Sin estado legible',purchaseOrder:order,estimated,quoted,
  expectedDate:quoted?.expectedDate||estimated?.expectedDate||'',quantity:quoted?.quantity??estimated?.quantity??null,
  purchaseUnit:quoted?.unit||estimated?.unit||'',
 };
}
export function parseProcurementReport(pages){
 const notes=[],all=[];
 const lines=clusterLines((pages||[]).flatMap((p,i)=>(p.items||[]).map(t=>({page:i+1,x:t.x,y:t.y,str:t.str}))));
 const full=lines.map(l=>l.text).join('\n');
 const folio=full.match(/Folio\s*:\s*(\d{4,12})/i)?.[1]||'';
 const observations=full.match(/Observaciones\s*:\s*([^\n]+)/i)?.[1]?.trim()||'';
 // Fecha impresa al pie de página (no confundir con fecha prometida de entrega).
 const footer=lines.filter(l=>/\b\d+\s+de\s+\d+\b/i.test(l.text)&&/\d{1,2}\/\d{1,2}\/20\d{2}/.test(l.text)).at(-1);
 const reportDate=footer?dateISO(footer.text):'';
 if(!folio)notes.push('Folio de requisición no identificado.');
 let current=null,segment=[];
 const finalize=()=>{if(current)all.push(parseRawItem(segment,current,notes));};
 for(const line of lines){
  // Los PDF comparten columna descriptiva en x≈54–69, pero cambian
  // márgenes; los códigos se fragmentan como "(245611" y ")".
  const left=inRange(line,38,151);
  const match=left.match(/\(\s*(\d{5,9})\s*\)/);
  const isCode=!!match&&line.tokens.some(t=>t.x>=38&&t.x<=100&&/\(\s*\d{5,9}/.test(t.str));
  if(isCode){finalize();current={folio,observations,externalCode:match[1],sourcePage:line.page,ordinal:all.length+1};segment=[line];}
  else if(current&&!/^Requisici[oó]n de Material/i.test(line.text)&&!/\bTotal\s+Real\s+\$/i.test(line.text)&&!/El rengl[oó]n en rojo/i.test(line.text))segment.push(line);
 }
 finalize();
 if(!all.length)notes.push('Sin productos detectados: verifica que el PDF tenga texto seleccionable y utilice el formato de Requisición de Material.');
 const codes=new Set();for(const p of all){if(codes.has(p.externalCode))notes.push(`Código externo repetido: ${p.externalCode}`);codes.add(p.externalCode);}
 return {folio,observations,products:all,notes,pageCount:pages.length,reportDate,recognized:!!folio&&all.length>0};
}
const STOPWORDS=new Set(['de','del','la','el','para','con','los','las','y','en','un','una','pieza','pcs','pza','form','forma','lt','lts']);
function tokens(s){return norm(s).split(' ').filter(w=>w.length>1&&!STOPWORDS.has(w));}
export function matchingScore(product,line){
 const code=String(product.externalCode||'').trim();if(code&&String(line.externalProcurementItemCode||'').trim()===code)return 1;
 const L=new Set(tokens(product.description)),R=new Set(tokens(`${line.nombre||''} ${line.descripcion||''}`));if(!L.size||!R.size)return 0;
 let intersection=0;for(const t of L)if(R.has(t))intersection++;
 const containment=intersection/Math.max(1,Math.min(L.size,R.size));const jaccard=intersection/(L.size+R.size-intersection);
 const phrase=norm(line.nombre||''),exact=phrase&&(norm(product.description).includes(phrase)||phrase.includes(norm(product.description)))?.18:0;
 let score=Math.min(.97,.48*containment+.42*jaccard+exact);
 if(Number(product.quantity)>0&&Number(product.quantity)===Number(line.quantityRequested))score+=.06;
 if(product.folio&&String(line.requisitionNumber||'')===product.folio)score+=.09;
 return Math.min(.99,score);
}
export function suggestMatches(products,lines){
 const claimed=new Set();return products.map(p=>{
  const ranked=lines.map(l=>({...l,score:matchingScore(p,l)})).sort((a,b)=>b.score-a.score).slice(0,8);
  const first=ranked[0],second=ranked[1],auto=!!first&&first.score>=.83&&(!second||first.score-second.score>=.095)&&!claimed.has(`${first.requestId}::${first.id}`);
  if(auto)claimed.add(`${first.requestId}::${first.id}`);
  return {product:p,options:ranked,suggested:auto?`${first.requestId}::${first.id}`:'',confidence:first?.score||0,ambiguous:!auto};
 });
}
export function externalStage(status){
 const v=norm(status);
 if(/entregado parcial al usuario/.test(v))return 'partial';
 if(/entregado al usuario/.test(v))return 'received';
 if(/en almacen|entregado al almacen/.test(v))return 'warehouse';
 if(/(?:no )?generada|firma electronica|por surtir|cotiz|pendiente|autorizado|requisicion/.test(v))return 'requisition';
 return 'unknown';
}
export function institutionalRank(status){
 const v=norm(status);
 if(/no generada/.test(v))return 0;
 if(/^generada$/.test(v))return 0.5;
 if(/firma electronica/.test(v))return 1;
 if(/cotizad/.test(v))return 1.5;
 if(/por surtir/.test(v))return 2;
 if(/en almacen/.test(v))return 3;
 if(/entregado parcial/.test(v))return 4;
 if(/entregado al usuario/.test(v))return 5;
 return -1;
}

/** Analiza importes externos sin escribir en Firestore. Los precios MXN se
 * obtienen del TOTAL institucional con IVA dividido entre la cantidad;
 * la factura en USD se convierte sólo si el TC y la aritmética coinciden.
 * La referencia se usa para detectar anomalías; jamás para suponer otro TC.
 */
export function assessQuoteMXN(product, referenceUnitPrice = null) {
 const q=product?.quoted;
 const fail=(reason, extra={})=>({safe:false,unitGrossMXN:null,reason,currency:String(q?.currency||'MXN').toUpperCase(),...extra});
 if(!q)return fail('El reporte sólo tiene un precio estimado; todavía no hay cotización final.');
 const currency=String(q.currency||'MXN').toUpperCase();
 if(!['MXN','USD'].includes(currency))return fail(`Moneda ${currency} no compatible con la conversión automática.`);
 const fx=currency==='USD'?Number(q.exchangeRate):1;
 if(!Number.isFinite(fx)||fx<=0||(currency==='USD'&&(fx<5||fx>50)))
  return fail('Cotización USD sin un tipo de cambio MXN/USD plausible y verificable.');
 const qty=Number(q.quantity??product.quantity);
 if(!Number.isInteger(qty)||qty<=0)return fail('La cantidad institucional no es legible; no se puede calcular precio por unidad.');
 const rawUnit=Number(q.unitPrice);
 if(!Number.isFinite(rawUnit)||rawUnit<0)return fail('El precio unitario cotizado no es legible.');
 const iva=Number.isFinite(q.vatTotal)&&q.vatTotal>=0?q.vatTotal:rawUnit*.16;
 const calculatedTotal=(rawUnit+iva)*fx*qty;
 const printedTotal=q.totalWithTax == null?null:Number(q.totalWithTax);
 if(printedTotal!=null&&(!Number.isFinite(printedTotal)||printedTotal<0))return fail('El total convertido impreso no es válido.');
 // No aceptamos un total desconectado de la operación 16% / TC del reporte.
 if(printedTotal!=null){
  const tolerance=Math.max(10,calculatedTotal*.015);
  if(Math.abs(printedTotal-calculatedTotal)>tolerance)
   return fail(`El total institucional (${printedTotal.toFixed(2)} MXN) no coincide con cantidad, cotización, IVA y TC (${calculatedTotal.toFixed(2)} MXN).`,{exchangeRate:fx,printedTotal});
 }
 const totalMXN=printedTotal??calculatedTotal;
 const unitGrossMXN=Math.round(totalMXN/qty*100)/100;
 if(!Number.isFinite(unitGrossMXN)||unitGrossMXN<0)return fail('Precio convertido inválido.');
 const candidates=[];
 const est=product?.estimated;
 if(est?.totalWithTax!=null&&Number(est.quantity)>0&&String(est.currency||'MXN').toUpperCase()==='MXN')
  candidates.push({name:'estimado del PDF',unit:Number(est.totalWithTax)/Number(est.quantity)});
 if(Number(referenceUnitPrice)>0)candidates.push({name:'precio de la SC FabLab',unit:Number(referenceUnitPrice)});
 const wildlyDifferent=candidates.find(ref=>Number.isFinite(ref.unit)&&ref.unit>0&&
  Math.abs(unitGrossMXN-ref.unit)>5000 && (unitGrossMXN/ref.unit>3 || unitGrossMXN/ref.unit<.05));
 if(wildlyDifferent)return fail(`Precio atípico: ${unitGrossMXN.toFixed(2)} MXN/unidad frente a ${wildlyDifferent.unit.toFixed(2)} MXN del ${wildlyDifferent.name}; no actualizar automáticamente.`,{unitGrossMXN,exchangeRate:fx,printedTotal,flag:'outlier'});
 if(unitGrossMXN>10_000_000)return fail('Cotización superior a $10,000,000 MXN por unidad; requiere revisión externa.',{unitGrossMXN,exchangeRate:fx,printedTotal,flag:'outlier'});
 return {safe:true,unitGrossMXN,reason:'',currency,exchangeRate:fx,printedTotal,totalMXN,quantity:qty,vatCalculated:!(Number.isFinite(q.vatTotal)&&q.vatTotal>=0)};
}
