// Reglas del negocio, expedientes y registro de actividad.

import { createHash } from 'node:crypto'
import { netAfterFees } from '../shared/fees.ts'
import { ESQUORA_RESOLUTION_TERMS } from '../shared/resolution-terms.ts'
import { APP_URL, TW_FEE_BPS } from './config.ts'
import { all, get, now, run } from './db.ts'
import { ADDRESSES, centsToAmount } from './stellar.ts'

// ───────────────────────── Tipos de fila ─────────────────────────

export interface UserRow {
  id: string
  pollar_id: string
  email: string | null
  name: string
  kind: 'buyer' | 'developer' | 'arbiter' | null
  org_name: string | null
  org_nit: string | null
  phone: string | null
  public_key: string
  wallet_status: 'pending' | 'active'
  notif_seen_id: number
  created_at: string
}

export type ResolutionMode = 'pending' | 'external' | 'esquora'

export interface OpRow {
  id: string
  code: string
  project_id: string
  seller_id: string
  buyer_id: string | null
  buyer_email: string
  buyer_name: string
  arbiter_id: string | null
  resolution_mode: ResolutionMode
  arbiter_email: string | null
  arbiter_invite_token: string | null
  unit: string
  unit_detail: string | null
  price: number
  deposit: number
  fee_bps: number
  refund_response_hours: number
  contract_file_id: string | null
  contract_sha256: string | null
  terms_json: string
  terms_digest: string
  seller_sig: string | null
  seller_signed_at: string | null
  buyer_sig: string | null
  invite_token: string
  status: 'draft' | 'invited' | 'deploying' | 'awaiting_deposit' | 'funded' | 'closed' | 'declined' | 'cancelled'
  decline_reason: string | null
  escrow_contract_id: string | null
  deployment_error: string | null
  held_on_chain: number | null
  observed_at: string | null
  observed_ledger: number | null
  escrow_tx: string | null
  created_at: string
  accepted_at: string | null
  funded_at: string | null
  closed_at: string | null
}

export interface TrancheRow {
  id: string
  op_id: string
  idx: number
  title: string
  condition: string
  requirements_json: string
  amount: number
  due_at: string
  status:
    | 'locked'
    | 'pending'
    | 'submitted'
    | 'objected'
    | 'approved'
    | 'released'
    | 'refund_requested'
    | 'refunded'
    | 'disputed'
    | 'resolved'
  evidence_note: string | null
  evidence_at: string | null
  objection: string | null
  objected_at: string | null
  approved_at: string | null
  refund_requested_at: string | null
  refund_response: 'accepted' | 'rejected' | null
  refund_response_reason: string | null
  refund_responded_at: string | null
  dispute_reason: string | null
  dispute_by: string | null
  dispute_at: string | null
  settled_at: string | null
  to_seller: number | null
  to_buyer: number | null
  fee: number | null
  tx_hash: string | null
}

export type ActionKind = 'deploy' | 'fund' | 'evidence' | 'approve' | 'release' | 'refund' | 'dispute' | 'resolve' | 'withdraw' | 'probe'

export interface ChainTxRow {
  id: string
  op_id: string | null
  tranche_id: string | null
  deposit_id: string | null
  withdrawal_id: string | null
  kind: ActionKind
  xdr: string
  signed_xdr: string | null
  source: string
  status: 'armed' | 'pending' | 'confirmed' | 'failed'
  hash: string
  ledger: number | null
  expires_at: number | null
  error: string | null
  payload_json: string
  created_by: string | null
  created_at: string
  submitted_at: string | null
  confirmed_at: string | null
}

export interface DepositRow {
  id: string
  op_id: string
  user_id: string
  amount: number
  rate: number
  amount_bob: number
  reference: string
  status: 'pending' | 'paid' | 'settled' | 'failed'
  expires_at: string
  paid_at: string | null
  tx_hash: string | null
  error: string | null
  created_at: string
}
export type Role = 'seller' | 'buyer' | 'arbiter'

