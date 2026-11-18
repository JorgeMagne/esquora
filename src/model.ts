export type AccountKind = 'buyer' | 'developer' | 'arbiter'
export type Role = 'buyer' | 'seller' | 'arbiter'

export const roleNames: Record<AccountKind, string> = {
  buyer: 'Comprador', developer: 'Desarrollador', arbiter: 'Tercero designado',
}

export const conditions = [
  {
    title: 'Documentación del proyecto',
    condition: 'Presentar los documentos de la preventa y del proyecto.',
    requirements: [
      { key: 'contrato_certificado', label: 'Contrato certificado por Defensa del Consumidor', guide: 'Comprueba que sea el mismo contrato que aceptaste.' },
      { key: 'registro_proveedor', label: 'Registro del proveedor inmobiliario', guide: 'Comprueba que el registro esté a nombre del desarrollador.' },
      { key: 'derecho_terreno', label: 'Derecho sobre el terreno', guide: 'Revisa quién figura como titular y cómo se vincula con el desarrollador.' },
      { key: 'permiso_construccion', label: 'Permiso municipal de construcción', guide: 'Revisa que corresponda a la dirección del proyecto y esté vigente.' },
    ],
  },
  {
    title: 'Inicio de obra',
    condition: 'Acreditar el inicio de la construcción en el terreno del proyecto.',
    requirements: [
      { key: 'acta_inicio', label: 'Acta de inicio de obra', guide: 'Revisa la fecha y el proyecto que figura en el acta.' },
      { key: 'fotos_inicio', label: 'Fotografías fechadas del terreno', guide: 'Comprueba que se vea el predio y el inicio de los trabajos.' },
    ],
  },
] as const

export const requirementGuide = new Map<string, string>(conditions.flatMap((condition) =>
  [...condition.requirements].map((requirement) => [requirement.key, requirement.guide] as const),
))

const whole = new Intl.NumberFormat('es-BO', { useGrouping: true })
const withCents = new Intl.NumberFormat('es-BO', { useGrouping: true, minimumFractionDigits: 2, maximumFractionDigits: 2 })
const boliviaDate = new Intl.DateTimeFormat('es-BO', { dateStyle: 'medium', timeZone: 'America/La_Paz' })
const boliviaFullDate = new Intl.DateTimeFormat('es-BO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/La_Paz' })

export function numberAmount(cents: number) {
  return (cents % 100 === 0 ? whole : withCents).format(cents / 100)
}

export function money(cents: number, currency = 'USD') {
  return currency + ' ' + numberAmount(cents)
}

export function amountInCents(value: string, allowZero = false) {
  const normalized = value.trim().replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) throw new Error('Ingresa un importe con hasta dos decimales.')
  const [integer, decimal = ''] = normalized.split('.')
  const cents = Number(integer) * 100 + Number(decimal.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || (!allowZero && cents === 0)) throw new Error('Revisa el importe ingresado.')
  return cents
}

export function formatDate(value?: string | null, withTime = false) {
  if (!value) return '—'
  return (withTime ? boliviaFullDate : boliviaDate).format(new Date(value.length === 10 ? value + 'T12:00:00-04:00' : value))
}

export function boliviaDateTime(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Indica la fecha y hora del plazo.')
  return new Date(value + ':00-04:00').toISOString()
}

export const operationLabels: Record<string, string> = {
  draft: 'Borrador', invited: 'Acuerdo por aceptar', deploying: 'Confirmando acuerdo',
  awaiting_deposit: 'Por depositar', funded: 'Con dinero protegido', closed: 'Finalizada',
  declined: 'Acuerdo rechazado', cancelled: 'Invitación retirada',
}

export const conditionLabels: Record<string, string> = {
  locked: 'Pendiente de depósito', pending: 'Por presentar', submitted: 'En revisión',
  approved: 'Confirmada por el comprador', objected: 'Observada', released: 'Entregada',
  refund_requested: 'Devolución solicitada', refunded: 'Devuelta',
  disputed: 'En desacuerdo', resolved: 'Resuelta',
}

