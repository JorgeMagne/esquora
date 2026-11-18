import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, Copy } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  conditionPath, invitationPath, operationPath, paymentPath, read, readOperation, uploadFile, write,
  type ActionInput, type DepositOrder, type Evidence, type Operation, type ProjectDetail, type Tranche,
} from './api.ts'
import { amountInCents, conditionAmounts, conditionLabels, formatDate, money, nextConditionAction, numberAmount, operationLabels, requirementGuide, towerStage, trancheNet } from './model.ts'
import { useSession } from './session.tsx'
import { ReconnectLink, useAgreementSignature, useChainAction, useSigningAvailable } from './signing.tsx'
import type { ActionPrompt } from './signing.tsx'
import { ActionLink, Amount, Back, Dialog, ExplorerLink, Feedback, Field, FileRow, Loading, Submit, Title, TotalsStrip, Tower, useWork } from './ui.tsx'

function conditionState(tranche: Tranche) {
  if (tranche.pendingAction?.status === 'pending') return 'Confirmando'
  if (tranche.overdue && ['pending', 'objected'].includes(tranche.status)) return 'Plazo vencido'
  if (tranche.status === 'resolved') {
    const { state } = conditionAmounts(tranche)
    if (state === 'delivered') return 'Resuelta · entregada'
    if (state === 'returned') return 'Resuelta · devuelta'
  }
  return conditionLabels[tranche.status] ?? 'Por revisar'
}

function conditionButton(operation: Operation, tranche: Tranche) {
  const action = nextConditionAction(operation.role, tranche)
  if (action === 'evidence') return 'Presentar documentos'
  if (action === 'approve') return tranche.idx === 1 ? 'Revisar inicio de obra' : 'Revisar documentos'
  if (action === 'release') return 'Recibir pago aprobado'
  if (action === 'refund') return 'Pedir devolución'
  if (action === 'refund-response') return 'Responder devolución'
  if (action === 'resolve') return 'Revisar el caso'
  return null
}

export function OperationPage() {
  const { id = '' } = useParams()
  const query = readOperation(id)
  if (query.isPending) return <Loading>Abriendo la operación…</Loading>
  if (query.isError) return <Feedback error={query.error} onRetry={() => void query.refetch()} />
  if (!['funded', 'closed'].includes(query.data.status)) return <Agreement operation={query.data} />
  return <Purchase operation={query.data} />
}

export function AgreementPage() {
  const { id = '' } = useParams()
  const operation = readOperation(id)
  if (operation.isPending) return <Loading>Abriendo el acuerdo…</Loading>
  if (operation.isError) return <Feedback error={operation.error} onRetry={() => void operation.refetch()} />
  return <Agreement operation={operation.data} fromOperation />
}

