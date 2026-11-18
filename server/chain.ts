import { StrKey } from '@stellar/stellar-sdk'
import { all, get, inTransaction, newId, now, run } from './db.ts'
import {
  HttpError, logEvent, opById, participants, push, trancheById, tranchesOf, userById,
  type ActionKind, type ChainTxRow, type DepositRow, type OpRow,
} from './domain.ts'
import { ADDRESSES, stroopsToCents, type AssetTransfer } from './stellar.ts'
import {
  buildDeploy, buildFund, findTransaction, findTransactionInHorizon, inspectEnvelope, readEscrow, readEscrowHistory, signService, submitEnvelope,
  submitProbeEnvelope,
} from './tw.ts'

type Receipt = Awaited<ReturnType<typeof findTransaction>>
type Evidence = { reqKey: string; fileId: string }
export type ActionData = { items?: Evidence[]; note?: string; reason?: string; amount?: number; instructionId?: string }

const queues = new Map<string, Promise<unknown>>()
export async function runExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(work)
  queues.set(key, current)
  try {
    return await current
  } finally {
    if (queues.get(key) === current) queues.delete(key)
  }
}

export function actionById(id: string) {
  return get<ChainTxRow>('SELECT * FROM chain_txs WHERE id = ?', id)
}

export function assertNoPending(trancheId: string) {
  if (get('SELECT 1 FROM chain_txs WHERE tranche_id = ? AND status = ?', trancheId, 'pending')) {
    throw new HttpError(409, 'Hay una acción confirmándose para esta condición. Espera un momento.')
  }
}

export function invalidateArmed(trancheId: string) {
  run("UPDATE chain_txs SET status = 'failed', error = ? WHERE tranche_id = ? AND status = 'armed'",
    'La condición cambió. Vuelve a iniciar la acción.', trancheId)
}

export function prepareAction(input: {
  kind: ActionKind
  xdr: string
  source: string
  userId?: string
  opId?: string
  trancheId?: string
  depositId?: string
  withdrawalId?: string
  data?: ActionData
}) {
  const envelope = inspectEnvelope(input.xdr)
  if (envelope.source !== input.source) throw new HttpError(502, 'La red preparó una acción para otra cuenta.')
  const existing = get<ChainTxRow>('SELECT * FROM chain_txs WHERE hash = ?', envelope.hash)
  if (existing && existing.kind === input.kind && existing.status === 'armed' &&
      existing.op_id === (input.opId ?? null) && existing.tranche_id === (input.trancheId ?? null) &&
      existing.created_by === (input.userId ?? null) && existing.payload_json === JSON.stringify(input.data ?? {})) return existing
  if (existing) throw new HttpError(409, 'Esta acción ya fue preparada. Inténtalo de nuevo.')
  const id = newId('tx')
  run(
    `INSERT INTO chain_txs (id, op_id, tranche_id, deposit_id, withdrawal_id, kind, xdr, source, expires_at, payload_json, status, hash, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'armed',?,?,?)`,
    id, input.opId ?? null, input.trancheId ?? null, input.depositId ?? null, input.withdrawalId ?? null,
    input.kind, input.xdr, input.source, envelope.expiresAt, JSON.stringify(input.data ?? {}),
    envelope.hash, input.userId ?? null, now(),
  )
  return actionById(id)!
}

function closeIfComplete(op: OpRow) {
  const settled = ['released', 'refunded', 'resolved']
  if (op.status === 'funded' && tranchesOf(op.id).every((t) => settled.includes(t.status))) {
    run("UPDATE operations SET status = 'closed', closed_at = ? WHERE id = ?", now(), op.id)
    logEvent(op, null, 'closed')
  }
}

function payoutFrom(op: OpRow, amount: number, transfers: AssetTransfer[]) {
  const sellerAddress = userById(op.seller_id)!.public_key
  const buyerAddress = userById(op.buyer_id!)!.public_key
  const sent = transfers.filter((transfer) => transfer.from === op.escrow_contract_id)
  const stroops = (to?: string) => sent
    .filter((transfer) => !to || transfer.to === to)
    .reduce((sum, transfer) => sum + BigInt(transfer.stroops ?? BigInt(transfer.cents) * 100_000n), 0n)
  const gross = stroops()
  if (gross !== BigInt(amount) * 100_000n) return undefined
  const seller = stroopsToCents(stroops(sellerAddress))
  const buyer = stroopsToCents(stroops(buyerAddress))
  return { seller, buyer, fees: amount - seller - buyer, gross: amount }
}

