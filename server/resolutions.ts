import { createHash } from 'node:crypto'
import { db, get, newId, now, run } from './db.ts'
import { fileMeta, HttpError, logEvent, refundWindowPassed, roleOf, type OpRow, type TrancheRow, type UserRow } from './domain.ts'
import { verifyAgreementSignature } from './pollar.ts'

db.exec(`
CREATE TABLE IF NOT EXISTS resolution_instructions (
  id TEXT PRIMARY KEY,
  tranche_id TEXT NOT NULL REFERENCES tranches(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('mutual','external')),
  to_buyer INTEGER NOT NULL,
  to_seller INTEGER NOT NULL,
  file_id TEXT REFERENCES files(id),
  explanation TEXT NOT NULL,
  digest TEXT NOT NULL,
  buyer_signature TEXT,
  seller_signature TEXT,
  verification_note TEXT,
  verified_at TEXT,
  voided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_resolution_instruction
  ON resolution_instructions(tranche_id) WHERE voided_at IS NULL;
`)

type Instruction = {
  id: string
  tranche_id: string
  author_id: string
  kind: 'mutual' | 'external'
  to_buyer: number
  to_seller: number
  file_id: string | null
  explanation: string
  digest: string
  buyer_signature: string | null
  seller_signature: string | null
  verification_note: string | null
  verified_at: string | null
}

export function getResolutionInstruction(trancheId: string) {
  return get<Instruction>('SELECT * FROM resolution_instructions WHERE tranche_id = ? AND voided_at IS NULL', trancheId)
}

export function publicResolutionInstruction(instruction?: Instruction) {
  if (!instruction) return null
  return {
    id: instruction.id,
    kind: instruction.kind,
    toBuyer: instruction.to_buyer,
    toSeller: instruction.to_seller,
    file: instruction.file_id ? fileMeta(instruction.file_id) : null,
    explanation: instruction.explanation,
    digest: instruction.digest,
    buyerSigned: !!instruction.buyer_signature,
    sellerSigned: !!instruction.seller_signature,
    verificationNote: instruction.verification_note,
    verifiedAt: instruction.verified_at,
  }
}

function latestObjection(opId: string, trancheId: string) {
  return get<{ id: number; reason: string }>(
    `SELECT id, json_extract(data_json, '$.reason') AS reason FROM events
     WHERE op_id = ? AND type = 'resolution_objected' AND json_extract(data_json, '$.trancheId') = ?
     ORDER BY id DESC LIMIT 1`, opId, trancheId,
  )
}

export function readResolutionCase(op: OpRow, tranche: TrancheRow) {
  return {
    instruction: publicResolutionInstruction(getResolutionInstruction(tranche.id)),
    objection: latestObjection(op.id, tranche.id) ?? null,
  }
}

export function isResolutionReady(op: OpRow, tranche: TrancheRow) {
  return op.status === 'funded' && (tranche.status === 'disputed' ||
    (tranche.status === 'refund_requested' && (!!tranche.refund_response || refundWindowPassed(op, tranche))))
}

