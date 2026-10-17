from pathlib import Path
import re
root=Path(__file__).resolve().parents[1]
html=(root/'public/compras.html').read_text()
paths=re.findall(r'<script type="module" src="([^\"]+)"',html)
assert len(paths)==len(set(paths)), 'script repetido'
assert paths.index('js/compras-financial-integrity.js')<paths.index('js/compras-recepcion-masiva.js'), 'los handlers de captura deben cargarse primero'
for p in ['js/compras-financial-integrity.js','js/compras-financial-ledger.js']:
    assert (root/'public'/p).exists()
rules=(root/'firebase/firestore.rules').read_text()
start=rules.index('match /purchaseRequests/{requestId}')
line=rules.index('match /items/{lineId}',start)
assert "allow delete: if isAdmin() && resource.data.status == 'draft';" in rules[start:line]
assert "allow delete: if isAdmin()\n          && get(" in rules[line:]
print('OK: módulos, HTML y reglas de no eliminación de SC enviada')
