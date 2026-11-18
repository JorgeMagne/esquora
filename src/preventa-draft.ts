import type { Requirement } from './api.ts'
import { amountInCents, boliviaDateTime, conditions } from './model.ts'

export const MAX_CONDITIONS = 7
export const MAX_REQUIREMENTS = 16

export type DraftCondition = {
  id: string
  title: string
  condition: string
  requirements: Requirement[]
  amount: string | null
  dueAt: string
}

export function draftRequirement(label = ''): Requirement {
  return { key: 'evidencia_' + crypto.randomUUID(), label }
}

export function emptyCondition(): DraftCondition {
  return { id: crypto.randomUUID(), title: '', condition: '', requirements: [draftRequirement('Comprobante de cumplimiento')], amount: null, dueAt: '' }
}

export function preventaTemplate(): DraftCondition[] {
  return conditions.map(({ title, condition, requirements }) => ({
    id: crypto.randomUUID(), title, condition,
    requirements: requirements.map(({ key, label }) => ({ key, label })),
    amount: null, dueAt: '',
  }))
}

export function moveCondition(rows: DraftCondition[], index: number, offset: -1 | 1) {
  const destination = index + offset
  if (index < 0 || index >= rows.length || destination < 0 || destination >= rows.length) return rows
  const reordered = rows.slice()
  reordered[index] = rows[destination]
  reordered[destination] = rows[index]
  return reordered
}

export function draftAmount(value: string) {
  try { return amountInCents(value) } catch { return null }
}

export function amountsForDraft(rows: DraftCondition[], deposit: number | null) {
  const manualAmounts = rows.map(({ amount }) => amount === null ? null : draftAmount(amount))
  const manual = manualAmounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0)
  const autoCount = rows.filter(({ amount }) => amount === null).length
  const remaining = deposit === null ? null : deposit - manual
  if (remaining === null || !autoCount || remaining < autoCount) return manualAmounts
  const perCondition = Math.floor(remaining / autoCount)
  let filled = 0
  return rows.map((row, index) => {
    if (row.amount !== null) return manualAmounts[index]
    filled += 1
    return filled === autoCount ? remaining - perCondition * (autoCount - 1) : perCondition
  })
}

export function buildDraftConditions(rows: DraftCondition[], deposit: number, now = Date.now()) {
  if (!rows.length || rows.length > MAX_CONDITIONS) throw new Error('Define entre una y siete condiciones.')
  const amounts = amountsForDraft(rows, deposit)
  const tranches = rows.map(({ title, condition, requirements, dueAt }, index) => {
    const number = index + 1
    const amount = amounts[index]
    if (!title.trim() || !condition.trim()) throw new Error('Completa el nombre y la descripción de la condición ' + number + '.')
    if (!requirements.length || requirements.length > MAX_REQUIREMENTS || requirements.some(({ label }) => !label.trim())) {
      throw new Error('Completa los documentos requeridos en la condición ' + number + '.')
    }
    if (amount === null) throw new Error('Revisa el importe de la condición ' + number + '.')
    const deadline = boliviaDateTime(dueAt)
    if (Date.parse(deadline) <= now) throw new Error('La fecha límite de la condición ' + number + ' debe ser futura.')
    return {
      title: title.trim(), condition: condition.trim(), amount, dueAt: deadline,
      requirements: requirements.map(({ key, label }) => ({ key, label: label.trim() })),
    }
  })
  if (tranches.reduce((sum, row) => sum + row.amount, 0) !== deposit) {
    throw new Error('La suma de las condiciones debe coincidir con la cuota inicial.')
  }
  return tranches
}
