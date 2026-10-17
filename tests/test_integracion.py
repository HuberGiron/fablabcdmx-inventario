from pathlib import Path
import re
root=Path(__file__).resolve().parents[1]
html=(root/'public/compras.html').read_text()
paths=[url.split('?')[0] for url in re.findall(r'<script type="module" src="([^\"]+)"',html)]
assert len(paths)==len(set(paths)), 'script repetido'
assert paths.index('js/compras-financial-integrity.js')<paths.index('js/compras-recepcion-masiva.js'), 'los handlers de captura deben cargarse primero'
for p in ['js/compras-financial-integrity.js','js/compras-financial-ledger.js','js/compras-financial-reports-v2.js']:
    assert (root/'public'/p).exists()
rules=(root/'firebase/firestore.rules').read_text()
start=rules.index('match /purchaseRequests/{requestId}')
line=rules.index('match /items/{lineId}',start)
assert "allow delete: if isAdmin() && resource.data.status == 'draft';" in rules[start:line]
assert "allow delete: if isAdmin()\n          && get(" in rules[line:]
print('OK: módulos, HTML y reglas de no eliminación de SC enviada')

assert paths.index('js/compras-pdf-status-colors.js')<paths.index('js/compras-financial-reports-v2.js'), 'el módulo de reportes debe envolver el generador DESPUÉS de la capa de colores'
upgrade=(root/'public/js/compras-financial-reports-v2.js').read_text()
assert 'receiptCostCorrections' in upgrade and 'lastActualCostCorrectionAt' in upgrade
assert 'lastActualCostAt:serverTimestamp()' not in upgrade, 'no se debe cambiar la fecha del gasto antiguo'
assert 'getDocsFromServer(path)' in upgrade, 'no usar caché local de gasto real'
base=(root/'public/js/compras-financial-integrity.js').read_text()
assert 'async function openIndividualReceipt(' in base and 'registerReceipt(rid,lid,quantity,unitCost)' in base
print('OK: reportes vigentes, PDF original+colores, historial de correcciones y recepción individual')