function Purchase({ operation }: { operation: Operation }) {
  const { id, project, unit, tranches, totals, deposit, role } = operation
  const next = tranches.find((tranche) => tranche.pendingAction?.status !== 'pending' && conditionButton(operation, tranche))
  const approved = role === 'buyer' && tranches.some((tranche) => tranche.status === 'approved')
  const confirming = tranches.some((tranche) => tranche.pendingAction?.status === 'pending')
  return <article className="purchase">
    <div className="purchase-hero">
      <div className="purchase-subject">
        <h1>{role === 'buyer' ? unit : role === 'arbiter' ? 'Caso ' + unit : unit}</h1>
        <p className="purchase-location">{operation.unitDetail || project.name}<span>{operation.unitDetail ? project.name : project.city}</span></p>
        <div className="purchase-money">
          <Amount cents={totals.held} />
          <p className="protected-label">protegidos</p>
          <p className="muted">de {numberAmount(deposit)} de cuota inicial</p>
        </div>
      </div>
      <figure className="purchase-figure">
        <Tower unit={unit} stage={towerStage(tranches)} />
        <figcaption>Corte ilustrativo</figcaption>
      </figure>
    </div>
    <div className="condition-meter" role="img" aria-label={tranches.map((tranche) => tranche.title + ', ' + conditionState(tranche)).join('. ')}>
      {tranches.map((tranche) => <i className={'swatch ' + conditionAmounts(tranche).state} key={tranche.id} style={{ flexGrow: tranche.amount }} />)}
    </div>
    <ul className="condition-list" aria-label="Condiciones">
      {tranches.map((tranche) => {
        const amounts = conditionAmounts(tranche)
        return <li key={tranche.id}><Link className="condition-row" to={conditionPath(id, tranche.id)}>
        <i className={'swatch ' + amounts.state} aria-hidden="true" />
        <span><strong>{tranche.title}</strong><small>{conditionState(tranche)}
          {tranche.settledAt ? ' · ' + formatDate(tranche.settledAt) :
            !['released', 'refunded', 'resolved'].includes(tranche.status) && !tranche.overdue && ' · vence ' + formatDate(tranche.dueAt)}</small></span>
        {amounts.state === 'shared' ? <span className="condition-split">
          <span><b>{money(amounts.seller)}</b> <small>entregado</small></span>
          <span><b>{money(amounts.buyer)}</b> <small>devuelto</small></span>
        </span> : <b>{money(amounts.amount)}</b>}
      </Link></li>})}
    </ul>
    <div className="purchase-below">
      <TotalsStrip totals={totals} />
      {approved && <Feedback>Listo. El desarrollador ya puede recibir el pago.</Feedback>}
      {confirming && <Loading>Confirmando…</Loading>}
      {!confirming && !approved && !next && operation.todo && <p className="muted">{operation.todo}</p>}
      <div className="record-links">
        <Link className="text-link" to={operationPath(id) + '/acuerdo'}>Ver acuerdo</Link>
        {role !== 'buyer' && <Link className="text-link" to={operationPath(id) + '/comprobantes'}>Ver comprobantes</Link>}
        <Link className="text-link" to={operationPath(id) + '/verificacion'}>Comprobar en el registro público</Link>
      </div>
    </div>
    {next && <ActionLink fixed to={conditionPath(id, next.id)}>{conditionButton(operation, next)}</ActionLink>}
  </article>
}