function savePayout(
  op: OpRow, tranche: NonNullable<ReturnType<typeof trancheById>>, kind: 'release' | 'resolve',
  payout: NonNullable<ReturnType<typeof payoutFrom>>, hash: string, actor: string | null, at: string, note?: string,
) {
  const status = kind === 'release' ? 'released' : payout.seller === 0 ? 'refunded' : 'resolved'
  run('UPDATE tranches SET status = ?, settled_at = ?, to_seller = ?, to_buyer = ?, fee = ?, tx_hash = ? WHERE id = ?',
    status, at, payout.seller, payout.buyer, payout.fees, hash, tranche.id)
  logEvent(op, actor, status, { tranche: tranche.idx + 1, toSeller: payout.seller, toBuyer: payout.buyer, fee: payout.fees, note }, hash)
}

async function applyReceipt(action: ChainTxRow, receipt: Receipt) {
  if (receipt.status === 'pending') return actionById(action.id)!
  const op = action.op_id ? opById(action.op_id) : undefined
  const tranche = action.tranche_id ? trancheById(action.tranche_id) : undefined
  const data: ActionData = JSON.parse(action.payload_json)
  const settlement = action.kind === 'release' || action.kind === 'resolve' ? action.kind : undefined
  let payout = receipt.status === 'confirmed' && op && tranche && settlement
    ? payoutFrom(op, tranche.amount, receipt.transfers ?? [])
    : undefined
  if (receipt.status === 'confirmed' && settlement && !payout && op && tranche) {
    const historical = await findTransactionInHorizon(action.hash)
    payout = payoutFrom(op, tranche.amount, historical.transfers ?? [])
    if (!payout) return actionById(action.id)!
    receipt = historical
  }
  if (receipt.status === 'confirmed' && action.kind === 'deploy' && !receipt.contractId) {
    const historical = await findTransactionInHorizon(action.hash)
    if (historical.contractId) receipt = historical
  }
  if (receipt.status === 'confirmed' && action.kind === 'deploy' &&
      (!receipt.contractId || !StrKey.isValidContract(receipt.contractId))) return actionById(action.id)!

  inTransaction(() => {
    const current = actionById(action.id)!
    if (current.status !== 'pending') return
    const at = now()
    if (receipt.status === 'failed') {
      const error = action.kind === 'probe' && receipt.ledger
        ? 'La red rechazó el intento. El dinero sigue protegido.'
        : receipt.error ?? 'Stellar no confirmó esta acción. Puedes volver a intentarlo.'
      run("UPDATE chain_txs SET status = 'failed', error = ?, ledger = ? WHERE id = ?", error, receipt.ledger ?? null, action.id)
      if (action.kind === 'deploy' && op) {
        run("UPDATE operations SET status = 'invited', deployment_error = ? WHERE id = ?", error, op.id)
      }
      if (action.deposit_id) run("UPDATE deposits SET status = 'failed', error = ? WHERE id = ?", error, action.deposit_id)
      if (action.withdrawal_id) run("UPDATE withdrawals SET status = 'failed' WHERE id = ?", action.withdrawal_id)
      if (op && action.kind === 'probe' && receipt.ledger) {
        logEvent(op, action.created_by, 'probe_rejected', { reason: error }, action.hash)
      }
      return
    }
    run("UPDATE chain_txs SET status = 'confirmed', confirmed_at = ?, ledger = ?, error = NULL WHERE id = ?",
      at, receipt.ledger ?? null, action.id)
    if (action.kind === 'deploy' && op) {
      run("UPDATE operations SET status = 'awaiting_deposit', accepted_at = ?, escrow_contract_id = ?, escrow_tx = ?, held_on_chain = 0, observed_at = ?, observed_ledger = ?, deployment_error = NULL WHERE id = ?",
        at, receipt.contractId!, action.hash, at, receipt.ledger ?? null, op.id)
      logEvent(op, action.created_by, 'accepted')
      logEvent(op, null, 'escrow_created', { contractId: receipt.contractId }, action.hash)
    } else if (action.kind === 'fund' && op && action.deposit_id) {
      const order = get<DepositRow>('SELECT * FROM deposits WHERE id = ?', action.deposit_id)!
      run("UPDATE deposits SET status = 'settled', tx_hash = ?, error = NULL WHERE id = ?", action.hash, order.id)
      run("UPDATE operations SET status = 'funded', funded_at = COALESCE(funded_at, ?) WHERE id = ?", at, op.id)
      if (receipt.ledger && receipt.ledger > (op.observed_ledger ?? 0)) {
        run(`UPDATE operations SET held_on_chain = COALESCE(held_on_chain, 0) + ?, observed_at = ?, observed_ledger = ?
             WHERE id = ? AND COALESCE(observed_ledger, 0) < ?`, order.amount, at, receipt.ledger, op.id, receipt.ledger)
      }
      run("UPDATE tranches SET status = 'pending' WHERE op_id = ? AND status = 'locked'", op.id)
      logEvent(op, order.user_id, 'funded', { amount: order.amount, amountBob: order.amount_bob, rate: order.rate }, action.hash)
    } else if (action.kind === 'withdraw' && action.withdrawal_id) {
      run("UPDATE withdrawals SET status = 'sent', tx_hash = ? WHERE id = ?", action.hash, action.withdrawal_id)
    } else if (op && tranche) {
      const details = { tranche: tranche.idx + 1 }
      if (action.kind === 'evidence') {
        run('UPDATE evidence SET is_current = 0 WHERE tranche_id = ? AND is_current = 1', tranche.id)
        for (const item of data.items ?? []) {
          run('INSERT INTO evidence (id, tranche_id, req_key, file_id, created_at, version_hash) VALUES (?,?,?,?,?,?)',
            newId('ev'), tranche.id, item.reqKey, item.fileId, at, action.hash)
        }
        run("UPDATE tranches SET status = 'submitted', evidence_note = ?, evidence_at = ?, objection = NULL, objected_at = NULL WHERE id = ?",
          data.note ?? null, at, tranche.id)
        logEvent(op, action.created_by, 'evidence_submitted', { ...details, documents: data.items?.length ?? 0 }, action.hash)
      } else if (action.kind === 'approve') {
        run("UPDATE tranches SET status = 'approved', approved_at = ? WHERE id = ?", at, tranche.id)
        logEvent(op, action.created_by, 'approved', details, action.hash)
      } else if (action.kind === 'refund') {
        run("UPDATE tranches SET status = 'refund_requested', refund_requested_at = ?, dispute_by = ? WHERE id = ?", at, action.created_by, tranche.id)
        logEvent(op, action.created_by, 'refund_requested', details, action.hash)
      } else if (action.kind === 'dispute') {
        run("UPDATE tranches SET status = 'disputed', dispute_reason = ?, dispute_by = ?, dispute_at = ? WHERE id = ?",
          data.reason ?? null, action.created_by, at, tranche.id)
        logEvent(op, action.created_by, 'dispute_opened', { ...details, reason: data.reason }, action.hash)
      } else if (payout && settlement && trancheById(tranche.id)?.tx_hash !== action.hash) {
        savePayout(op, tranche, settlement, payout, action.hash, action.created_by, at, data.note)
        if (receipt.ledger && receipt.ledger > (op.observed_ledger ?? 0)) {
          run(`UPDATE operations SET held_on_chain = MAX(0,COALESCE(held_on_chain,0) - ?), observed_at = ?, observed_ledger = ?
               WHERE id = ? AND COALESCE(observed_ledger, 0) < ?`, payout.gross, at, receipt.ledger, op.id, receipt.ledger)
        }
        closeIfComplete(op)
      }
    }
  })
  if (op) {
    push(participants(op), { type: 'op', id: op.id })
    if (payout) push(participants(op), { type: 'wallet' })
  } else if (action.created_by) push([action.created_by], { type: 'wallet' })
  return actionById(action.id)!
}

