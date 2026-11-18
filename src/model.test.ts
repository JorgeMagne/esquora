import assert from 'node:assert/strict'
import test from 'node:test'
import { netAfterFees } from '../shared/fees.ts'
import { amountInCents, boliviaDateTime, conditionAmounts, conditions, money, nextConditionAction, towerStage } from './model.ts'

test('conserva centavos y rechaza importes con más de dos decimales', () => {
  assert.equal(amountInCents('6000,05'), 600005)
  assert.throws(() => amountInCents('0.001'))
  assert.equal(money(600005), 'USD 6.000,05')
})

test('guarda fechas pactadas en horario de Bolivia', () => {
  assert.equal(boliviaDateTime('2026-11-19T20:30'), '2026-11-20T00:30:00.000Z')
})

test('el reembolso vence antes de abrir el desacuerdo y se resuelve por el tercero', () => {
  assert.equal(nextConditionAction('buyer', { status: 'pending', overdue: false }), null)
  assert.equal(nextConditionAction('buyer', { status: 'pending', overdue: true }), 'refund')
  assert.equal(nextConditionAction('buyer', { status: 'refund_requested', overdue: true }), null)
  assert.equal(nextConditionAction('arbiter', { status: 'refund_requested', overdue: true, refundResponse: 'accepted' }), 'resolve')
  assert.equal(nextConditionAction('seller', { status: 'pending', overdue: true }), null)
  assert.equal(nextConditionAction('seller', { status: 'approved', overdue: true }), 'release')
})

test('descuenta ambas comisiones del monto de la condición', () => {
  assert.equal(netAfterFees(600000, 90), 592800)
})

test('redondea el neto después de aplicar ambas comisiones', () => {
  assert.equal(netAfterFees(500, 90), 494)
  assert.equal(netAfterFees(125, 90), 124)
})

test('visualiza los netos de un reparto y mantiene los importes íntegros en condiciones protegidas', () => {
  const base = { amount: 600000, status: 'resolved' }
  assert.deepEqual(conditionAmounts({ ...base, toSeller: 197600, toBuyer: 395200 }), { state: 'shared', seller: 197600, buyer: 395200 })
  assert.deepEqual(conditionAmounts({ ...base, toSeller: 592800, toBuyer: 0 }), { state: 'delivered', amount: 592800 })
  assert.deepEqual(conditionAmounts({ ...base, toSeller: 0, toBuyer: 592800 }), { state: 'returned', amount: 592800 })
  assert.deepEqual(conditionAmounts({ ...base, status: 'submitted' }), { state: 'held', amount: 600000 })
})

test('el plano incorpora una condición confirmada y conserva el estado esquemático ante una devolución', () => {
  const documentation = { ...conditions[0], status: 'released', toSeller: 592800 }
  assert.equal(towerStage([{ ...conditions[0], status: 'submitted' }]), 'planned')
  assert.equal(towerStage([documentation, { ...conditions[1], status: 'refunded', toBuyer: 592800 }]), 'documented')
  assert.equal(towerStage([{ ...conditions[1], status: 'resolved', toBuyer: 0, toSeller: 592800 }, documentation]), 'started')
  assert.equal(towerStage([documentation, { ...conditions[1], status: 'resolved', toBuyer: 300000, toSeller: 292800 }]), 'documented')
  assert.equal(towerStage([{ title: 'Conexión de agua', condition: 'Presentar recibo.', status: 'approved' }]), 'planned')
})
