import assert from 'node:assert/strict'
import test from 'node:test'
import { amountsForDraft, buildDraftConditions, emptyCondition, moveCondition, preventaTemplate } from './preventa-draft.ts'

test('reparte todos los centavos también con condiciones e importes personalizados', () => {
  const rows = [emptyCondition(), { ...emptyCondition(), amount: '2,50' }, emptyCondition()]
  assert.deepEqual(amountsForDraft(rows, 1001), [375, 250, 376])
  assert.deepEqual(amountsForDraft(rows, 249), [null, 250, null])
})

test('conserva las claves de evidencia cuando cambian etiqueta y orden', () => {
  const rows = preventaTemplate()
  const key = rows[0].requirements[0].key
  rows[0].requirements[0].label = 'Contrato actualizado'
  const moved = moveCondition(rows, 0, 1)
  assert.equal(moved[1].requirements[0].key, key)
  assert.equal(moved[1].requirements[0].label, 'Contrato actualizado')
  assert.deepEqual(moveCondition(rows, 0, -1), rows)
})

test('rechaza plazos vencidos, evidencias en blanco y repartos inexactos', () => {
  const row = { ...emptyCondition(), title: 'Entrega', condition: 'Presentar un comprobante.', dueAt: '2037-01-20T20:30' }
  const now = Date.parse('2037-01-19T20:00:00Z')
  assert.equal(buildDraftConditions([row], 1001, now)[0].amount, 1001)
  assert.throws(() => buildDraftConditions([{ ...row, amount: '10' }], 1001, now), /suma/)
  assert.throws(() => buildDraftConditions([{ ...row, dueAt: '2037-01-18T20:30' }], 1001, now), /futura/)
  assert.throws(() => buildDraftConditions([{ ...row, requirements: [{ ...row.requirements[0], label: '   ' }] }], 1001, now), /documento/)
})