export async function refreshAction(action: ChainTxRow, retry = false) {
  if (action.status !== 'pending') return action
  return runExclusive('hash:' + action.hash, async () => {
    const current = actionById(action.id)!
    if (current.status !== 'pending') return current
    const receipt = await findTransaction(current.hash)
    if (receipt.status !== 'pending') return applyReceipt(current, receipt)
    if (current.expires_at !== null && current.expires_at + 75_000 < Date.now()) {
      return applyReceipt(current, { status: 'failed', error: 'La acción venció antes de confirmarse.' })
    }
    if (retry && current.signed_xdr && Date.now() - Date.parse(current.submitted_at!) > 10_000 &&
        (current.expires_at === null || current.expires_at > Date.now())) {
      run('UPDATE chain_txs SET submitted_at = ? WHERE id = ?', now(), current.id)
      return applyReceipt(current, await transmit(current, current.signed_xdr))
    }
    return current
  }).catch(() => actionById(action.id)!)
}

function verifySigned(action: ChainTxRow, signedXdr: string) {
  if (action.expires_at !== null && action.expires_at <= Date.now()) {
    run("UPDATE chain_txs SET status = 'failed', error = ? WHERE id = ?", 'La acción venció. Vuelve a iniciarla.', action.id)
    throw new HttpError(409, 'La confirmación venció. Vuelve a iniciar la acción.', { rearm: true })
  }
  let signed: ReturnType<typeof inspectEnvelope>
  try {
    signed = inspectEnvelope(signedXdr, action.source)
  } catch {
    throw new HttpError(400, 'La transacción firmada no es válida.')
  }
  if (signed.hash !== action.hash || signed.source !== action.source || !signed.hasSignature || signed.signatureCount !== 1) {
    throw new HttpError(400, 'La firma no corresponde a la acción que preparaste.')
  }
}

