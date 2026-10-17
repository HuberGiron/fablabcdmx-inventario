import assert from 'node:assert/strict';
import { totals, sumLines, spendingByYear } from '../public/js/compras-financial-ledger.js';

const motor = {
  itemId: '0812345', quantityRequested: 10, quantityReceived:4,
  quantityCancelled:2, unitPrice:120, originalUnitPrice:100,
  requisitionUnitCost:120, requisitionStatus:'requisitioned',
  actualCostTotal:460,
  receiptHistory: [{ at:'2026-10-17T10:00:00-06:00', quantity:4, unitCost:115 }],
  currency:'MXN'
};
assert.deepEqual([totals(motor).original, totals(motor).spent, totals(motor).commitment, totals(motor).active], [1000,460,480,940]);
assert.equal(sumLines([motor]).get('MXN').active,940);
assert.equal(spendingByYear(motor).byYear.get(2026),460);
const changed={...motor,unitPrice:200,requisitionUnitCost:200};
assert.equal(totals(changed).spent,460,'El gasto anterior no debe recalcularse al cambiar el precio');
assert.equal(totals(changed).commitment,800);
const fullyCancelled={...motor,quantityReceived:0,quantityCancelled:10,actualCostTotal:0};
assert.equal(totals(fullyCancelled).active,0);
const legacy={quantityRequested:4,quantityReceived:2,quantityCancelled:0,unitPrice:10,
  actualCostTotal:18,lastActualCostAt:'2026-12-14T00:00:00Z'};
assert.equal(spendingByYear(legacy).legacyApprox,true);
assert.equal(spendingByYear(legacy).byYear.get(2026),18);
console.log('OK: fórmulas, cancelación, recepción parcial, gasto inmutable y ejercicio fiscal');
