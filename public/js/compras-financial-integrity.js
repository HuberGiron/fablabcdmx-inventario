import { auth, db } from "./firebase-app.js";
import { waitForUser, getUserProfile } from "./common.js";
import {
  collection, doc, getDoc, getDocs, getDocsFromServer,
  runTransaction, updateDoc, serverTimestamp, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {amount, qty, pending, totals, sumLines, money, eventYear, requestYear, spendingByYear} from "./compras-financial-ledger.js";

/* Control de integridad. Las SC y sus renglones se conservan; las cantidades
   no recibidas se CANCELAN (no se borran). Cada recepción nueva es un evento.
   Las escrituras que afectan cantidades/stock/costos son transaccionales. */
let role = "";
let busy = false;
let detailId = "";
let unsubscribeLines = null;
let initialLineSnapshot = false;
let budgetRendering = false;
const format = (v, currency="MXN") => { try { return money(v,currency); } catch { return `${currency} ${amount(v).toFixed(2)}`; } };
const escapeHtml = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const nowIso = () => new Date().toISOString();
const refList = (source, field) => (Array.isArray(source)?source:[]).map(x=>({...x,requestId:String(x?.requestId||""),lineId:String(x?.lineId||x?.itemId||""),[field]:Math.max(0,amount(x?.[field]))})).filter(x=>x.requestId&&x.lineId&&x[field]>0);
const uuid = () => crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const lineRef = (requestId,id) => doc(db,"purchaseRequests",requestId,"items",id);
const linesCollection = requestId => collection(db,"purchaseRequests",requestId,"items");
const activeRequestId = () => String(document.querySelector("#purchaseRequestDetailPdf")?.dataset.requestId || detailId || "");
async function freshLines(requestId) {
  try { const s=await getDocsFromServer(linesCollection(requestId)); return s.docs.map(d=>({id:d.id,...d.data()})); }
  catch { const s=await getDocs(linesCollection(requestId)); return s.docs.map(d=>({id:d.id,...d.data()})); }
}
function requestSelector(requestId) {
  return [...document.querySelectorAll(".request-history-view")].find(b => b.dataset.requestId===requestId);
}
async function reload(requestId) {
  document.querySelector("#refreshPurchaseRequests")?.click();
  if(document.querySelector("#purchaseBudgetsPanel.show")) document.querySelector("#refreshPurchaseBudgets")?.click();
  try { await window.__purchaseCatalog?.refreshItemsFromServer?.(); } catch(e){console.warn("Recarga de catálogo pendiente",e);}
  if(requestId && document.querySelector("#purchaseRequestDetailModal.show")) requestSelector(requestId)?.click();
  document.dispatchEvent(new CustomEvent("purchase:finance-reconciled",{detail:{requestId}}));
}
async function refreshRequestTotals(requestId) {
  const lines = await freshLines(requestId);
  const sums = sumLines(lines);
  const oldTotals={}, currentTotals={},spentTotals={},pendingTotals={};
  for(const [currency, v] of sums) {
    oldTotals[currency]=lines.filter(x=>(x.currency||"MXN").toUpperCase()===currency)
      .reduce((s,x)=>s+qty(x.quantityRequested)*amount(x.unitPrice),0);
    currentTotals[currency]=v.active;spentTotals[currency]=v.spent;pendingTotals[currency]=v.commitment;
  }
  const p=lines.reduce((s,l)=>s+pending(l),0), r=lines.reduce((s,l)=>s+qty(l.quantityReceived),0), c=lines.reduce((s,l)=>s+qty(l.quantityCancelled),0);
  const status=p>0?(r||c?"partial":"sent"):(r>0?"completed":"cancelled");
  await updateDoc(doc(db,"purchaseRequests",requestId), {
    status, itemCount:lines.length, totalQty:lines.reduce((s,x)=>s+qty(x.quantityRequested),0),
    totalsByCurrency:oldTotals, currentTotalsByCurrency:currentTotals,
    spentTotalsByCurrency:spentTotals, pendingTotalsByCurrency:pendingTotals,
    updatedAt:serverTimestamp()
  });
}
function trimRefs(item, reqId, itemId, key, delta) {
  const refs=refList(item[key==="pendingQty"?"purchasePendingRefs":"purchaseRequisitionRefs"],key);
  let matched=0;
  const next=refs.map(x=>{
    if(x.requestId!==reqId || x.lineId!==itemId)return x;
    matched++;
    return {...x,[key]:Math.max(0,x[key]-delta)};
  }).filter(x=>x[key]>0);
  if(matched!==1)throw new Error(`Referencias inconsistentes para ${itemId} (${key}). No se realizaron cambios.`);
  return next;
}

async function cancelPending(requestId, lineId, quantity) {
  const want=qty(quantity);
  if(want!==Number(quantity)||want<=0) throw new Error("La cantidad cancelada debe ser un entero positivo.");
  await runTransaction(db, async tx=>{
    const lr=lineRef(requestId,lineId), rr=doc(db,"purchaseRequests",requestId);
    const lineSnap=await tx.get(lr), requestSnap=await tx.get(rr);
    if(!lineSnap.exists()||!requestSnap.exists()||requestSnap.data().status==="draft")throw new Error("Solicitud no válida.");
    const l=lineSnap.data(), remain=pending(l);
    if(want>remain)throw new Error(`Sólo ${remain} unidades continúan pendientes.`);
    const itemId=String(l.itemId||lineId),ir=doc(db,"items",itemId),is=await tx.get(ir);
    if(!is.exists())throw new Error("El SKU asociado no existe.");
    const item=is.data();
    const pref=trimRefs(item,requestId,itemId,"pendingQty",want);
    const patch={purchasePendingRefs:pref,purchasePendingQty:pref.reduce((s,x)=>s+x.pendingQty,0),updatedAt:serverTimestamp()};
    if(l.requisitionStatus==="requisitioned"){
      const rref=trimRefs(item,requestId,itemId,"requisitionQty",want);
      patch.purchaseRequisitionRefs=rref;
      patch.purchaseRequisitionQty=rref.reduce((s,x)=>s+x.requisitionQty,0);
    }
    const nextPending=remain-want;
    const historical=Array.isArray(l.cancellationHistory)?l.cancellationHistory:[];
    tx.update(ir,patch);
    tx.update(lr,{
      quantityCancelled:qty(l.quantityCancelled)+want,
      status:nextPending>0?"partial":(qty(l.quantityReceived)>0?"received":"cancelled"),
      lastCancelledAt:serverTimestamp(), updatedAt:serverTimestamp(),
      cancellationHistory:[...historical,{id:uuid(),at:nowIso(),quantity:want,
        unitCost:amount(l.requisitionStatus==="requisitioned" ? l.requisitionUnitCost??l.unitPrice : l.unitPrice),
        userId:auth.currentUser?.uid||"",stage:l.requisitionStatus==="requisitioned"?"requisition":"compras"}]
    });
    tx.update(rr,{updatedAt:serverTimestamp()});
  });
}
async function registerReceipt(requestId,lineId,quantity,unitCost) {
  const want=qty(quantity), cost=Number(unitCost);
  if(want!==Number(quantity)||want<=0||!Number.isFinite(cost)||cost<0) throw new Error("Cantidad o costo inválidos.");
  await runTransaction(db,async tx=>{
    const lr=lineRef(requestId,lineId),rr=doc(db,"purchaseRequests",requestId);
    const ls=await tx.get(lr),rs=await tx.get(rr);
    if(!ls.exists()||!rs.exists()||rs.data().status==="draft")throw new Error("Solicitud no enviada.");
    const l=ls.data(), remain=pending(l);
    if(l.requisitionStatus!=="requisitioned"||want>remain)throw new Error("Se requiere una requisición vigente y cantidades pendientes suficientes.");
    const itemId=String(l.itemId||lineId),ir=doc(db,"items",itemId),is=await tx.get(ir);
    if(!is.exists())throw new Error("Producto no encontrado.");
    const item=is.data();
    const pref=trimRefs(item,requestId,itemId,"pendingQty",want);
    const rref=trimRefs(item,requestId,itemId,"requisitionQty",want);
    const lastQty=qty(l.quantityReceived),newQty=lastQty+want;
    const originalActual=Object.hasOwn(l,"actualCostTotal")?amount(l.actualCostTotal):lastQty*amount(l.lastActualUnitCost??l.unitPrice);
    const history=Array.isArray(l.receiptHistory)?l.receiptHistory:[];
    const newHistory=[...history,{id:uuid(),at:nowIso(),quantity:want,unitCost:cost,
      currency:String(l.currency||"MXN").toUpperCase(),userId:auth.currentUser?.uid||"",source:"compras"}];
    tx.update(ir,{
      purchasePendingRefs:pref,purchasePendingQty:pref.reduce((s,x)=>s+x.pendingQty,0),
      purchaseRequisitionRefs:rref,purchaseRequisitionQty:rref.reduce((s,x)=>s+x.requisitionQty,0),
      stockAlmacen:amount(item.stockAlmacen)+want,
      precioUnitario:cost, moneda:l.currency||item.moneda||"MXN",
      lastPurchaseUnitCost:cost,lastPurchaseCostUpdatedAt:serverTimestamp(),financePriceSourceMillis:Date.now(),updatedAt:serverTimestamp()
    });
    tx.update(lr,{
      quantityReceived:newQty,status:remain-want>0?"partial":"received",
      actualCostTotal:originalActual+want*cost,receiptHistory:newHistory,
      lastActualUnitCost:cost,lastActualCostAt:serverTimestamp(),lastReceivedAt:serverTimestamp(),updatedAt:serverTimestamp()
    });
    tx.update(rr,{updatedAt:serverTimestamp()});
  });
}
// Recepción individual: el formulario original guardaba el total sin receiptHistory.
// Esta versión utiliza el mismo motor transaccional que la recepción masiva.
function individualReceiptDialog() {
  let modal=document.getElementById("financeIndividualReceiptModal");
  if(modal)return modal;
  modal=document.createElement("div");modal.id="financeIndividualReceiptModal";modal.className="modal fade";modal.tabIndex=-1;
  modal.innerHTML=`<div class="modal-dialog"><div class="modal-content">
    <div class="modal-header"><h5 class="modal-title">Registrar recepción y gasto real</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button></div>
    <div class="modal-body"><div class="mb-2" id="financeIndividualReceiptName"></div>
      <label class="form-label" for="financeIndividualReceiptQty">Piezas recibidas</label>
      <input id="financeIndividualReceiptQty" type="number" class="form-control mb-3" min="1" step="1">
      <label class="form-label" for="financeIndividualReceiptCost">Costo unitario real de esta recepción</label>
      <input id="financeIndividualReceiptCost" type="number" class="form-control" min="0" step="0.01">
      <div class="small text-muted mt-2">Se actualizarán inventario, gasto real y presupuesto. Se conservará el costo de esta recepción para futuras correcciones.</div>
    </div><div class="modal-footer"><button class="btn btn-secondary" data-bs-dismiss="modal">Cerrar</button>
      <button id="financeIndividualReceiptSave" class="btn btn-success" type="button">Registrar recepción</button></div>
  </div></div>`;
  document.body.append(modal);
  modal.querySelector("#financeIndividualReceiptSave").addEventListener("click",async()=>{
    if(busy)return;
    const rid=modal.dataset.requestId,lid=modal.dataset.lineId;
    const quantity=Number(modal.querySelector("#financeIndividualReceiptQty").value);
    const unitCost=Number(modal.querySelector("#financeIndividualReceiptCost").value);
    if(!Number.isSafeInteger(quantity)||quantity<1||quantity>Number(modal.dataset.pending)||!Number.isFinite(unitCost)||unitCost<0){
      alert("Captura una cantidad entera entre 1 y el pendiente, y un costo no negativo.");return;
    }
    if(!confirm(`¿Registrar la recepción de ${quantity} pieza(s) a ${format(unitCost,modal.dataset.currency)} cada una?`))return;
    const button=modal.querySelector("#financeIndividualReceiptSave");busy=true;button.disabled=true;
    try{
      await registerReceipt(rid,lid,quantity,unitCost);
      await refreshRequestTotals(rid);
      bootstrap.Modal.getOrCreateInstance(modal).hide();
      await reload(rid);
      alert("Recepción registrada con historial y gasto real actualizado.");
    }catch(e){console.error(e);alert(`No fue posible guardar la recepción: ${e.message}`);}
    finally{busy=false;button.disabled=false;}
  });
  return modal;
}
async function openIndividualReceipt(requestId,lineId){
  if(role!=="admin"||busy)return;
  try{
    const snapshot=await getDoc(lineRef(requestId,lineId));
    if(!snapshot.exists())throw new Error("No se encontró el SKU solicitado.");
    const line=snapshot.data(),remain=pending(line);
    if(remain<1)throw new Error("El producto ya no tiene piezas pendientes.");
    if(line.requisitionStatus!=="requisitioned")throw new Error("Primero debe registrarse la requisición de este artículo.");
    const modal=individualReceiptDialog();
    modal.dataset.requestId=requestId;modal.dataset.lineId=lineId;
    modal.dataset.pending=String(remain);modal.dataset.currency=line.currency||"MXN";
    modal.querySelector("#financeIndividualReceiptName").textContent=`${line.sku||lineId} · ${line.nombre||"Artículo"} · Pendiente: ${remain}`;
    const input=modal.querySelector("#financeIndividualReceiptQty");input.max=String(remain);input.value=String(remain);
    modal.querySelector("#financeIndividualReceiptCost").value=String(amount(line.lastActualUnitCost??line.requisitionUnitCost??line.unitPrice));
    const detail=document.querySelector("#purchaseRequestDetailModal");
    if(detail?.classList.contains("show")){
      detail.addEventListener("hidden.bs.modal",()=>bootstrap.Modal.getOrCreateInstance(modal).show(),{once:true});
      bootstrap.Modal.getOrCreateInstance(detail).hide();
    }else bootstrap.Modal.getOrCreateInstance(modal).show();
  }catch(e){alert(`No se pudo abrir la recepción: ${e.message}`);}
}

async function saveOfficialPrices() {
  if(busy || role!=="admin")return;
  const modal=document.getElementById("purchaseRequestPriceModal");
  const requestId=String(modal?.dataset.requestId||"");
  if(!requestId){alert("No se pudo identificar la SC.");return;}
  let changes=[];
  try {
    changes=[...modal.querySelectorAll(".request-price-row")].filter(row=>{
      const check=row.querySelector(".request-price-select");return check?.checked||check?.disabled;
    }).map(row=>{
      const price=Number(row.querySelector(".request-price-input")?.value);
      if(!row.dataset.lineId||!Number.isFinite(price)||price<0)throw new Error("Datos de precio inválidos.");
      return {id:String(row.dataset.lineId),price};
    });
  }catch(e){alert(e.message);return;}
  if(!changes.length){alert("Selecciona al menos un SKU.");return;}
  if(changes.length>200){alert("Máximo 200 cambios por operación para conservar atomicidad. Divide la selección.");return;}
  if(!confirm(`¿Actualizar ${changes.length} precios en la SC y el catálogo? El costo de recepciones anteriores no cambiará.`))return;
  busy=true;
  const btn=modal.querySelector("#requestPriceModalSave");if(btn)btn.disabled=true;
  const uid=auth.currentUser?.uid||"", stamp=Date.now();
  try {
    await runTransaction(db,async tx=>{
      const records=[];
      for(const c of changes){
        const ref=lineRef(requestId,c.id),snap=await tx.get(ref);
        if(!snap.exists())throw new Error(`No se encontró el renglón ${c.id}.`);
        const l=snap.data(), itemRef=doc(db,"items",String(l.itemId||c.id)),itemSnap=await tx.get(itemRef);
        if(!itemSnap.exists())throw new Error(`No se encontró el producto ${c.id}.`);
        records.push({c,l,ref,itemRef,item:itemSnap.data()});
      }
      for(const {c,l,ref,itemRef,item} of records){
        const patch={unitPrice:c.price,priceChangedAt:serverTimestamp(),priceChangedBy:uid,updatedAt:serverTimestamp()};
        if(!Object.hasOwn(l,"originalUnitPrice"))patch.originalUnitPrice=amount(l.unitPrice);
        if(l.requisitionStatus==="requisitioned")patch.requisitionUnitCost=c.price;
        tx.update(ref,patch);
        tx.update(itemRef,{precioUnitario:c.price,moneda:l.currency||item.moneda||"MXN",
          financePriceSourceMillis:stamp,updatedAt:serverTimestamp()});
      }
    });
    await refreshRequestTotals(requestId);
    bootstrap.Modal.getOrCreateInstance(modal).hide();
    await reload(requestId);
    alert(`${changes.length} precios confirmados y sincronizados con inventario.`);
  }catch(e){console.error(e);alert(`No fue posible guardar precios: ${e.message}`);}finally{busy=false;if(btn)btn.disabled=false;}
}
function ensureCancelDialog(){
  let m=document.getElementById("financeCancelModal");if(m)return m;
  m=document.createElement("div");m.id="financeCancelModal";m.className="modal fade";m.tabIndex=-1;
  m.innerHTML=`<div class="modal-dialog modal-xl modal-dialog-scrollable"><div class="modal-content">
    <div class="modal-header"><div><h5 class="modal-title">Cancelar cantidades pendientes</h5><div class="small text-muted">Se liberará exclusivamente el compromiso de las unidades canceladas; ningún producto recibido será descontado.</div></div><button class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body"><div class="d-flex gap-2 mb-2"><input class="form-control" id="financeCancelSearch" placeholder="Buscar por SKU o nombre"><button class="btn btn-outline-secondary text-nowrap" id="financeCancelAll" type="button">Seleccionar todos</button><button class="btn btn-outline-secondary text-nowrap" id="financeCancelNone" type="button">Deseleccionar</button></div>
    <div class="table-responsive"><table class="table table-sm align-middle"><thead><tr><th></th><th>Artículo</th><th>Etapa</th><th>Pendiente</th><th>Cantidad a cancelar</th><th>Compromiso a liberar</th></tr></thead><tbody id="financeCancelRows"></tbody></table></div><p id="financeCancelSummary" class="small fw-semibold"></p></div>
    <div class="modal-footer"><button class="btn btn-outline-secondary" data-bs-dismiss="modal">Cerrar</button><button class="btn btn-danger" id="financeCancelSave">Cancelar seleccionados y liberar presupuesto</button></div>
    </div></div>`;
  document.body.append(m);
  const recalc=()=>{
    let total=0, count=0;
    m.querySelectorAll(".finance-cancel-row").forEach(row=>{
      const checked=row.querySelector(".finance-check").checked;
      const number=Number(row.querySelector(".finance-count").value);
      if(checked&&Number.isSafeInteger(number)&&number>0&&number<=Number(row.dataset.max)){
        const v=number*Number(row.dataset.unit);total+=v;count++;
        row.querySelector(".finance-subtotal").textContent=format(v,row.dataset.currency);
      }else row.querySelector(".finance-subtotal").textContent="—";
    });
    m.querySelector("#financeCancelSummary").textContent=`${count} renglones seleccionados · Compromiso MXN a liberar (sin divisas): ${format([...m.querySelectorAll('.finance-cancel-row')].reduce((s,row)=>s+(row.dataset.currency==='MXN'&&row.querySelector('.finance-check').checked?qty(row.querySelector('.finance-count').value)*Number(row.dataset.unit):0),0))}`;
    m.querySelector("#financeCancelSave").disabled=busy||count===0;
  };
  m.addEventListener("input",e=>{if(e.target.id==="financeCancelSearch"){
    const q=e.target.value.toLocaleLowerCase("es-MX");m.querySelectorAll(".finance-cancel-row").forEach(row=>row.hidden=!row.dataset.search.includes(q));
  } else recalc();});
  m.addEventListener("change",recalc);
  m.querySelector("#financeCancelAll").addEventListener("click",()=>{m.querySelectorAll(".finance-cancel-row:not([hidden]) .finance-check").forEach(x=>x.checked=true);recalc();});
  m.querySelector("#financeCancelNone").addEventListener("click",()=>{m.querySelectorAll(".finance-check").forEach(x=>x.checked=false);recalc();});
  m.querySelector("#financeCancelSave").addEventListener("click",saveCancellations);
  return m;
}
async function openCancellation(requestId,onlyLineId="") {
  if(role!=="admin")return;
  if(!requestId){alert("No se identificó la solicitud.");return;}
  try{
    const lines=(await freshLines(requestId)).filter(l=>pending(l)>0 && (!onlyLineId||l.id===onlyLineId));
    if(!lines.length){alert("No existen cantidades pendientes para cancelar.");return;}
    const m=ensureCancelDialog();m.dataset.requestId=requestId;
    const rows=m.querySelector("#financeCancelRows");
    rows.innerHTML=lines.map(l=>{
      const f=totals(l),currency=f.currency,unit=f.commitment/f.pending;
      return `<tr class="finance-cancel-row" data-line-id="${escapeHtml(l.id)}" data-max="${f.pending}" data-unit="${unit}" data-currency="${escapeHtml(currency)}" data-search="${escapeHtml(`${l.sku} ${l.nombre}`.toLocaleLowerCase('es-MX'))}">
      <td><input type="checkbox" class="form-check-input finance-check" ${onlyLineId?"checked":""}></td><td><strong>${escapeHtml(l.sku)}</strong><div class="small">${escapeHtml(l.nombre)}</div></td><td>${l.requisitionStatus==="requisitioned"?"En requisición":"En compras"}</td>
      <td>${f.pending}</td><td><input type="number" class="form-control form-control-sm finance-count" value="${f.pending}" min="1" max="${f.pending}" step="1" style="min-width:95px"></td><td class="finance-subtotal">—</td></tr>`;
    }).join("");
    m.querySelector("#financeCancelSearch").value="";
    m.querySelector("#financeCancelSummary").textContent="Selecciona los renglones que deseas cancelar.";
    const detail=document.querySelector("#purchaseRequestDetailModal");
    if(detail?.classList.contains("show")){
      detail.addEventListener("hidden.bs.modal",()=>bootstrap.Modal.getOrCreateInstance(m).show(),{once:true});
      bootstrap.Modal.getOrCreateInstance(detail).hide();
    }else bootstrap.Modal.getOrCreateInstance(m).show();
    m.querySelector("#financeCancelSave").disabled=!onlyLineId;
    if(onlyLineId) m.querySelector(".finance-check")?.dispatchEvent(new Event("change",{bubbles:true}));
  }catch(e){console.error(e);alert(`No se pudo abrir la cancelación: ${e.message}`);}
}
async function saveCancellations() {
  if(busy)return;
  const m=ensureCancelDialog(),requestId=m.dataset.requestId;
  const selections=[...m.querySelectorAll(".finance-cancel-row")].filter(r=>r.querySelector(".finance-check").checked).map(r=>({
    id:r.dataset.lineId,quantity:Number(r.querySelector(".finance-count").value),max:Number(r.dataset.max)
  }));
  if(!selections.length)return;
  if(selections.some(s=>!Number.isSafeInteger(s.quantity)||s.quantity<=0||s.quantity>s.max)){alert("Corrige las cantidades antes de continuar.");return;}
  if(!confirm(`¿Cancelar ${selections.reduce((s,x)=>s+x.quantity,0)} piezas pendientes en ${selections.length} SKU?\n\nLa solicitud se conservará y el gasto recibido permanecerá intacto.`))return;
  busy=true;m.querySelector("#financeCancelSave").disabled=true;
  const errors=[];let done=0;
  try{
    for(const s of selections){try{await cancelPending(requestId,s.id,s.quantity);done++;}catch(e){errors.push(`${s.id}: ${e.message}`);}}
    if(done)await refreshRequestTotals(requestId);
    if(errors.length)alert(`${done} cancelaciones registradas y ${errors.length} fallidas:\n${errors.join("\n")}`);
    else {alert(`${done} artículos actualizados. Compromiso pendiente liberado.`);bootstrap.Modal.getOrCreateInstance(m).hide();}
    if(done)await reload(requestId);
  }catch(e){alert(`La operación se completó parcialmente: ${e.message}`);}finally{busy=false;m.querySelector("#financeCancelSave").disabled=false;}
}
async function saveReceiptsFromExisting(modal, mode) {
  if(busy)return;
  const requestId= mode==="mass"?(modal.dataset.requestId||activeRequestId()):modal.dataset.requestId;
  if(!requestId){alert("No se pudo identificar la solicitud. Abre de nuevo su detalle.");return;}
  const entries=mode==="mass"?[...modal.querySelectorAll(".mass-receipt-row")].filter(r=>r.querySelector(".mass-receipt-check")?.checked)
    :[...modal.querySelectorAll(".group-batch-row")].filter(r=>r.querySelector(".group-batch-select")?.checked);
  const chosen=[];
  for(const row of entries){
    const q=Number(row.querySelector(mode==="mass"?".mass-receipt-qty":".group-batch-quantity")?.value);
    const c=Number(row.querySelector(mode==="mass"?".mass-receipt-cost":".group-batch-unit-cost")?.value);
    if(!Number.isSafeInteger(q)||q<1||!Number.isFinite(c)||c<0){alert("Corrige cantidad y costo de cada selección.");return;}
    chosen.push({id:row.dataset.lineId,quantity:q,cost:c});
  }
  if(!chosen.length)return;
  if(!confirm(`¿Registrar ${chosen.reduce((s,x)=>s+x.quantity,0)} piezas recibidas en ${chosen.length} SKU? Se actualizarán costo real, catálogo y presupuesto.`))return;
  busy=true;const save=mode==="mass"?modal.querySelector("#massReceiptSave"):modal.querySelector("#purchaseGroupBatchSave");
  if(save)save.disabled=true;
  const errors=[];let done=0;
  try{
    for(const entry of chosen){try{await registerReceipt(requestId,entry.id,entry.quantity,entry.cost);done++;}catch(e){errors.push(`${entry.id}: ${e.message}`);}}
    if(done)await refreshRequestTotals(requestId);
    if(errors.length)alert(`${done} recepciones guardadas. Errores:\n${errors.join("\n")}`);
    else {alert(`${done} recepciones registradas y conciliadas.`);bootstrap.Modal.getOrCreateInstance(modal).hide();}
    if(done)await reload(requestId);
  }catch(e){alert(`Recepciones parcialmente guardadas: ${e.message}`);}finally{busy=false;if(save)save.disabled=false;}
}
function stopOriginal(e){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();}
function hideDeleteActions() {
  document.querySelectorAll("#purchaseRequestDelete, .request-history-delete").forEach(b=>{
    b.hidden=true;b.classList.add("d-none");b.setAttribute("aria-disabled","true");
  });
  const detail=document.querySelector("#purchaseRequestDetailModal .modal-footer");
  if(detail&&!detail.querySelector("#financeCancelDetail")){
    const b=document.createElement("button");b.id="financeCancelDetail";b.type="button";b.className="btn btn-outline-danger";
    b.textContent="Cancelar productos pendientes";detail.prepend(b);
  }
  const cancelAll=document.getElementById("purchaseRequestCancelAll");
  if(cancelAll && cancelAll.textContent!=="Cancelar pendientes (incluye requisiciones)")cancelAll.textContent="Cancelar pendientes (incluye requisiciones)";
}
let decorateQueued=false;
function queueDecorate(){if(decorateQueued)return;decorateQueued=true;requestAnimationFrame(()=>{decorateQueued=false;hideDeleteActions();});}

async function syncCatalogUnitCost(l,marker) {
  if(role!=="admin"||!l?.itemId)return;
  const ts=marker?.toMillis?.() ?? Date.parse(marker||"");if(!Number.isFinite(ts))return;
  const itemRef=doc(db,"items",String(l.itemId));
  await runTransaction(db,async tx=>{
    const snap=await tx.get(itemRef);
    if(!snap.exists())return;
    const item=snap.data();
    const last=Number(item.financePriceSourceMillis||0);
    if(ts<=last)return;
    const candidate=Number(l.requisitionStatus==="requisitioned"?(l.requisitionUnitCost??l.unitPrice):l.unitPrice);
    if(!Number.isFinite(candidate)||candidate<0)return;
    tx.update(itemRef,{precioUnitario:candidate,moneda:l.currency||item.moneda||"MXN",
      financePriceSourceMillis:ts,updatedAt:serverTimestamp()});
  });
  document.querySelector("#refreshPurchaseBudgets")?.click();
  try { await window.__purchaseCatalog?.refreshItemsFromServer?.(); } catch(e) { console.warn("El precio se guardó pero aún no se actualizó la tarjeta",e); }
}
function watchDetail(requestId) {
  if(!requestId||requestId===detailId)return;
  unsubscribeLines?.();unsubscribeLines=null;detailId=requestId;initialLineSnapshot=true;
  const priceMarkers=new Map();
  const stampMillis=marker=>{
    if(!marker)return 0;
    const n=marker?.toMillis?.() ?? Date.parse(marker);
    return Number.isFinite(n)?n:0;
  };
  const markerMillis=record=>Math.max(stampMillis(record.priceChangedAt),stampMillis(record.requisitionedAt));
  const latestMarker=record=>stampMillis(record.priceChangedAt)>=stampMillis(record.requisitionedAt)
    ? record.priceChangedAt : record.requisitionedAt;
  unsubscribeLines=onSnapshot(linesCollection(requestId),snap=>{
    if(initialLineSnapshot){
      initialLineSnapshot=false;
      snap.docs.forEach(d=>priceMarkers.set(d.id,markerMillis(d.data())));
      return;
    }
    for(const change of snap.docChanges()){
      const l=change.doc.data(),marker=markerMillis(l);
      const previous=priceMarkers.get(change.doc.id)||0;
      priceMarkers.set(change.doc.id,marker);
      // Sólo sincronizar catálogo cuando cambie REALMENTE el precio oficial.
      // Modificar gasto de una recepción antigua no debe alterar el precio actual.
      if(change.type==="modified" && marker>previous){
        syncCatalogUnitCost(l,latestMarker(l)).catch(console.warn);
      }
    }
    showDetailFinancials(requestId).catch(console.warn);
  },e=>console.warn("Escucha SC",e));
}
async function showDetailFinancials(requestId){
  const body=document.querySelector("#purchaseRequestDetailBody");if(!body||!requestId||requestId!==activeRequestId())return;
  const lines=await freshLines(requestId),sum=sumLines(lines);
  let box=body.querySelector("#financeDetailBreakdown");if(!box){box=document.createElement("section");box.id="financeDetailBreakdown";box.className="card border-secondary mb-3";body.prepend(box);}
  box.innerHTML=`<div class="card-body"><h3 class="h6 mb-2">Conciliación financiera vigente</h3><div class="small text-muted mb-2">El gasto ya recibido conserva su costo real; el pendiente utiliza el precio vigente. Lo cancelado no consume presupuesto.</div><div class="table-responsive"><table class="table table-sm mb-0"><thead><tr><th>Moneda</th><th>Estimado original</th><th>Gasto real recibido</th><th>Compromiso pendiente</th><th>Total vigente</th></tr></thead><tbody>${[...sum].map(([c,x])=>`<tr><td>${escapeHtml(c)}</td><td>${format(x.original,c)}</td><td>${format(x.spent,c)}</td><td>${format(x.commitment,c)}</td><td><strong>${format(x.active,c)}</strong></td></tr>`).join("")}</tbody></table></div><div class="d-flex gap-2 flex-wrap mt-3"><button type="button" class="btn btn-sm btn-outline-success" id="financeDetailXlsx" data-request-id="${escapeHtml(requestId)}">Excel financiero</button><button type="button" class="btn btn-sm btn-outline-dark" id="financeDetailPdf" data-request-id="${escapeHtml(requestId)}">PDF financiero</button></div></div>`;
}
async function exportFinancialRequest(requestId, mode) {
  const lines=await freshLines(requestId), sums=sumLines(lines);
  if(mode==="xlsx") {
    if(!window.XLSX){ alert("No está disponible el exportador de Excel."); return; }
    const X=window.XLSX, book=X.utils.book_new();
    const hdr=["SKU","Nombre","Zona","Solicitado","Recibido","Cancelado","Pendiente","Precio original","Precio vigente","Gasto real","Compromiso pendiente","Total vigente","Moneda"];
    const rows=lines.map(l=>{const t=totals(l);return [l.sku||"",l.nombre||"",l.zoneId||"",t.requested,t.received,t.cancelled,t.pending,
      amount(l.originalUnitPrice??l.unitPrice), t.pending? t.commitment/t.pending:amount(l.unitPrice),t.spent,t.commitment,t.active,t.currency];});
    const ws=X.utils.aoa_to_sheet([hdr,...rows]); ws["!cols"]=[{wch:16},{wch:40},{wch:10},...Array(9).fill({wch:17}),{wch:10}];
    X.utils.book_append_sheet(book,ws,"Conciliación");
    const events=[];
    for(const l of lines) {
      for(const r of (Array.isArray(l.receiptHistory)?l.receiptHistory:[]))events.push([l.sku||"",l.nombre||"",r.at||"",qty(r.quantity),amount(r.unitCost),qty(r.quantity)*amount(r.unitCost),r.currency||l.currency||"MXN",r.userId||""]);
    }
    X.utils.book_append_sheet(book,X.utils.aoa_to_sheet([["SKU","Nombre","Fecha recepción","Piezas","Costo unitario","Gasto","Moneda","Usuario"],...events]),"Recepciones");
    X.writeFile(book,`SC_${requestId}_conciliacion.xlsx`,{bookType:"xlsx",compression:true});
  } else {
    const popup=window.open("","_blank");if(!popup){alert("Habilita ventanas emergentes para generar el PDF.");return;}
    const cells=lines.map(l=>{const t=totals(l);return `<tr><td>${escapeHtml(l.sku)}</td><td>${escapeHtml(l.nombre)}</td><td>${t.requested}</td><td>${t.received}</td><td>${t.cancelled}</td><td>${format(t.spent,t.currency)}</td><td>${format(t.commitment,t.currency)}</td><td>${format(t.active,t.currency)}</td></tr>`;}).join("");
    const summary=[...sums].map(([c,t])=>`<p><strong>${escapeHtml(c)}</strong> · Gasto ${format(t.spent,c)} · Compromiso ${format(t.commitment,c)} · Vigente ${format(t.active,c)}</p>`).join("");
    popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Conciliación SC</title><style>body{font:12px Arial,sans-serif;padding:22px}h1{font-size:18px}table{width:100%;border-collapse:collapse}th,td{padding:7px 5px;border-bottom:1px solid #bbb;text-align:left}th{background:#eee}@page{size:landscape;margin:13mm}</style></head><body><h1>FabLab IBERO · Conciliación financiera de ${escapeHtml(requestId)}</h1>${summary}<table><thead><tr><th>SKU</th><th>Nombre</th><th>Solicitado</th><th>Recibido</th><th>Cancelado</th><th>Gasto real</th><th>Compromiso</th><th>Total vigente</th></tr></thead><tbody>${cells}</tbody></table><p><small>Lo cancelado no consume presupuesto. El gasto se calcula con el costo registrado de cada recepción.</small></p><script>window.onload=()=>window.print();<\/script></body></html>`);
    popup.document.close();
  }
}
async function drawFiscalLedger(){
  const panel=document.querySelector("#purchaseBudgetsPanelBody");if(!panel||budgetRendering)return;
  const year=Number(document.querySelector("#purchaseBudgetYear")?.value)||new Date().getFullYear();
  const existing=panel.querySelector("#financeFiscalLedger");if(existing?.dataset.year===String(year))return;
  budgetRendering=true;
  try{
    const rs=await getDocsFromServer(collection(db,"purchaseRequests")).catch(()=>getDocs(collection(db,"purchaseRequests")));
    const requests=rs.docs.map(d=>({id:d.id,...d.data()})).filter(r=>r.status!=="draft");
    const bud=await getDocsFromServer(collection(db,"purchaseBudgets")).catch(()=>getDocs(collection(db,"purchaseBudgets")));
    const rows=new Map(),getZone=id=>{if(!rows.has(id))rows.set(id,{zoneId:id,allocated:0,spent:0,committed:0,legacy:0});return rows.get(id);};
    for(const b of bud.docs){const v=b.data();if(Number(v.year)===year)getZone(String(v.zoneId)).allocated+=amount(v.allocatedAmount);}
    for(let i=0;i<requests.length;i+=6){
      const block=await Promise.all(requests.slice(i,i+6).map(async r=>({r,lines:await freshLines(r.id)})));
      for(const {r,lines} of block){for(const l of lines){if(String(l.currency||"MXN").toUpperCase()!=="MXN")continue;
        const id=String(l.zoneId||"sin-zona"),z=getZone(id),s=spendingByYear(l,requestYear(r));
        z.spent+=s.byYear.get(year)||0;
        if(s.legacyApprox&&s.byYear.has(year))z.legacy++;
        if(requestYear(r)===year)z.committed+=totals(l).commitment;
      }}
    }
    if(!document.body.contains(panel))return;
    panel.querySelector("#financeFiscalLedger")?.remove();
    const report=document.createElement("section");report.id="financeFiscalLedger";report.dataset.year=String(year);report.className="card border-secondary mt-3";
    const sums=[...rows.values()].reduce((a,v)=>({allocated:a.allocated+v.allocated,spent:a.spent+v.spent,committed:a.committed+v.committed,legacy:a.legacy+v.legacy}),{allocated:0,spent:0,committed:0,legacy:0});
    report.innerHTML=`<div class="card-body"><h3 class="h6">Conciliación por ejercicio ${year}</h3><p class="small text-muted">El gasto real se asigna al año de la recepción registrada; el compromiso pendiente al año de envío de la SC. Reporte de control adicional, independiente del resumen histórico de la interfaz.</p>
    <div class="d-flex gap-3 flex-wrap mb-2"><strong>Asignado: ${format(sums.allocated)}</strong><strong>Ejercido: ${format(sums.spent)}</strong><strong>Pendiente: ${format(sums.committed)}</strong><strong>Disponible: ${format(sums.allocated-sums.spent-sums.committed)}</strong></div>
    ${sums.legacy?`<div class="alert alert-warning py-2 small">${sums.legacy} líneas tienen gasto anterior sin desglose completo de recepciones; su imputación anual es aproximada.</div>`:""}
    <div class="table-responsive"><table class="table table-sm"><thead><tr><th>Zona</th><th>Asignado</th><th>Gasto en ejercicio</th><th>Compromiso SC del ejercicio</th><th>Disponible</th></tr></thead><tbody>${[...rows.values()].sort((a,b)=>a.zoneId.localeCompare(b.zoneId,'es',{numeric:true})).map(v=>`<tr><td>${escapeHtml(v.zoneId)}</td><td>${format(v.allocated)}</td><td>${format(v.spent)}</td><td>${format(v.committed)}</td><td class="${v.allocated-v.spent-v.committed<0?'text-danger fw-semibold':''}">${format(v.allocated-v.spent-v.committed)}</td></tr>`).join("")}</tbody></table></div></div>`;
    panel.append(report);
  }catch(e){console.error("Reporte financiero",e);}finally{budgetRendering=false;}
}
function eventCapture(e) {
  const target=e.target;if(!(target instanceof Element))return;
  const deletion=target.closest("#purchaseRequestDelete,.request-history-delete");
  if(deletion){stopOriginal(e);alert("Las solicitudes enviadas forman parte del historial financiero y no se pueden eliminar. Cancela únicamente los productos pendientes.");return;}
  if(role!=="admin")return;
  const officialSave=target.closest("#requestPriceModalSave");
  if(officialSave){stopOriginal(e);void saveOfficialPrices();return;}
  const financeExcel=target.closest("#financeDetailXlsx");
  if(financeExcel){stopOriginal(e);void exportFinancialRequest(financeExcel.dataset.requestId,"xlsx");return;}
  const financePdf=target.closest("#financeDetailPdf");
  if(financePdf){stopOriginal(e);void exportFinancialRequest(financePdf.dataset.requestId,"pdf");return;}
  const individualReceipt=target.closest(".request-line-receive");
  if(individualReceipt){
    stopOriginal(e);
    void openIndividualReceipt(individualReceipt.dataset.requestId,individualReceipt.dataset.lineId);
    return;
  }
  const receipt=target.closest("#massReceiptSave");
  if(receipt){stopOriginal(e);void saveReceiptsFromExisting(receipt.closest("#massReceiptModal")||receipt.closest(".modal"),"mass");return;}
  const grouped=target.closest("#purchaseGroupBatchSave");
  if(grouped&&grouped.closest("#purchaseGroupBatchModal")?.dataset.mode==="receive"){
    stopOriginal(e);void saveReceiptsFromExisting(grouped.closest("#purchaseGroupBatchModal"),"group");return;
  }
  const c=target.closest(".request-line-cancel,#purchaseRequestCancelAll,.request-history-cancel,#financeCancelDetail");
  if(c){stopOriginal(e);void openCancellation(c.dataset.requestId||activeRequestId(),c.dataset.lineId||"");}
}
function initEvents(){
  new MutationObserver(queueDecorate).observe(document.body,{childList:true,subtree:true});
  document.addEventListener("purchase-request-detail-rendered",e=>{
    const id=String(e.detail?.requestId||"");if(!id)return;
    watchDetail(id);queueDecorate();void showDetailFinancials(id);
  });
  const observer=new MutationObserver(()=>{
    if(document.querySelector("#purchaseBudgetsPanel.show"))void drawFiscalLedger();
  });
  const monitor=()=>{
    const panel=document.querySelector("#purchaseBudgetsPanelBody");
    if(panel){observer.disconnect();observer.observe(panel,{childList:true,subtree:false});}
  };
  document.addEventListener("show.bs.offcanvas",e=>{if(e.target.id==="purchaseBudgetsPanel"){
    monitor();setTimeout(()=>void drawFiscalLedger(),250);
  }});
  document.addEventListener("change",e=>{if(e.target.id==="purchaseBudgetYear")setTimeout(()=>void drawFiscalLedger(),350);});
  queueDecorate();
}
async function start(){
  const user=await waitForUser();if(!user)return;
  const profile=await getUserProfile(user.uid);role=String(profile?.appRole||profile?.role||"");
  if(role!=="admin"&&role!=="supervisor")return;
  initEvents();
}
document.addEventListener("click",eventCapture,true); // antes de los handlers de recepción heredados
start().catch(e=>console.error("No se pudo activar control financiero",e));