function persistSubmission(action: ChainTxRow, signedXdr: string) {
  verifySigned(action, signedXdr)
  if (action.kind === 'resolve' && action.op_id && opById(action.op_id)?.resolution_mode === 'esquora') {
    const { instructionId } = JSON.parse(action.payload_json) as ActionData
    const submitted = run(
      `UPDATE chain_txs SET status = 'pending', signed_xdr = ?, submitted_at = ? WHERE id = ? AND status = 'armed'
       AND EXISTS (SELECT 1 FROM resolution_instructions
         WHERE id = ? AND tranche_id = ? AND verified_at IS NOT NULL AND voided_at IS NULL)`,
      signedXdr, now(), action.id, instructionId ?? null, action.tranche_id,
    )
    if (!submitted.changes && actionById(action.id)?.status === 'armed') {
      throw new HttpError(409, 'La instrucción dejó de estar verificada. Vuelve a consultarla.')
    }
    return submitted
  }
  return run("UPDATE chain_txs SET status = 'pending', signed_xdr = ?, submitted_at = ? WHERE id = ? AND status = 'armed'",
    signedXdr, now(), action.id)
}

async function sendPersisted(action: ChainTxRow, signedXdr: string) {
  if (action.op_id) {
    const op = opById(action.op_id)!
    push(participants(op), { type: 'op', id: op.id })
  }
  try {
    return applyReceipt(action, await transmit(action, signedXdr))
  } catch {
    return refreshAction(actionById(action.id)!)
  }
}

function transmit(action: ChainTxRow, signedXdr: string) {
  return action.kind === 'probe' ? submitProbeEnvelope(signedXdr) : submitEnvelope(signedXdr)
}

export async function submitAction(action: ChainTxRow, signedXdr: string) {
  if (action.status !== 'armed') return refreshAction(action)
  if (!persistSubmission(action, signedXdr).changes) return refreshAction(actionById(action.id)!)
  return sendPersisted(action, signedXdr)
}

async function serviceReady(address: string) {
  const pending = get<ChainTxRow>("SELECT * FROM chain_txs WHERE source = ? AND status = 'pending' ORDER BY created_at LIMIT 1", address)
  if (pending && (await refreshAction(pending, true)).status === 'pending') {
    throw new HttpError(409, 'Hay un movimiento confirmándose. Inténtalo en unos segundos.')
  }
}

export function deployOperation(op: OpRow, actorId: string, signature: string) {
  return runExclusive('service:platform', async () => {
    const resolver = op.arbiter_id ? userById(op.arbiter_id) : null
    if (!resolver) throw new HttpError(409, 'Designa un tercero antes de activar la protección.')
    await serviceReady(ADDRESSES.platform)
    const project = get<{ name: string }>('SELECT name FROM projects WHERE id = ?', op.project_id)!
    const xdr = await buildDeploy({
      engagementId: op.code, title: project.name + ' · ' + op.unit,
      description: 'ESQUORA' + (op.contract_sha256 ? ' | contrato sha256:' + op.contract_sha256 : '') + ' | acuerdo sha256:' + op.terms_digest,
      buyer: userById(op.buyer_id!)!.public_key, seller: userById(op.seller_id)!.public_key, arbiter: resolver.public_key,
      feeBps: op.fee_bps, tranches: tranchesOf(op.id).map((t) => ({ title: t.title, amount: t.amount })),
    })
    const signed = signService(xdr, 'platform')
    const action = inTransaction(() => {
      const row = prepareAction({ kind: 'deploy', xdr, source: ADDRESSES.platform, opId: op.id, userId: actorId })
      persistSubmission(row, signed)
      run("UPDATE operations SET buyer_sig = ?, status = 'deploying', deployment_error = NULL WHERE id = ?", signature, op.id)
      return row
    })
    return sendPersisted(action, signed)
  })
}

