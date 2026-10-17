import assert from 'node:assert/strict';
import { totals, spendingByYear } from '../public/js/compras-financial-ledger.js';

// Escenario de recepción parcial, requisición pendiente y posterior corrección
const original={
  quantityRequested:10,quantityReceived:4,quantityCancelled:2,
  unitPrice:120,requisitionUnitCost:120,requisitionStatus:'requisitioned',
  actualCostTotal:460,currency:'MXN',
  receiptHistory:[{id:'r1',at:'2025-11-14T08:00:00-06:00',quantity:2,unitCost:100},
                  {id:'r2',at:'2026-10-17T10:00:00-06:00',quantity:2,unitCost:130}]
};
assert.equal(totals(original).spent,460);
assert.equal(totals(original).commitment,480);
assert.equal(totals(original).active,940);
assert.equal(spendingByYear(original).byYear.get(2025),200);
assert.equal(spendingByYear(original).byYear.get(2026),260);
const revised={...original, actualCostTotal:480,
  receiptHistory: original.receiptHistory.map(e=>e.id==='r1'?{...e,unitCost:110}:e),
  receiptCostCorrections:[{receiptId:'r1',previousValue:100,newValue:110,deltaTotal:20,reason:'Error de captura',at:'2026-10-17T10:30:00-06:00'}]};
assert.equal(totals(revised).spent,480);
assert.equal(totals(revised).commitment,480,'La corrección no cambia lo pendiente');
assert.equal(totals(revised).active,960);
assert.equal(revised.quantityReceived,4,'La corrección no cambia unidades recibidas');
assert.equal(spendingByYear(revised).byYear.get(2025),220,'La corrección conserva el ejercicio de recepción');
assert.equal(spendingByYear(revised).byYear.get(2026),260);
// Registro previo sin eventos: sólo se ajusta el monto sin reimputar el año
const legacy={quantityRequested:4,quantityReceived:2,quantityCancelled:0,
  unitPrice:75,actualCostTotal:150,lastActualCostAt:'2025-12-02T00:00:00Z'};
const correctedLegacy={...legacy,actualCostTotal:160,lastActualCostCorrectionAt:'2026-10-17T00:00:00Z'};
assert.equal(totals(correctedLegacy).spent,160);
assert.equal(spendingByYear(correctedLegacy).byYear.get(2025),160);
assert.equal(spendingByYear(correctedLegacy).byYear.has(2026),false);
console.log('OK: correcciones de recepción, ejercicio original y compromiso intacto');
