/* Fuente única de fórmulas financieras para controles de compras y reportes nuevos.
   El gasto real nunca se recalcula multiplicando todas las piezas por el último precio. */
export const amount = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
export const qty = value => Math.max(0, Math.trunc(amount(value)));
export function pending(line) {
  return Math.max(0, qty(line?.quantityRequested) - qty(line?.quantityReceived) - qty(line?.quantityCancelled));
}
export function unitPending(line) {
  return Math.max(0, amount(line?.requisitionStatus === "requisitioned"
    ? (line?.requisitionUnitCost ?? line?.unitPrice) : line?.unitPrice));
}
export function realSpent(line) {
  if (line && Object.hasOwn(line, "actualCostTotal")) return Math.max(0, amount(line.actualCostTotal));
  return Math.max(0, qty(line?.quantityReceived) * amount(line?.lastActualUnitCost ?? line?.unitPrice));
}
export function totals(line) {
  const requested = qty(line?.quantityRequested);
  const received = qty(line?.quantityReceived);
  const cancelled = qty(line?.quantityCancelled);
  const outstanding = pending(line);
  const initial = amount(line?.originalUnitPrice ?? line?.unitPrice);
  const spent = realSpent(line);
  const commitment = outstanding * unitPending(line);
  return { requested, received, cancelled, pending: outstanding,
    original: requested * initial, spent, commitment, active: spent + commitment,
    cancelledValue: cancelled * unitPending(line), currency: String(line?.currency || "MXN").toUpperCase() };
}
export function sumLines(lines) {
  const result = new Map();
  for (const line of lines) {
    const t = totals(line);
    if (!result.has(t.currency)) result.set(t.currency, { original:0, spent:0, commitment:0, active:0, cancelledValue:0, received:0, pending:0, cancelled:0 });
    const row = result.get(t.currency);
    for (const key of Object.keys(row)) row[key] += t[key];
  }
  return result;
}
export function receiptHistory(line) {
  return Array.isArray(line?.receiptHistory) ? line.receiptHistory.filter(r => r && qty(r.quantity)>0 && amount(r.unitCost)>=0) : [];
}
export function money(n, currency="MXN") {
  return new Intl.NumberFormat("es-MX",{style:"currency",currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(amount(n));
}
export function eventYear(value) {
  if (!value) return null;
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getFullYear();
}
export function requestYear(request) {
  const date = request?.sentAt ?? request?.createdAt;
  return eventYear(date) || Number(String(request?.folio || "").match(/SC-(\d{4})-/)?.[1]) || null;
}
export function spendingByYear(line, fallbackYear=null) {
  const out = new Map();
  const events = receiptHistory(line);
  let registeredAmount = 0;
  for (const entry of events) {
    const year = eventYear(entry.at);
    const cost = qty(entry.quantity)*amount(entry.unitCost);
    registeredAmount += cost;
    if (year) out.set(year, (out.get(year)||0)+cost);
  }
  const legacyRest = Math.max(0, realSpent(line) - registeredAmount);
  if (legacyRest > 0.005) {
    const year = eventYear(line?.lastActualCostAt) || eventYear(line?.lastReceivedAt) || fallbackYear;
    if (year) out.set(year, (out.get(year)||0)+legacyRest);
  }
  return { byYear:out, legacyApprox: legacyRest > .005 };
}