export const eventLabels: Record<string, string> = {
  created: 'Operación creada', invited: 'Invitación enviada', accepted: 'Acuerdo aceptado',
  escrow_created: 'Protección registrada', funded: 'Depósito confirmado', evidence_submitted: 'Documentos presentados',
  approved: 'Condición confirmada', released: 'Pago entregado', refund_requested: 'Devolución solicitada',
  refund_accepted: 'Devolución aceptada', refund_rejected: 'Devolución rechazada', refunded: 'Dinero devuelto',
  refund_responded: 'Respuesta a la devolución',
  refund_response_expired: 'Venció el plazo para responder la devolución',
  resolution_proposed: 'Instrucción de resolución presentada',
  resolution_signed: 'Reparto firmado',
  resolution_verified: 'Instrucción verificada por ESQUORA',
  resolution_objected: 'Instrucción observada',
  disputed: 'Desacuerdo abierto', dispute_opened: 'Desacuerdo abierto', resolved: 'Desacuerdo resuelto',
  closed: 'Operación finalizada', objected: 'Documentos observados', declined: 'Acuerdo rechazado',
  cancelled: 'Invitación retirada', probe_rejected: 'Protección comprobada',
}

export type ConditionAction = 'evidence' | 'approve' | 'release' | 'refund' | 'refund-response' | 'resolve'

type SettlementView = { status: string; toSeller?: number | null; toBuyer?: number | null }

export function conditionAmounts(tranche: SettlementView & { amount: number }):
  { state: 'shared'; seller: number; buyer: number } | { state: 'delivered' | 'returned' | 'held' | 'planned'; amount: number } {
  const { amount, status, toSeller = 0, toBuyer = 0 } = tranche
  if (status === 'released') return { state: 'delivered', amount: toSeller ?? 0 }
  if (status === 'refunded') return { state: 'returned', amount: toBuyer ?? 0 }
  if (status === 'resolved') {
    if (!toBuyer) return { state: 'delivered', amount: toSeller ?? 0 }
    if (!toSeller) return { state: 'returned', amount: toBuyer }
    return { state: 'shared', seller: toSeller, buyer: toBuyer }
  }
  return { state: status === 'locked' ? 'planned' : 'held', amount }
}

export type TowerStage = 'planned' | 'documented' | 'started'

export function towerStage(tranches: (SettlementView & { title: string; condition: string })[]): TowerStage {
  const completed = (tranche: SettlementView) => tranche.status === 'approved' || tranche.status === 'released' ||
    (tranche.status === 'resolved' && (tranche.toSeller ?? 0) > 0 && !tranche.toBuyer)
  const completedTemplate = (template: (typeof conditions)[number]) => tranches.some((tranche) =>
    tranche.title === template.title && tranche.condition === template.condition && completed(tranche))
  if (completedTemplate(conditions[1])) return 'started'
  return completedTemplate(conditions[0]) ? 'documented' : 'planned'
}

export function nextConditionAction(role: Role, condition: {
  status: string
  overdue: boolean
  refundResponse?: string | null
  refundWindowPassed?: boolean
}): ConditionAction | null {
  const { status, overdue, refundResponse, refundWindowPassed } = condition
  if (role === 'buyer') {
    if (status === 'submitted') return 'approve'
    if (overdue && (status === 'pending' || status === 'objected')) return 'refund'
  }
  if (role === 'seller') {
    if (!overdue && (status === 'pending' || status === 'objected')) return 'evidence'
    if (status === 'approved') return 'release'
    if (status === 'refund_requested' && !refundResponse && !refundWindowPassed) return 'refund-response'
  }
  if (role === 'arbiter' && (status === 'disputed' || (status === 'refund_requested' && (refundResponse || refundWindowPassed)))) return 'resolve'
  return null
}

export function initials(name: string) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || 'ES'
}

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