export function submitResolutionInstruction(op: OpRow, tranche: TrancheRow, user: UserRow, body: Record<string, unknown>) {
  const role = roleOf(op, user.id)
  if (role !== 'seller' && role !== 'buyer') throw new HttpError(403, 'Las partes deben presentar la instrucción.')
  if (getResolutionInstruction(tranche.id)) throw new HttpError(409, 'Ya hay una instrucción en revisión para este tramo.')
  const kind = body.kind
  if (kind !== 'mutual' && kind !== 'external') throw new HttpError(400, 'Elige el origen de la instrucción.')
  const toBuyer = body.toBuyer
  if (typeof toBuyer !== 'number' || !Number.isSafeInteger(toBuyer) || toBuyer < 0 || toBuyer > tranche.amount) {
    throw new HttpError(400, 'El importe del comprador debe estar entre cero y el total del tramo.')
  }
  if (tranche.refund_response === 'accepted' && toBuyer !== tranche.amount) {
    throw new HttpError(400, 'La devolución aceptada debe cubrir el importe íntegro del tramo.')
  }
  const submittedExplanation = typeof body.explanation === 'string' ? body.explanation.trim() : ''
  if (!submittedExplanation || submittedExplanation.length > 1200) throw new HttpError(400, 'Describe la instrucción y la referencia de la resolución.')
  const fileId = typeof body.fileId === 'string' && body.fileId.length <= 80 ? body.fileId : null
  const file = fileId ? get<{ id: string; sha256: string; mime: string }>(
    'SELECT id, sha256, mime FROM files WHERE id = ? AND uploaded_by = ? AND size > 0', fileId, user.id,
  ) : undefined
  if ((fileId && !file) || (file && !['application/pdf', 'image/jpeg', 'image/png'].includes(file.mime))) {
    throw new HttpError(400, 'Adjunta un PDF o una imagen de la resolución.')
  }
  if (kind === 'external' && !file) throw new HttpError(400, 'Adjunta la resolución externa antes de continuar.')
  const authority = typeof body.authorityReference === 'string' ? body.authorityReference.trim() : ''
  if (kind === 'external' && !op.contract_file_id && (!authority || authority.length > 600)) {
    throw new HttpError(400, 'Indica dónde se documentó la designación de la instancia externa.')
  }
  const explanation = kind === 'external' && !op.contract_file_id ?
    submittedExplanation + '\n\nDesignación de la instancia. ' + authority : submittedExplanation
  const id = newId('res')
  const toSeller = tranche.amount - toBuyer
  const digest = createHash('sha256').update(JSON.stringify({
    tipo: 'instruccion-resolucion-esquora-v1', id, acuerdo: op.terms_digest, tramo: tranche.id,
    kind, toBuyer, toSeller, explanation, documentoSha256: file?.sha256 ?? null,
  })).digest('hex')
  run(`INSERT INTO resolution_instructions
    (id,tranche_id,author_id,kind,to_buyer,to_seller,file_id,explanation,digest,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  id, tranche.id, user.id, kind, toBuyer, toSeller, file?.id ?? null, explanation, digest, now())
  logEvent(op, user.id, 'resolution_proposed', { trancheId: tranche.id })
}

export function changeResolutionInstruction(op: OpRow, tranche: TrancheRow, user: UserRow, body: Record<string, unknown>) {
  const role = roleOf(op, user.id)
  const instruction = getResolutionInstruction(tranche.id)
  if (!instruction || instruction.id !== body.instructionId) throw new HttpError(409, 'La instrucción cambió. Vuelve a consultarla.')
  const action = body.action
  if (action === 'sign') {
    if ((role !== 'buyer' && role !== 'seller') || instruction.kind !== 'mutual' || instruction.verified_at) {
      throw new HttpError(409, 'Esta instrucción no acepta tu firma.')
    }
    const signature = typeof body.signature === 'string' && body.signature.length <= 200 ? body.signature : ''
    if (!signature || !verifyAgreementSignature(instruction.digest, user.public_key, signature)) {
      throw new HttpError(400, 'La firma no corresponde a esta instrucción.')
    }
    const column = role === 'buyer' ? 'buyer_signature' : 'seller_signature'
    if (run('UPDATE resolution_instructions SET ' + column + ' = ? WHERE id = ? AND ' + column + ' IS NULL',
      signature, instruction.id).changes) logEvent(op, user.id, 'resolution_signed', { trancheId: tranche.id })
    return
  }
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  if (!note || note.length > 1200) throw new HttpError(400, 'Indica el resultado de tu revisión.')
  if (action === 'object') {
    run('UPDATE resolution_instructions SET voided_at = ? WHERE id = ?', now(), instruction.id)
    logEvent(op, user.id, 'resolution_objected', { trancheId: tranche.id, instructionId: instruction.id, reason: note })
    return
  }
  if (action !== 'verify' || role !== 'arbiter' || instruction.verified_at || body.attested !== true) {
    throw new HttpError(409, 'Solo el equipo designado puede verificar esta instrucción.')
  }
  if (instruction.kind === 'mutual' && (!instruction.buyer_signature || !instruction.seller_signature)) {
    throw new HttpError(409, 'Falta la firma de una de las partes.')
  }
  const objection = latestObjection(op.id, tranche.id)
  const clarification = typeof body.objectionClarification === 'string' ? body.objectionClarification.trim() : ''
  if (objection && (objection.id !== body.objectionId || !clarification || clarification.length > 1200)) {
    throw new HttpError(409, 'Documenta cómo quedó aclarada la última objeción antes de verificar.')
  }
  const verification = objection ? note + '\n\nAclaración de la objeción. ' + clarification : note
  run('UPDATE resolution_instructions SET verified_at = ?, verification_note = ? WHERE id = ?', now(), verification, instruction.id)
  logEvent(op, user.id, 'resolution_verified', { trancheId: tranche.id, instructionId: instruction.id, objectionId: objection?.id })
}