export class HttpError extends Error {
  status: number
  extra?: Record<string, unknown>
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

const SETTLED = ['released', 'refunded', 'resolved']

// ───────────────────────── Avisos en vivo ─────────────────────────

type Listener = (msg: unknown) => void
const listeners = new Map<string, Set<Listener>>()

export function subscribe(userId: string, fn: Listener) {
  if (!listeners.has(userId)) listeners.set(userId, new Set())
  listeners.get(userId)!.add(fn)
  return () => listeners.get(userId)?.delete(fn)
}

export function push(userIds: (string | null)[], msg: unknown) {
  for (const id of new Set(userIds)) if (id) for (const fn of listeners.get(id) ?? []) fn(msg)
}

export const participants = (op: OpRow) => [
  op.seller_id, op.status === 'draft' ? null : op.buyer_id, arbiterHasCase(tranchesOf(op.id)) ? op.arbiter_id : null,
]

export function logEvent(
  op: OpRow,
  actorId: string | null,
  type: string,
  data: Record<string, unknown> = {},
  txHash: string | null = null,
) {
  run(
    'INSERT INTO events (op_id, actor_id, type, data_json, tx_hash, created_at) VALUES (?,?,?,?,?,?)',
    op.id,
    actorId,
    type,
    JSON.stringify(data),
    txHash,
    now(),
  )
  push(participants(op), { type: 'op', id: op.id })
}

// ───────────────────────── Lecturas ─────────────────────────

export const userById = (id: string) => get<UserRow>('SELECT * FROM users WHERE id = ?', id)
export const opById = (id: string) => get<OpRow>('SELECT * FROM operations WHERE id = ?', id)
export const trancheById = (id: string) => get<TrancheRow>('SELECT * FROM tranches WHERE id = ?', id)
export const tranchesOf = (opId: string) => all<TrancheRow>('SELECT * FROM tranches WHERE op_id = ? ORDER BY idx', opId)
export const activeTxOf = (trancheId: string) =>
  get<ChainTxRow>("SELECT * FROM chain_txs WHERE tranche_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1", trancheId)
export function roleOf(op: OpRow, userId: string): Role | null {
  if (op.seller_id === userId) return 'seller'
  if (op.buyer_id === userId) return 'buyer'
  if (op.arbiter_id === userId) return 'arbiter'
  return null
}

export const isOverdue = (t: TrancheRow) => Date.now() > Date.parse(t.due_at)

/** El tercero designado solo ve una operación cuando hay algo que le compete. */
export function arbiterHasCase(tranches: TrancheRow[]) {
  return tranches.some((t) => t.status === 'disputed' || t.status === 'resolved' || t.status === 'refunded' || !!t.refund_requested_at)
}

export function refundWindowPassed(op: OpRow, t: TrancheRow) {
  if (!t.refund_requested_at) return false
  return Date.now() > Date.parse(t.refund_requested_at) + op.refund_response_hours * 3600_000
}

export function notifyExpiredRefunds() {
  const checkedAt = now()
  const events = all<{ op_id: string }>(
    `INSERT INTO events (op_id, type, data_json, created_at)
     SELECT o.id, 'refund_response_expired', json_object('trancheId', t.id, 'tranche', t.idx + 1), ?
     FROM tranches t JOIN operations o ON o.id = t.op_id
     WHERE o.status = 'funded' AND t.status = 'refund_requested' AND t.refund_response IS NULL
       AND ROUND(unixepoch(t.refund_requested_at, 'subsec') * 1000) + o.refund_response_hours * 3600000 < ?
       AND NOT EXISTS (
         SELECT 1 FROM events e WHERE e.op_id = o.id AND e.type = 'refund_response_expired'
           AND json_extract(e.data_json, '$.trancheId') = t.id
       )
     RETURNING op_id`,
    checkedAt, Date.parse(checkedAt),
  )
  for (const opId of new Set(events.map(({ op_id }) => op_id))) {
    push([opById(opId)!.arbiter_id], { type: 'op', id: opId })
  }
}

export const feeFor = (op: OpRow, grossCents: number) => grossCents - netAfterFees(grossCents, op.fee_bps)

// ───────────────────────── Acuerdo ─────────────────────────

export function buildTerms(input: {
  code: string
  project: { name: string; city: string; address: string }
  unit: string
  unitDetail?: string
  price: number
  deposit: number
  feeBps: number
  refundResponseHours: number
  seller: UserRow
  buyer: { name: string; email: string }
  arbiter: UserRow | null
  arbiterEmail: string | null
  resolutionMode: ResolutionMode
  contractSha256: string | null
  tranches: { title: string; condition: string; requirements: { key: string; label: string }[]; amount: number; dueAt: string }[]
}) {
  const terms = {
    version: 2,
    operacion: input.code,
    inmueble: {
      proyecto: input.project.name, ciudad: input.project.city, direccion: input.project.address, unidad: input.unit,
      ...(input.unitDetail ? { detalleUnidad: input.unitDetail } : {}),
    },
    precio: centsToAmount(input.price),
    cuotaInicialAsegurada: centsToAmount(input.deposit),
    moneda: 'USDC',
    comisionPlataformaBps: input.feeBps,
    comisionTrustlessWorkBps: TW_FEE_BPS,
    comisionAplicaA: ['liberacion', 'devolucion'],
    desarrollador: { nombre: input.seller.org_name ?? input.seller.name, cuenta: input.seller.public_key },
    comprador: { nombre: input.buyer.name, correo: input.buyer.email },
    contratoSha256: input.contractSha256,
    plazoRespuestaDevolucionHoras: input.refundResponseHours,
    tramos: input.tranches.map((t, i) => ({
      numero: i + 1,
      titulo: t.title,
      condicion: t.condition,
      requisitos: t.requirements.map((r) => r.label),
      monto: centsToAmount(t.amount),
      fechaLimite: t.dueAt,
    })),
  }
  return serializeAgreementTerms(terms, input.resolutionMode, input.arbiter, input.arbiterEmail)
}

export function serializeAgreementTerms(terms: Record<string, unknown>, mode: ResolutionMode, resolver: UserRow | null, email: string | null) {
  const json = JSON.stringify({
    ...terms,
    version: 2,
    modalidadResolucion: mode,
    terceroDesignado: resolver ? { nombre: resolver.org_name ?? resolver.name, cuenta: resolver.public_key } : null,
    terceroCorreo: mode === 'external' ? email : null,
    resolucionEsquora: mode === 'esquora' ? ESQUORA_RESOLUTION_TERMS : null,
  })
  return { json, digest: createHash('sha256').update(json).digest('hex') }
}

export function publicParty(u: UserRow) {
  return { id: u.id, name: u.name, orgName: u.org_name, publicKey: u.public_key, kind: u.kind }
}

export function fileMeta(id: string) {
  const f = get<any>('SELECT id, sha256, name, size, mime, created_at FROM files WHERE id = ?', id)
  return f ? { id: f.id, sha256: f.sha256, name: f.name, size: f.size, mime: f.mime, createdAt: f.created_at } : null
}

export function serializeAction(tx: ChainTxRow) {
  return {
    id: tx.id,
    kind: tx.kind,
    status: tx.status,
    hash: tx.hash,
    ledger: tx.ledger,
    expiresAt: tx.expires_at === null ? null : new Date(tx.expires_at).toISOString(),
    error: tx.error,
    createdAt: tx.created_at,
    confirmedAt: tx.confirmed_at,
  }
}

export function todoFor(op: OpRow, tranches: TrancheRow[], role: Role): string | null {
  if (op.status === 'deploying') return 'Confirmando la operación'
  if (role === 'seller' && op.status === 'draft') {
    if (op.resolution_mode === 'pending') return 'Elige cómo resolver un desacuerdo'
    if (!op.arbiter_id) return op.resolution_mode === 'external' ? 'Esperando al tercero invitado' : 'Designa al equipo de ESQUORA'
    return 'Confirma el acuerdo para enviarlo'
  }
  if (role === 'buyer' && op.status === 'invited') return 'Revisa y acepta el acuerdo'
  if (role === 'buyer' && op.status === 'awaiting_deposit') {
    const paid = get("SELECT 1 FROM deposits WHERE op_id = ? AND status = 'paid' LIMIT 1", op.id)
    return paid ? 'Confirmando el depósito' : 'Deposita la cuota inicial'
  }
  if (op.status !== 'funded') return null
  for (const t of tranches) {
    const n = t.idx + 1
    if (activeTxOf(t.id)) return 'Confirmando la condición ' + n
    if (t.status === 'disputed') return op.resolution_mode === 'esquora' ?
      (role === 'arbiter' ? 'Revisa la instrucción de la condición ' : 'Consulta la instrucción de la condición ') + n :
      role === 'arbiter' ? 'Revisa el desacuerdo en la condición ' + n : 'El tercero revisa la condición ' + n
    if (t.status === 'refund_requested') {
      if (t.refund_response || refundWindowPassed(op, t)) {
        if (op.resolution_mode === 'esquora') return role === 'arbiter' ?
          'Revisa la instrucción de devolución' : 'Consulta la instrucción de devolución'
        return role === 'arbiter' ? 'Resuelve la devolución de la condición ' + n : 'El tercero resolverá la devolución'
      }
      if (role === 'seller') return 'Responde la devolución de la condición ' + n
      if (role === 'buyer') return 'El desarrollador debe responder la devolución'
    }
    if (role === 'seller' && t.status === 'approved') return 'Recibe el pago aprobado de la condición ' + n
    if (role === 'seller' && t.status === 'objected') return 'Responde la objeción de la condición ' + n
    if (role === 'seller' && t.status === 'pending' && !isOverdue(t)) return 'Presenta los documentos de la condición ' + n
    if (role === 'buyer' && t.status === 'submitted') return 'Revisa los documentos de la condición ' + n
    if (role === 'buyer' && ['pending', 'objected'].includes(t.status) && isOverdue(t)) return 'Puedes pedir la devolución de la condición ' + n
  }
  return null
}

export function totalsOf(op: OpRow, tranches: TrancheRow[]) {
  let released = 0
  let refunded = 0
  let fees = 0
  for (const t of tranches) {
    if (!SETTLED.includes(t.status)) continue
    released += t.to_seller ?? 0
    refunded += t.to_buyer ?? 0
    fees += t.fee ?? 0
  }
  return { held: op.held_on_chain ?? 0, released, refunded, fees }
}
export function serializeOpSummary(op: OpRow, role: Role) {
  const tranches = tranchesOf(op.id)
  const project = get<any>('SELECT id, name, city FROM projects WHERE id = ?', op.project_id)
  const seller = userById(op.seller_id)!
  return {
    id: op.id,
    code: op.code,
    status: op.status,
    role,
    project,
    unit: op.unit,
    unitDetail: op.unit_detail,
    price: op.price,
    deposit: op.deposit,
    buyerName: op.buyer_name,
    sellerName: seller.org_name ?? seller.name,
    totals: totalsOf(op, tranches),
    todo: todoFor(op, tranches, role),
    tranches: tranches.map((t) => ({
      idx: t.idx, title: t.title, amount: t.amount, feeEstimate: feeFor(op, t.amount),
      status: t.status, dueAt: t.due_at, overdue: isOverdue(t),
    })),
    createdAt: op.created_at,
  }
}

export function serializeOp(op: OpRow, viewer: UserRow) {
  const role = roleOf(op, viewer.id)!
  const tranches = tranchesOf(op.id)
  const project = get<any>('SELECT id, name, city, address FROM projects WHERE id = ?', op.project_id)
  const seller = userById(op.seller_id)!
  const buyer = op.buyer_id ? userById(op.buyer_id)! : null
  const arbiter = op.arbiter_id ? userById(op.arbiter_id) : null
  const events = all<any>(
    `SELECT e.id, e.type, e.data_json, e.tx_hash, e.created_at, e.actor_id FROM events e WHERE e.op_id = ? ORDER BY e.id DESC LIMIT 200`,
    op.id,
  )
  const order =
    role === 'buyer'
      ? get<any>("SELECT * FROM deposits WHERE op_id = ? AND status IN ('pending','paid','failed') ORDER BY created_at DESC LIMIT 1", op.id)
      : null

  return {
    id: op.id,
    code: op.code,
    status: op.status,
    role,
    project,
    unit: op.unit,
    unitDetail: op.unit_detail,
    price: op.price,
    deposit: op.deposit,
    feeBps: op.fee_bps,
    refundResponseHours: op.refund_response_hours,
    seller: publicParty(seller),
    buyer: buyer ? publicParty(buyer) : null,
    buyerName: op.buyer_name,
    buyerEmail: op.buyer_email,
    arbiter: arbiter ? publicParty(arbiter) : null,
    resolutionMode: op.resolution_mode,
    arbiterEmail: op.arbiter_email,
    arbiterInviteToken: role === 'seller' && op.status === 'draft' && !arbiter ? op.arbiter_invite_token : null,
    resolverReady: arbiter?.wallet_status === 'active',
    resolutionTerms: op.resolution_mode === 'esquora' ? JSON.parse(op.terms_json).resolucionEsquora : null,
    contract: op.contract_file_id ? fileMeta(op.contract_file_id) : null,
    contractSha256: op.contract_sha256,
    terms: op.terms_json,
    termsDigest: op.terms_digest,
    sellerSignedAt: op.seller_signed_at,
    sellerSig: op.seller_sig,
    buyerSig: op.buyer_sig,
    inviteToken: role === 'seller' ? op.invite_token : null,
    declineReason: op.decline_reason,
    escrow: op.escrow_contract_id ? { account: op.escrow_contract_id, contractId: op.escrow_contract_id, txHash: op.escrow_tx } : null,
    observedAt: op.observed_at,
    deploymentError: op.deployment_error,
    platformFeeAccount: ADDRESSES.fees,
    totals: totalsOf(op, tranches),
    todo: todoFor(op, tranches, role),
    depositOrder: order && (order.status === 'paid' || Date.parse(order.expires_at) > Date.now()) ? serializeOrder(order) : null,
    tranches: tranches.map((t) => {
      const rows = all<{ req_key: string; file_id: string; created_at: string; version_hash: string | null; is_current: number }>(
        'SELECT req_key, file_id, created_at, version_hash, is_current FROM evidence WHERE tranche_id = ? ORDER BY created_at DESC', t.id)
      const evidence = rows.map((row) => ({ row, item: { reqKey: row.req_key, file: fileMeta(row.file_id) } }))
      const history = new Map<string, { txHash: string | null; at: string; files: (typeof evidence[number]['item'])[] }>()
      for (const { row, item } of evidence) {
        if (row.is_current) continue
        const key = row.version_hash ?? row.created_at
        const version = history.get(key) ?? { txHash: row.version_hash, at: row.created_at, files: [] }
        version.files.push(item)
        history.set(key, version)
      }
      const pendingAction = activeTxOf(t.id)
      return {
        id: t.id,
        idx: t.idx,
        title: t.title,
        condition: t.condition,
        requirements: JSON.parse(t.requirements_json) as { key: string; label: string }[],
        amount: t.amount,
        feeEstimate: feeFor(op, t.amount),
        dueAt: t.due_at,
        overdue: isOverdue(t),
        status: t.status,
        evidence: evidence.filter(({ row }) => row.is_current).map(({ item }) => item),
        evidenceHistory: [...history.values()],
        evidenceNote: t.evidence_note,
        evidenceAt: t.evidence_at,
        objection: t.objection,
        objectedAt: t.objected_at,
        approvedAt: t.approved_at,
        refundRequestedAt: t.refund_requested_at,
        refundResponse: t.refund_response,
        refundResponseReason: t.refund_response_reason,
        refundRespondedAt: t.refund_responded_at,
        refundResponseDueAt: t.refund_requested_at ? new Date(Date.parse(t.refund_requested_at) + op.refund_response_hours * 3600_000).toISOString() : null,
        refundWindowPassed: refundWindowPassed(op, t),
        disputeReason: t.dispute_reason,
        disputeByRole: t.dispute_by ? roleOf(op, t.dispute_by) : null,
        disputeAt: t.dispute_at,
        settledAt: t.settled_at,
        toSeller: t.to_seller,
        toBuyer: t.to_buyer,
        fee: t.fee,
        txHash: t.tx_hash,
        pendingAction: pendingAction ? serializeAction(pendingAction) : null,
      }
    }),
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      data: JSON.parse(e.data_json),
      txHash: e.tx_hash,
      at: e.created_at,
      actorRole: e.actor_id ? roleOf(op, e.actor_id) : null,
    })),
    createdAt: op.created_at,
    acceptedAt: op.accepted_at,
    fundedAt: op.funded_at,
    closedAt: op.closed_at,
  }
}

export function serializeOrder(o: DepositRow) {
  return {
    id: o.id,
    amount: o.amount,
    rate: o.rate,
    amountBob: o.amount_bob,
    opId: o.op_id,
    paymentUrl: APP_URL + '/pago/' + o.id,
    txHash: o.tx_hash,
    reference: o.reference,
    status: o.status,
    expiresAt: o.expires_at,
    error: o.error,
  }
}
