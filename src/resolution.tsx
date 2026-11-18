import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { read, readAccessLost, uploadFile, write, type FileInfo, type Operation, type Tranche } from './api.ts'
import { amountInCents, money } from './model.ts'
import { ReconnectLink, useAgreementSignature, useSigningAvailable, type ActionPrompt } from './signing.tsx'
import { Feedback, Field, FileRow, Loading, Submit, useWork } from './ui.tsx'
import './resolution.css'

type Instruction = {
  id: string
  kind: 'mutual' | 'external'
  toBuyer: number
  toSeller: number
  file: FileInfo | null
  explanation: string
  digest: string
  buyerSigned: boolean
  sellerSigned: boolean
  verificationNote: string | null
  verifiedAt: string | null
}

type ResolutionCase = { instruction: Instruction | null; objection: { id: number; reason: string } | null }

export function ResolutionInstruction({ operation, tranche, locked, onReady }: {
  operation: Operation
  tranche: Tranche
  locked: boolean
  onReady: (prompt: ActionPrompt) => void
}) {
  const path = '/tranches/' + encodeURIComponent(tranche.id) + '/resolution-instruction'
  const current = read<ResolutionCase>(path)
  const query = useQueryClient()
  const task = useWork()
  const sign = useAgreementSignature()
  const canSign = useSigningAvailable()
  const [kind, setKind] = useState('')
  const [objectingId, setObjectingId] = useState<string | null>(null)
  const [attestedId, setAttestedId] = useState<string | null>(null)
  const { role } = operation
  const editable = operation.status === 'funded' && !locked && (tranche.status === 'disputed' ||
    (tranche.status === 'refund_requested' && (!!tranche.refundResponse || tranche.refundWindowPassed)))
  const agreedRefund = tranche.refundResponse === 'accepted'
  const instruction = current.data?.instruction
  const attested = !!instruction && attestedId === instruction.id
  const signed = role === 'buyer' ? instruction?.buyerSigned : instruction?.sellerSigned
  const objection = current.data?.objection

  async function update(body: Record<string, unknown>) {
    const result = await write<ResolutionCase>(path, body)
    query.setQueryData([path], result)
    void query.invalidateQueries({ queryKey: ['/ops/' + operation.id] })
  }

  if (current.isPending) return <Loading>Consultando la instrucción…</Loading>
  if (!current.data || readAccessLost(current.error)) return <Feedback error={current.error} onRetry={() => void current.refetch()} />
  if (!instruction && !editable) return null

  return <div className="resolution-instruction stack">
    <h3>Instrucción para ESQUORA</h3>
    {objection && <p><strong>Última objeción. </strong>{objection.reason}</p>}
    {!instruction && <>
      <p>Presenta el reparto acordado o la resolución emitida por la instancia prevista en el acuerdo.</p>
      {role === 'arbiter' ? <p>Las partes aún deben presentar la instrucción.</p> :
        <form className="stack" onSubmit={task.submit(async (data) => {
          const toBuyer = agreedRefund ? tranche.amount : amountInCents(String(data.get('buyerShare')), true)
          if (toBuyer > tranche.amount) throw new Error('El importe supera el total protegido de este tramo.')
          const document = data.get('resolutionFile')
          const file = document instanceof File && document.size > 0 ? await uploadFile(document) : null
          await update({ action: 'submit', kind, toBuyer, fileId: file?.id,
            explanation: data.get('explanation'), authorityReference: data.get('authorityReference') })
        })}>
          <Field label="Origen de la instrucción"><select required value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">Selecciona una opción</option>
            <option value="mutual">Acuerdo entre comprador y desarrollador</option>
            <option value="external">Resolución de una instancia externa</option>
          </select></Field>
          {agreedRefund ? <p>Devolución acordada antes de comisiones · <strong>{money(tranche.amount)}</strong></p> :
            <Field label="Importe para el comprador (USD)" help="El resto corresponde al desarrollador. Escribe 0 si recibe todo el desarrollador.">
              <input name="buyerShare" inputMode="decimal" required />
            </Field>}
          <Field label="Instrucción y referencia de la resolución"><textarea name="explanation" required maxLength={1200} /></Field>
          {kind === 'external' && !operation.contractSha256 && <Field label="Referencia a la designación de la instancia"
            help="Indica dónde acordaron por escrito qué instancia emitiría la resolución.">
            <textarea name="authorityReference" required maxLength={600} />
          </Field>}
          <Field label={kind === 'external' ? 'Documento de la resolución' : 'Documento de respaldo (opcional)'}>
            <input name="resolutionFile" type="file" accept=".pdf,.jpg,.jpeg,.png" required={kind === 'external'} />
          </Field>
          <Submit waiting={task.busy}>Presentar para revisión</Submit>
        </form>}
    </>}
    {instruction && <>
      <p><strong>{instruction.kind === 'mutual' ? 'Acuerdo entre las partes' : 'Resolución externa'}</strong></p>
      <p>{instruction.explanation}</p>
      {instruction.file && <FileRow file={instruction.file} />}
      <dl className="details">
        <div><dt>Comprador antes de comisiones</dt><dd>{money(instruction.toBuyer)}</dd></div>
        <div><dt>Desarrollador antes de comisiones</dt><dd>{money(instruction.toSeller)}</dd></div>
        {instruction.kind === 'mutual' && <>
          <div><dt>Firma del comprador</dt><dd>{instruction.buyerSigned ? 'Confirmada' : 'Pendiente'}</dd></div>
          <div><dt>Firma del desarrollador</dt><dd>{instruction.sellerSigned ? 'Confirmada' : 'Pendiente'}</dd></div>
        </>}
        <div><dt>Verificación de ESQUORA</dt><dd>{instruction.verifiedAt ? 'Verificada' : 'Pendiente'}</dd></div>
      </dl>
      {instruction.verificationNote && <p>{instruction.verificationNote}</p>}
      {editable && role !== 'arbiter' && instruction.kind === 'mutual' && !signed &&
        (canSign ? <button className="button primary" type="button" disabled={task.busy} onClick={() => void task.run(async () => {
          const signature = await sign(instruction.digest)
          await update({ action: 'sign', instructionId: instruction.id, signature })
        })}>Firmar este reparto<ArrowRight size={18} aria-hidden="true" /></button> : <ReconnectLink />)}
      {editable && role === 'arbiter' && !instruction.verifiedAt && (instruction.kind === 'external' || (instruction.buyerSigned && instruction.sellerSigned)) &&
        <form key={instruction.id} className="stack" onSubmit={task.submit(async (data) => {
          await update({ action: 'verify', instructionId: instruction.id, attested, note: data.get('note'),
            objectionId: objection?.id, objectionClarification: data.get('objectionClarification') })
          setAttestedId(null)
        })}>
          <label className="resolution-attestation">
            <input type="checkbox" required checked={attested} onChange={(event) => setAttestedId(event.target.checked ? instruction.id : null)} />
            <span>Verifiqué la autenticidad, vigencia y alcance de la instrucción. El tramo y el reparto coinciden con lo documentado.</span>
          </label>
          <Field label="Registro de la verificación"><textarea name="note" required maxLength={1200} /></Field>
          {objection && <Field label="Cómo se aclaró la objeción"><textarea name="objectionClarification" required maxLength={1200} /></Field>}
          <Submit waiting={task.busy} disabled={!attested}>Registrar verificación</Submit>
        </form>}
      {editable && role === 'arbiter' && instruction.verifiedAt &&
        (canSign ? <button className="button primary" type="button" disabled={task.busy} onClick={() => onReady({
          input: { kind: 'resolve', trancheId: tranche.id, instructionId: instruction.id },
          title: 'Ejecutar el reparto verificado',
          detail: 'Importes antes de comisiones. Comprador ' + money(instruction.toBuyer) + '. Desarrollador ' + money(instruction.toSeller) + '.',
          complete: 'Reparto confirmado.',
        })}>Ejecutar reparto verificado<ArrowRight size={18} aria-hidden="true" /></button> : <ReconnectLink />)}
      {editable && (objectingId === instruction.id ? <form key={instruction.id} className="stack" onSubmit={task.submit(async (data) => {
        await update({ action: 'object', instructionId: instruction.id, note: data.get('reason') })
        setObjectingId(null)
        setAttestedId(null)
      })}>
        <Field label="Motivo de la observación"><textarea name="reason" required maxLength={1200} /></Field>
        <Submit waiting={task.busy}>Volver a dejar el reparto pendiente</Submit>
        <button type="button" className="text-button" onClick={() => setObjectingId(null)}>Conservar la instrucción</button>
      </form> : <button type="button" className="text-button" disabled={task.busy} onClick={() => setObjectingId(instruction.id)}>
        Objetar la instrucción
      </button>)}
    </>}
    <Feedback error={task.error} />
  </div>
}