export function payOrder(op: OpRow, order: DepositRow) {
  return runExclusive('service:anchor', async () => {
    await serviceReady(ADDRESSES.anchor)
    const xdr = await buildFund(op.escrow_contract_id!, order.amount)
    const signed = signService(xdr, 'anchor')
    const action = inTransaction(() => {
      const row = prepareAction({ kind: 'fund', xdr, source: ADDRESSES.anchor, opId: op.id, depositId: order.id, userId: order.user_id })
      persistSubmission(row, signed)
      run("UPDATE deposits SET status = 'paid', paid_at = ?, tx_hash = ?, error = NULL WHERE id = ?", now(), row.hash, order.id)
      return row
    })
    return sendPersisted(action, signed)
  })
}

async function reconcileOperation(id: string) {
  const pending = all<ChainTxRow>("SELECT * FROM chain_txs WHERE op_id = ? AND status = 'pending' ORDER BY created_at", id)
  for (const action of pending) await refreshAction(action, true)
  const op = opById(id)!
  if (!op.escrow_contract_id) return
  const snapshot = await readEscrow(op.escrow_contract_id).catch(() => undefined)
  if (!snapshot || snapshot.ledger < (op.observed_ledger ?? 0)) return
  const tranches = tranchesOf(op.id)
  const missed = tranches.some((tranche) => !tranche.tx_hash &&
    (snapshot.milestones[tranche.idx]?.released || snapshot.milestones[tranche.idx]?.resolved))
  const settlements = missed ? await readEscrowHistory(op.escrow_contract_id).catch(() => []) : []
  const at = now()
  inTransaction(() => {
    if (!run(`UPDATE operations SET held_on_chain = ?, observed_at = ?, observed_ledger = ?
              WHERE id = ? AND COALESCE(observed_ledger, 0) <= ?`, snapshot.held, at, snapshot.ledger, op.id, snapshot.ledger).changes) return
    if (op.status === 'awaiting_deposit' && snapshot.held >= op.deposit) {
      run("UPDATE operations SET status = 'funded', funded_at = COALESCE(funded_at,?) WHERE id = ?", at, op.id)
      run("UPDATE tranches SET status = 'pending' WHERE op_id = ? AND status = 'locked'", op.id)
      logEvent(op, null, 'funded', { amount: snapshot.held })
    }
    for (const tranche of tranches) {
      const chain = snapshot.milestones[tranche.idx]
      const current = trancheById(tranche.id)!
      if (!chain || ['released', 'resolved', 'refunded'].includes(current.status)) continue
      if (get("SELECT 1 FROM chain_txs WHERE tranche_id = ? AND status = 'pending'", tranche.id)) continue
      if ((chain.released || chain.resolved) && !tranche.tx_hash) {
        const receipt = settlements.find((entry) => entry.index === tranche.idx)
        const payout = receipt && payoutFrom(op, tranche.amount, receipt.transfers)
        if (receipt && payout) savePayout(op, tranche, receipt.kind, payout, receipt.hash, null, at)
        continue
      }
      if (chain.disputed && !['disputed', 'refund_requested'].includes(tranche.status)) {
        invalidateArmed(tranche.id)
        run("UPDATE tranches SET status = 'disputed', dispute_at = ? WHERE id = ?", at, tranche.id)
        logEvent(op, null, 'dispute_opened', { tranche: tranche.idx + 1 })
      } else if (chain.approved && !chain.disputed && ['pending', 'submitted', 'objected'].includes(tranche.status)) {
        invalidateArmed(tranche.id)
        run("UPDATE tranches SET status = 'approved', approved_at = ? WHERE id = ?", at, tranche.id)
        logEvent(op, null, 'approved', { tranche: tranche.idx + 1 })
      }
    }
    closeIfComplete(opById(op.id)!)
  })
  return snapshot
}

export async function syncOperation(id: string) {
  return runExclusive('op:' + id, () => reconcileOperation(id))
}

export async function recoverPending() {
  const ops = all<{ id: string }>("SELECT id FROM operations WHERE escrow_contract_id IS NOT NULL OR status = 'deploying'")
  for (const op of ops) await syncOperation(op.id).catch(() => undefined)
  await reconcileQueue()
}

let checkingQueue = false
export async function reconcileQueue() {
  if (checkingQueue) return
  checkingQueue = true
  try {
    const operations = all<{ id: string }>("SELECT DISTINCT op_id AS id FROM chain_txs WHERE op_id IS NOT NULL AND status = 'pending'")
    for (const op of operations) await syncOperation(op.id).catch(() => undefined)
    const withdrawals = all<ChainTxRow>("SELECT * FROM chain_txs WHERE op_id IS NULL AND status = 'pending'")
    for (const tx of withdrawals) await refreshAction(tx, true)
  } finally {
    checkingQueue = false
  }
}