function Agreement({ operation, fromOperation = false }: { operation: Operation; fromOperation?: boolean }) {
  const { id, role, status, deposit, project, seller, buyerName, arbiter, contract, tranches } = operation
  const query = useQueryClient()
  const navigate = useNavigate()
  const signAgreement = useAgreementSignature()
  const canSign = useSigningAvailable()
  const user = useSession().data?.user
  const task = useWork()
  const [dialog, setDialog] = useState<'accept' | 'send' | 'cancel' | 'decline' | null>(null)
  const [copied, setCopied] = useState(false)
  const [note, setNote] = useState('')
  const route = '/ops/' + id
  const canAccept = role === 'buyer' && status === 'invited'
  const canSend = role === 'seller' && status === 'draft'
  const inviteUrl = operation.inviteToken && new URL(invitationPath(operation.inviteToken), window.location.origin).href
  const costs = tranches.reduce((total, tranche) => {
    const cost = trancheNet(tranche.amount, operation.feeBps)
    return { platform: total.platform + cost.platform, provider: total.provider + cost.provider }
  }, { platform: 0, provider: 0 })

  async function refresh() {
    await query.invalidateQueries({ predicate: ({ queryKey }) => queryKey[0] === route || queryKey[0] === '/ops' || String(queryKey[0]).startsWith('/projects') })
  }

  async function saveAgreement(action: 'accept' | 'send' | 'cancel' | 'decline') {
    const body = action === 'accept' || action === 'send' ? { signature: await signAgreement(operation.termsDigest) } :
      action === 'decline' ? { reason: note } : {}
    const updated = await write<Operation>(route + '/' + action, body)
    query.setQueryData([route], updated)
    await refresh()
  }

  return <>
    <Back to={fromOperation ? operationPath(id) : '/'}>{fromOperation ? 'Volver a la operación' : 'Operaciones'}</Back>
    <Title detail={project.name + ' · ' + operation.unit}>{status === 'awaiting_deposit' ? 'Cuota inicial' : 'Acuerdo de preventa'}</Title>
    <div className="two-column">
      <div>
        <section className="section">
          <h2>Acuerdo</h2>
          <dl className="details">
            <div><dt>Estado</dt><dd>{operationLabels[status] ?? 'Por revisar'}</dd></div>
            {operation.unitDetail && <div><dt>Unidad</dt><dd>{operation.unitDetail}</dd></div>}
            <div><dt>Desarrollador</dt><dd>{seller.orgName ?? seller.name}</dd></div>
            <div><dt>Comprador</dt><dd>{buyerName}</dd></div>
            <div><dt>Precio del inmueble</dt><dd>{money(operation.price)}</dd></div>
            <div><dt>Cuota inicial</dt><dd>{money(deposit)}</dd></div>
            <div><dt>Tercero designado</dt><dd>{arbiter.orgName ?? arbiter.name}</dd></div>
            <div><dt>Plazo para responder una devolución</dt><dd>{operation.refundResponseHours < 1 ?
              Math.round(operation.refundResponseHours * 60) + ' min' : operation.refundResponseHours + ' h'}</dd></div>
          </dl>
          {contract && <FileRow file={contract} label="Descargar el contrato" detail={contract.name} />}
        </section>
        <section className="section">
          <h2>Condiciones</h2>
          {tranches.map((tranche) => <details className="disclosure" key={tranche.id}>
            <summary><span>{tranche.title}</span><b>{money(tranche.amount)}</b></summary>
            <p>{tranche.condition}</p><p className="muted">Hasta el {formatDate(tranche.dueAt, true)} (Bolivia)</p>
            <ul className="plain-list">{tranche.requirements.map((requirement) => <li key={requirement.key}>{requirement.label}</li>)}</ul>
          </details>)}
        </section>
      </div>
      <section className="section">
        <h2>Cuota inicial protegida</h2>
        <Amount cents={deposit} />
        <dl className="details">
          <div><dt>Comisión de ESQUORA</dt><dd>{money(costs.platform)}</dd></div>
          <div><dt>Comisión de la red de protección</dt><dd>{money(costs.provider)}</dd></div>
        </dl>
        <p className="muted">Las comisiones se descuentan cuando se entrega o se devuelve cada tramo.</p>
        <Feedback error={task.error || (operation.deploymentError ? 'No pudimos registrar la protección. Vuelve a confirmar el acuerdo.' : null)}>
          {operation.declineReason && 'Motivo del rechazo: ' + operation.declineReason}
        </Feedback>
        {status === 'deploying' && <Loading>Confirmando el acuerdo…</Loading>}
        {operation.depositOrder?.status === 'paid' && <Loading>Confirmando el depósito…</Loading>}
        {canAccept && user?.walletStatus !== 'active' && <ActionLink to={'/cuenta?volver=' + encodeURIComponent(operationPath(id))}>Activar mi cuenta</ActionLink>}
        {(canSend || (canAccept && user?.walletStatus === 'active')) && (canSign ?
          <button className="button primary" type="button" disabled={task.busy} onClick={() => setDialog(canSend ? 'send' : 'accept')}>
            {task.busy ? 'Confirmando…' : canSend ? 'Enviar invitación' : 'Aceptar acuerdo'}<ArrowRight size={18} aria-hidden="true" />
          </button> : <ReconnectLink />)}
        {canAccept && <button className="text-button" type="button" disabled={task.busy} onClick={() => setDialog('decline')}>Rechazar acuerdo</button>}
        {role === 'buyer' && status === 'awaiting_deposit' && operation.depositOrder?.status !== 'paid' && <button className="button primary" type="button" disabled={task.busy}
          onClick={() => void task.run(async () => {
            const order = await write<DepositOrder>(route + '/deposit')
            navigate(paymentPath(order.id) + '?operacion=' + encodeURIComponent(id))
          })}>{task.busy ? 'Preparando pago…' : 'Ver cotización y pagar'}<ArrowRight size={18} aria-hidden="true" /></button>}
        {role === 'seller' && status === 'invited' && inviteUrl && <div className="stack invite-share">
          <Field label="Enlace de invitación"><input value={inviteUrl} readOnly onFocus={(event) => event.currentTarget.select()} /></Field>
          <button type="button" className="button secondary" onClick={() => void task.run(async () => { await navigator.clipboard.writeText(inviteUrl); setCopied(true) })}>
            {copied ? 'Enlace copiado' : 'Copiar enlace'}{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
          </button>
        </div>}
        {role === 'seller' && ['draft', 'invited'].includes(status) &&
          <button className="text-button" type="button" disabled={task.busy} onClick={() => setDialog('cancel')}>Retirar acuerdo</button>}
      </section>
    </div>
    {dialog && <Dialog title={{ accept: 'Aceptar el acuerdo', send: 'Enviar invitación', cancel: 'Retirar acuerdo', decline: 'Rechazar el acuerdo' }[dialog]}
      onClose={() => setDialog(null)}>
      <form className="stack" onSubmit={(event) => {
        event.preventDefault()
        const action = dialog
        setDialog(null)
        void task.run(() => saveAgreement(action))
      }}>
        {dialog === 'accept' && <p>Confirmas la cuota inicial, las condiciones, los plazos y el tercero designado del acuerdo.</p>}
        {dialog === 'send' && <p>Confirmas los datos de la preventa y habilitas el enlace de invitación para el comprador.</p>}
        {dialog === 'cancel' && <p>El acuerdo se retirará y el comprador dejará de tener acceso a la invitación.</p>}
        {dialog === 'decline' && <Field label="Motivo del rechazo"><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={600} required /></Field>}
        <div className="button-row">
          <button className="button secondary" type="button" onClick={() => setDialog(null)}>Volver</button><Submit>Confirmar</Submit>
        </div>
      </form>
    </Dialog>}
  </>
}

export function ConditionPage() {
  const { id = '', trancheId = '' } = useParams()
  const query = readOperation(id)
  if (query.isPending) return <Loading>Abriendo la condición…</Loading>
  if (query.isError) return <Feedback error={query.error} onRetry={() => void query.refetch()} />
  const tranche = query.data.tranches.find((item) => item.id === trancheId)
  if (!tranche) return <><Back to={operationPath(id)}>Volver a la operación</Back><Feedback error="Esta condición no está disponible." /></>
  return <ConditionDetail key={tranche.id} operation={query.data} tranche={tranche} />
}

function ConditionDetail({ operation, tranche }: { operation: Operation; tranche: Tranche }) {
  const { id, role, feeBps } = operation
  const query = useQueryClient()
  const session = useSession()
  const signer = useSigningAvailable()
  const chain = useChainAction()
  const task = useWork()
  const [form, setForm] = useState<'object' | 'dispute' | null>(null)
  const [refundDecision, setRefundDecision] = useState<'accepted' | 'rejected'>('accepted')
  const [response, setResponse] = useState('')
  const [toBuyer, setToBuyer] = useState(String(tranche.amount / 100))
  const [proposedBuyer, setProposedBuyer] = useState(tranche.amount)
  const [submitted, setSubmitted] = useState('')
  const state = conditionState(tranche)
  const gross = tranche.amount
  const locked = chain.busy || tranche.pendingAction?.status === 'pending'
  const action = operation.status === 'funded' && !locked ? nextConditionAction(role, tranche) : null
  const estimate = trancheNet(gross, feeBps)
  const isResolved = ['released', 'refunded', 'resolved'].includes(tranche.status)
  const canDispute = operation.status === 'funded' && role !== 'arbiter' && !locked && ['submitted', 'objected', 'approved'].includes(tranche.status)
  const responseDeadline = tranche.refundResponseDueAt ?? (tranche.refundRequestedAt ?
    new Date(Date.parse(tranche.refundRequestedAt) + operation.refundResponseHours * 3600000).toISOString() : null)

  function open(input: Omit<ActionInput, 'trancheId'>, title: string, detail: string, complete: string) {
    const prompt: ActionPrompt = { input: { ...input, trancheId: tranche.id }, title, detail, complete }
    chain.open(prompt)
  }

  return <>
    <Back to={operationPath(id)}>{role === 'buyer' ? 'Mi compra' : 'Volver a la operación'}</Back>
    <Title detail={operation.project.name + ' · ' + operation.unit}>{tranche.title}</Title>
    <div className="two-column">
      <div>
        <section className="section">
          <h2>Documentos de la condición</h2>
          <p>{tranche.condition}</p>
          {tranche.requirements.map((requirement) => {
            const file = tranche.evidence.find((item) => item.reqKey === requirement.key)?.file
            const guide = requirementGuide.get(requirement.key)
            const contractMatch = requirement.key === 'contrato_certificado' && file ? file.sha256 === operation.contractSha256 : null
            const detail = contractMatch === null ? guide ?? file?.name : contractMatch ?
              'Coincide con el contrato del acuerdo.' : 'El archivo es diferente del contrato del acuerdo. Revísalo antes de confirmar.'
            return file ? <FileRow key={requirement.key} file={file} label={requirement.label} detail={detail} /> :
              <div className="row static-row" key={requirement.key}><strong>{requirement.label}</strong><small>{guide ?? 'Por presentar'}</small></div>
          })}
          {tranche.evidence.filter((evidence) => evidence.reqKey === 'otro' && evidence.file).map(({ file }) => <FileRow key={file!.id} file={file!} />)}
          {tranche.evidenceNote && <p className="muted">{tranche.evidenceNote}</p>}
          {!!tranche.evidenceHistory?.length && <details className="disclosure">
            <summary><span>Historial de presentaciones</span></summary>
            {tranche.evidenceHistory?.map((submission, index) => <div className="evidence-version" key={submission.txHash ?? index}>
              <p><strong>{formatDate(submission.at, true)}</strong></p>
              {submission.files.map((item) => item.file && <FileRow key={item.reqKey + item.file.id} file={item.file}
                label={tranche.requirements.find((requirement) => requirement.key === item.reqKey)?.label} />)}
              <ExplorerLink base={session.data?.config.explorerUrl} hash={submission.txHash} />
            </div>)}
          </details>}
        </section>
        {(tranche.objection || tranche.disputeReason || tranche.refundRequestedAt) && <section className="section">
          <h2>{tranche.status === 'disputed' ? 'Desacuerdo' : tranche.refundRequestedAt ? 'Devolución' : 'Observaciones'}</h2>
          {tranche.objection && <p><strong>Observación del comprador. </strong>{tranche.objection}</p>}
          {tranche.disputeReason && <p><strong>Motivo del {tranche.disputeByRole === 'seller' ? 'desarrollador' : 'comprador'}. </strong>{tranche.disputeReason}</p>}
          {tranche.refundRequestedAt && !tranche.refundResponse && !isResolved && <p>{tranche.refundWindowPassed ?
            'El plazo de respuesta terminó. Le toca al tercero designado resolver.' :
            'El desarrollador puede responder hasta el ' + formatDate(responseDeadline, true) + ' (Bolivia).'}</p>}
          {tranche.refundResponse && !isResolved && <p>El desarrollador {tranche.refundResponse === 'accepted' ? 'aceptó la devolución' : 'rechazó la devolución'}. Le toca al tercero designado.</p>}
          {tranche.refundResponseReason && <p>{tranche.refundResponseReason}</p>}
          <Link className="text-link" to={operationPath(id) + '/acuerdo'}>Consultar el acuerdo</Link>
        </section>}
        {action === 'evidence' && signer && <EvidenceForm operation={operation} tranche={tranche} onReady={(items, note) =>
          open({ kind: 'evidence', items, note }, 'Presentar documentos', 'El comprador recibirá estos documentos para revisar la condición.', 'Documentos presentados. El comprador ya puede revisarlos.')} />}
      </div>
      <section className="section action-section">
        <h2>{state}</h2>
        <Amount cents={gross} />
        <dl className="details">
          <div><dt>Fecha límite</dt><dd>{formatDate(tranche.dueAt, true)}</dd></div>
          {isResolved && <><div><dt>Entregado al desarrollador</dt><dd>{money(tranche.toSeller ?? 0)}</dd></div>
            <div><dt>Devuelto</dt><dd>{money(tranche.toBuyer ?? 0)}</dd></div>
            {!!tranche.fee && <div><dt>Comisiones</dt><dd>{money(tranche.fee)}</dd></div>}</>}
        </dl>
        <ExplorerLink base={session.data?.config.explorerUrl} hash={tranche.txHash} />
        {tranche.pendingAction?.status === 'pending' && <Loading>Confirmando…</Loading>}
        {role === 'buyer' && tranche.status === 'approved' && <Feedback>Listo. El desarrollador ya puede recibir el pago.</Feedback>}
        {(action || form === 'dispute') && action !== 'refund-response' && !signer && <ReconnectLink />}
        {action === 'approve' && signer && <>
          <button className="button primary" type="button" onClick={() => open({ kind: 'approve' }, 'Confirmar la condición',
            'Confirmas que los documentos cumplen lo acordado. Después, el desarrollador podrá recibir el pago.', 'Listo. El desarrollador ya puede recibir el pago.')}>
            Confirmar condición<ArrowRight size={18} aria-hidden="true" />
          </button>
          <button className="text-button" type="button" onClick={() => setForm('object')}>Objetar documentos</button>
        </>}
        {action === 'release' && signer && <button className="button primary" type="button" onClick={() =>
          open({ kind: 'release' }, 'Recibir pago aprobado',
            'Se entregarán ' + money(estimate.net) + ' después de descontar las comisiones de esta condición.', 'Pago entregado.')}>
          Recibir pago aprobado<ArrowRight size={18} aria-hidden="true" /></button>}
        {action === 'refund' && signer && <>
          <p>Siguen protegidos {money(gross)}. Si la devolución se ejecuta por el monto completo, recibirás {money(estimate.net)} después de comisiones.</p>
          <button className="button primary" type="button" onClick={() => open({ kind: 'refund' }, 'Pedir devolución',
            'El importe seguirá protegido mientras el desarrollador responde y el tercero designado resuelve.', 'Devolución solicitada.')} >
            Pedir devolución<ArrowRight size={18} aria-hidden="true" /></button>
        </>}
        {action === 'refund-response' && <form className="stack" onSubmit={task.submit(async () => {
          setSubmitted('')
          await write('/tranches/' + tranche.id + '/refund-response', { decision: refundDecision, reason: response })
          setSubmitted('Respuesta registrada.')
          await query.invalidateQueries({ queryKey: ['/ops/' + id] })
        })}>
          <Field label="Respuesta a la devolución"><select value={refundDecision} onChange={(event) => setRefundDecision(event.target.value === 'accepted' ? 'accepted' : 'rejected')}>
            <option value="accepted">Aceptar devolución</option><option value="rejected">Rechazar devolución</option>
          </select></Field>
          <Field label={refundDecision === 'rejected' ? 'Motivo del rechazo' : 'Comentario (opcional)'}>
            <textarea value={response} onChange={(event) => setResponse(event.target.value)} maxLength={1000} required={refundDecision === 'rejected'} />
          </Field>
          <Submit waiting={task.busy}>Registrar respuesta</Submit>
        </form>}
        {action === 'resolve' && signer && <form className="stack" onSubmit={task.submit(async () => {
          const buyer = tranche.refundResponse === 'accepted' ? gross : amountInCents(toBuyer, true)
          if (buyer > gross) throw new Error('La devolución supera el importe protegido de esta condición.')
          const seller = gross - buyer
          open({ kind: 'resolve', toBuyer: buyer, toSeller: seller, note: response }, 'Ejecutar la resolución',
            'Importe antes de comisiones. Comprador ' + money(buyer) + '. Desarrollador ' + money(seller) + '.', 'Resolución confirmada.')
        })}>
          <Field label="Monto para el comprador (USD)">
            <input inputMode="decimal" required value={toBuyer} readOnly={tranche.refundResponse === 'accepted'} onChange={(event) => {
              setToBuyer(event.target.value)
              try { setProposedBuyer(Math.min(amountInCents(event.target.value, true), gross)) } catch { /* Espera un importe completo. */ }
            }} />
          </Field>
          <p className="muted">Monto para el desarrollador antes de comisiones · {money(gross - proposedBuyer)}</p>
          <Field label="Motivo o instrucciones de la resolución"><textarea value={response} onChange={(event) => setResponse(event.target.value)} maxLength={1000} required /></Field>
          <Submit waiting={task.busy}>Revisar y ejecutar resolución</Submit>
        </form>}
        {canDispute && <button className="text-button" type="button" disabled={task.busy} onClick={() => setForm('dispute')}>Abrir desacuerdo</button>}
        <Feedback error={task.error}>{submitted}</Feedback>
        {chain.feedback}
      </section>
    </div>
    {form && <Dialog title={form === 'object' ? 'Objetar documentos' : 'Abrir desacuerdo'} onClose={() => setForm(null)}>
      <form className="stack" onSubmit={task.submit(async (formData) => {
        const reason = String(formData.get('reason')).trim()
        if (!reason) throw new Error('Escribe un motivo para continuar.')
        if (form === 'object') {
          await write('/tranches/' + tranche.id + '/object', { reason })
          setSubmitted('Observación registrada. El desarrollador puede presentar documentos actualizados.')
          await query.invalidateQueries({ queryKey: ['/ops/' + id] })
        } else {
          open({ kind: 'dispute', reason }, 'Confirmar desacuerdo', 'El tramo quedará protegido mientras el tercero designado decide.', 'Desacuerdo abierto.')
        }
        setForm(null)
      })}>
        <Field label="Motivo"><textarea name="reason" maxLength={1000} required /></Field>
        <Feedback error={task.error} />
        <div className="button-row"><button className="button secondary" type="button" onClick={() => setForm(null)}>Volver</button>
          {form !== 'dispute' || signer ? <Submit waiting={task.busy}>Continuar</Submit> : <ReconnectLink />}</div>
      </form>
    </Dialog>}
    {chain.dialog}
  </>
}

function EvidenceForm({ operation, tranche, onReady }: {
  operation: Operation; tranche: Tranche;
  onReady: (items: { reqKey: string; fileId: string }[], note: string) => void;
}) {
  const project = read<ProjectDetail>('/projects/' + operation.project.id)
  const task = useWork()
  const linked = (key: string): Evidence | undefined => tranche.evidence.find((evidence) => evidence.reqKey === key && evidence.file) ??
    project.data?.docs.find((document) => document.reqKey === key && document.file) ??
    (key === 'contrato_certificado' && operation.contract ? { file: operation.contract, reqKey: key } : undefined)

  return <section className="section">
    <h2>Presentar documentos</h2>
    <form className="stack" onSubmit={task.submit(async (data) => {
      const items: { reqKey: string; fileId: string }[] = []
      const chosen = tranche.requirements.map((requirement) => {
        const input = data.get(requirement.key)
        const selected = input instanceof File && input.size > 0 ? input : null
        const existing = linked(requirement.key)?.file
        if (!selected && !existing) throw new Error('Adjunta ' + requirement.label + '.')
        if (selected && selected.size > 15 * 1024 * 1024) throw new Error('Cada documento puede pesar hasta 15 MB.')
        return { requirement, selected, existing }
      })
      for (const { requirement, selected, existing } of chosen) {
        const file = selected ? await uploadFile(selected) : existing!
        items.push({ reqKey: requirement.key, fileId: file.id })
      }
      onReady(items, String(data.get('note') ?? ''))
    })}>
      {tranche.requirements.map((requirement) => <Field key={requirement.key} label={requirement.label}
        help={linked(requirement.key)?.file ? 'Disponible para reutilizar · ' + linked(requirement.key)?.file?.name : undefined}>
        <input name={requirement.key} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" required={!linked(requirement.key)?.file} />
      </Field>)}
      <Field label="Comentario para el comprador (opcional)"><textarea name="note" maxLength={1000} /></Field>
      <Feedback error={task.error} />
      <Submit waiting={task.busy}>Revisar presentación</Submit>
    </form>
  </section>
}
