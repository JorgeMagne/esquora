import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, Copy } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router'
import { canOpenConditionDispute } from '../shared/conditions.ts'
import { netAfterFees, TW_FEE_BPS } from '../shared/fees.ts'
import {
  conditionPath, invitationPath, operationPath, paymentPath, read, readOperation, resolverInvitationPath, uploadFile, useSession, write,
  type ActionInput, type DepositOrder, type Evidence, type Operation, type ProjectDetail, type ResolutionMode, type Tranche,
} from './api.ts'
import { amountInCents, conditionAmounts, conditionLabels, formatDate, money, nextConditionAction, numberAmount, operationLabels, requirementGuide, towerStage } from './model.ts'
import { Tower } from './plans.tsx'
import { ReconnectLink, useAgreementSignature, useChainAction, useSigningAvailable } from './signing.tsx'
import type { ActionPrompt } from './signing.tsx'
import { ResolverOptions } from './resolver-options.tsx'
import { ResolutionInstruction } from './resolution.tsx'
import { ActionLink, Amount, Back, Dialog, ExplorerLink, Feedback, Field, FileRow, Loading, Submit, Title, TotalsStrip, useWork } from './ui.tsx'

const percent = new Intl.NumberFormat('es-BO', { style: 'percent', maximumFractionDigits: 2 })

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
  if (action === 'approve') return tranche.title === 'Inicio de obra' ? 'Revisar inicio de obra' : 'Revisar documentos'
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
  if (query.data.role === 'buyer' && query.data.status === 'awaiting_deposit') return <DepositReview operation={query.data} />
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

function DepositReview({ operation }: { operation: Operation }) {
  const { id, project, unit, deposit, depositOrder } = operation
  const task = useWork()
  const navigate = useNavigate()
  const pending = depositOrder?.status === 'paid'
  const paymentUrl = (orderId: string) => paymentPath(orderId) + '?operacion=' + encodeURIComponent(id)

  return <div className="deposit-review">
    <Back to="/">Mis compras</Back>
    <Title detail={project.name + ' · ' + unit}>{pending ? 'Confirmando el depósito' : 'Deposita la cuota inicial'}</Title>
    <section className="deposit-quote" aria-label="Cuota inicial">
      <Amount cents={deposit} />
      <p>{pending
        ? 'El saldo aparecerá como protegido cuando se confirme en la red.'
        : 'Revisa cuánto pagarías en bolivianos. El depósito confirmado queda protegido por las condiciones del acuerdo.'}</p>
      <Feedback error={task.error} />
      {pending ? <ActionLink to={paymentUrl(depositOrder.id)}>Consultar depósito</ActionLink> :
        <button className="button primary" type="button" disabled={task.busy} onClick={() => void task.run(async () => {
          const order = await write<DepositOrder>('/ops/' + id + '/deposit')
          navigate(paymentUrl(order.id))
        })}>{task.busy ? 'Preparando cotización…' : 'Ver cotización'}<ArrowRight size={18} aria-hidden="true" /></button>}
      <Link className="text-link" to={operationPath(id) + '/acuerdo'}>Ver acuerdo</Link>
    </section>
  </div>
}

function Purchase({ operation }: { operation: Operation }) {
  const { id, project, unit, tranches, totals, deposit, role } = operation
  const next = tranches.find((tranche) => tranche.pendingAction?.status !== 'pending' && conditionButton(operation, tranche))
  const approved = role === 'buyer' && tranches.some((tranche) => tranche.status === 'approved')
  const confirming = tranches.some((tranche) => tranche.pendingAction?.status === 'pending')
  return <article className="purchase">
    {role === 'buyer' && <Back to="/">Mis compras</Back>}
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
      <TotalsStrip totals={totals} showProtected={false} />
      {approved && !next && <Feedback>El desarrollador ya puede recibir el pago.</Feedback>}
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
  const signAgreement = useAgreementSignature()
  const canSign = useSigningAvailable()
  const user = useSession().data?.user
  const task = useWork()
  const [dialog, setDialog] = useState<'accept' | 'send' | 'cancel' | 'decline' | null>(null)
  const [note, setNote] = useState('')
  const [resolutionConsent, setResolutionConsent] = useState(false)
  const [unsavedResolver, setUnsavedResolver] = useState<string | null>(null)
  const route = '/ops/' + id
  const canAccept = role === 'buyer' && status === 'invited'
  const sellerDraft = role === 'seller' && status === 'draft'
  const resolutionMode = operation.resolutionMode ?? (arbiter ? 'external' : 'pending')
  const resolverReady = operation.resolverReady ?? !!arbiter
  const resolverKey = id + ':' + resolutionMode + ':' + (operation.arbiterEmail ?? '')
  const resolverChanged = unsavedResolver === resolverKey
  const canSend = sellerDraft && resolverReady && !resolverChanged
  const resolutionTerms = operation.resolutionTerms
  const requiresConsent = resolutionMode === 'esquora'
  const inviteUrl = operation.inviteToken && new URL(invitationPath(operation.inviteToken), window.location.origin).href
  const fees = tranches.reduce((total, { amount }) => total + amount - netAfterFees(amount, operation.feeBps), 0)

  async function refresh() {
    await query.invalidateQueries({ predicate: ({ queryKey }) => queryKey[0] === route || queryKey[0] === '/ops' || String(queryKey[0]).startsWith('/projects') })
  }

  async function saveAgreement(action: 'accept' | 'send' | 'cancel' | 'decline') {
    const signing = action === 'accept' || action === 'send'
    if (signing && requiresConsent && (!resolutionConsent || !resolutionTerms)) throw new Error('Acepta las condiciones de verificación y ejecución antes de continuar.')
    const body = signing ? { signature: await signAgreement(operation.termsDigest), ...(requiresConsent && { resolutionConsent }) } :
      action === 'decline' ? { reason: note } : {}
    const updated = await write<Operation>(route + '/' + action, body)
    query.setQueryData([route], updated)
    await refresh()
  }

  return <>
    <Back to={fromOperation ? operationPath(id) : '/'}>{fromOperation ? 'Volver a la operación' : role === 'buyer' ? 'Mis compras' : 'Operaciones'}</Back>
    <Title detail={project.name + ' · ' + operation.unit}>Acuerdo de preventa</Title>
    <div className="two-column">
      <div>
        <section className="section">
          <h2>Partes y contrato</h2>
          <dl className="details">
            <div><dt>Estado</dt><dd>{operationLabels[status] ?? 'Por revisar'}</dd></div>
            {operation.unitDetail && <div><dt>Unidad</dt><dd>{operation.unitDetail}</dd></div>}
            <div><dt>Desarrollador</dt><dd>{seller.orgName ?? seller.name}</dd></div>
            <div><dt>Comprador</dt><dd>{buyerName}</dd></div>
            <div><dt>Precio del inmueble</dt><dd>{money(operation.price)}</dd></div>
            <div><dt>Modalidad de resolución</dt><dd>{resolutionMode === 'esquora' ? 'ESQUORA verifica y ejecuta' :
              resolutionMode === 'external' ? arbiter?.orgName ?? arbiter?.name ?? 'Tercero invitado' : 'Por elegir'}</dd></div>
            <div><dt>Plazo para responder una devolución</dt><dd>{operation.refundResponseHours < 1 ?
              Math.round(operation.refundResponseHours * 60) + ' min' : operation.refundResponseHours + ' h'}</dd></div>
          </dl>
          {contract && <FileRow file={contract} label="Descargar el contrato" detail={contract.name} />}
        </section>
        {sellerDraft && <DraftResolver
          key={resolverKey}
          operation={operation} mode={resolutionMode} ready={resolverReady}
          onChange={(changed) => setUnsavedResolver(changed ? resolverKey : null)}
          onUpdate={(updated) => {
            setUnsavedResolver(null)
            query.setQueryData([route], updated)
            void refresh()
          }} />}
        {requiresConsent && resolutionTerms && <section className="section" aria-label={resolutionTerms.title}>
          <h2>{resolutionTerms.title}</h2>
          <ol className="plain-list resolution-clauses">{resolutionTerms.clauses.map((clause, index) => <li key={index}>{clause}</li>)}</ol>
        </section>}
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
        <h2>Cuota inicial</h2>
        <Amount cents={deposit} />
        <dl className="details">
          <div><dt>Comisión de ESQUORA</dt><dd>{percent.format(operation.feeBps / 10_000)}</dd></div>
          <div><dt>Comisión de la red de protección</dt><dd>{percent.format(TW_FEE_BPS / 10_000)}</dd></div>
          <div><dt>Comisiones estimadas</dt><dd>{money(fees)}</dd></div>
        </dl>
        <p className="muted">Las comisiones se descuentan cuando se entrega o se devuelve cada tramo.</p>
        <Feedback error={task.error || (operation.deploymentError ? 'No pudimos registrar la protección. Vuelve a confirmar el acuerdo.' : null)}>
          {operation.declineReason && 'Motivo del rechazo: ' + operation.declineReason}
        </Feedback>
        {status === 'deploying' && <Loading>Confirmando el acuerdo…</Loading>}
        {operation.depositOrder?.status === 'paid' && <Loading>Confirmando el depósito…</Loading>}
        {sellerDraft && resolverChanged && <p className="muted">Guarda el cambio de resolución antes de enviar el acuerdo.</p>}
        {canAccept && user?.walletStatus !== 'active' && <ActionLink to={'/cuenta?volver=' + encodeURIComponent(operationPath(id))}>Activar mi cuenta</ActionLink>}
        {(canSend || (canAccept && user?.walletStatus === 'active')) && (canSign ?
          <button className="button primary" type="button" disabled={task.busy || (requiresConsent && !resolutionTerms)}
            onClick={() => { setResolutionConsent(false); setDialog(canSend ? 'send' : 'accept') }}>
            {task.busy ? 'Confirmando…' : canSend ? 'Enviar invitación' : 'Aceptar acuerdo'}<ArrowRight size={18} aria-hidden="true" />
          </button> : <ReconnectLink />)}
        {canAccept && <button className="text-button" type="button" disabled={task.busy} onClick={() => setDialog('decline')}>Rechazar acuerdo</button>}
        {role === 'buyer' && status === 'awaiting_deposit' && <ActionLink to={operationPath(id)}>Ir a la cuota inicial</ActionLink>}
        {role === 'seller' && status === 'invited' && inviteUrl && <InviteShare url={inviteUrl} label="Enlace para el comprador" />}
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
        {dialog === 'accept' && <p>Confirmas la cuota inicial, las condiciones, los plazos y cómo se tramitará una devolución o un desacuerdo.</p>}
        {dialog === 'send' && <p>Confirmas los datos de la preventa y habilitas el enlace de invitación para el comprador.</p>}
        {dialog === 'cancel' && <p>El acuerdo se retirará y el comprador dejará de tener acceso a la invitación.</p>}
        {dialog === 'decline' && <Field label="Motivo del rechazo"><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={600} required /></Field>}
        {requiresConsent && (dialog === 'accept' || dialog === 'send') && <label className="resolution-consent">
          <input type="checkbox" checked={resolutionConsent} required onChange={(event) => setResolutionConsent(event.target.checked)} />
          <span>Leí y acepto las condiciones de verificación y ejecución de ESQUORA.</span>
        </label>}
        <div className="button-row">
          <button className="button secondary" type="button" onClick={() => setDialog(null)}>Volver</button><Submit>Confirmar</Submit>
        </div>
      </form>
    </Dialog>}
  </>
}

function DraftResolver({ operation, mode: savedMode, ready, onChange, onUpdate }: {
  operation: Operation; mode: ResolutionMode; ready: boolean;
  onChange: (changed: boolean) => void; onUpdate: (operation: Operation) => void;
}) {
  const [mode, setMode] = useState(savedMode)
  const [email, setEmail] = useState(operation.arbiterEmail ?? '')
  const task = useWork()
  const pendingInvite = savedMode === 'external' && !ready && operation.arbiterInviteToken
  const isChanged = (selected: ResolutionMode, selectedEmail: string) => selected !== savedMode ||
    (selected === 'external' && selectedEmail.trim() !== (operation.arbiterEmail ?? ''))
  const changed = isChanged(mode, email)
  const refreshEsquora = mode === 'esquora' && savedMode === 'esquora' && !ready

  return <section className="section">
    <h2>Resolución del acuerdo</h2>
    <form className="stack" onSubmit={task.submit(async () => {
      const updated = await write<Operation>('/ops/' + operation.id + '/resolver', {
        resolutionMode: mode, ...(mode === 'external' && { arbiterEmail: email.trim() }),
      }, 'PATCH')
      onUpdate(updated)
    })}>
      <ResolverOptions mode={mode} email={email} onMode={(selected) => {
        setMode(selected)
        onChange(isChanged(selected, email))
      }} onEmail={(selected) => {
        setEmail(selected)
        onChange(isChanged(mode, selected))
      }} />
      <Feedback error={task.error} />
      <button className="button secondary" type="submit" disabled={task.busy || (!changed && !refreshEsquora)}>
        {task.busy ? 'Guardando…' : refreshEsquora ? 'Comprobar disponibilidad' : 'Guardar resolución'}
      </button>
    </form>
    {pendingInvite && <>
      <p className="muted">Comparte este enlace con {operation.arbiterEmail || 'el tercero'}. Podrás enviar el acuerdo cuando acepte.</p>
      <InviteShare url={new URL(resolverInvitationPath(pendingInvite), window.location.origin).href} label="Enlace para el tercero designado" />
    </>}
    {ready && savedMode === 'external' && <p>El tercero aceptó la designación.</p>}
    {!ready && savedMode === 'esquora' && <p>La cuenta verificadora de ESQUORA está pendiente de activación. Puedes conservar el borrador o invitar a un tercero.</p>}
  </section>
}

function InviteShare({ url, label }: { url: string; label: string }) {
  const task = useWork()
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const copied = copiedUrl === url
  return <div className="stack invite-share">
    <Field label={label}><input value={url} readOnly onFocus={(event) => event.currentTarget.select()} /></Field>
    <Feedback error={task.error} />
    <button type="button" className="button secondary" disabled={task.busy} onClick={() => void task.run(async () => {
      try { await navigator.clipboard.writeText(url) }
      catch { throw new Error('Selecciona el enlace del campo para copiarlo manualmente.') }
      setCopiedUrl(url)
    })}>{copied ? 'Enlace copiado' : 'Copiar enlace'}{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}</button>
  </div>
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
  const [toBuyer, setToBuyer] = useState('')
  const [submitted, setSubmitted] = useState('')
  const state = conditionState(tranche)
  const gross = tranche.amount
  const agreedRefund = tranche.refundResponse === 'accepted'
  let buyerShare: number | null = agreedRefund ? gross : null
  if (!agreedRefund && toBuyer.trim()) {
    try {
      const amount = amountInCents(toBuyer, true)
      if (amount <= gross) buyerShare = amount
    } catch { /* El importe puede estar incompleto mientras se edita. */ }
  }
  const locked = chain.busy || tranche.pendingAction?.status === 'pending'
  const nextAction = operation.status === 'funded' ? nextConditionAction(role, tranche) : null
  const action = locked ? null : nextAction
  const presentingEvidence = signer && nextAction === 'evidence'
  const net = netAfterFees(gross, feeBps)
  const isResolved = ['released', 'refunded', 'resolved'].includes(tranche.status)
  const esquoraResolution = operation.resolutionMode === 'esquora' &&
    ['disputed', 'refund_requested', 'refunded', 'resolved'].includes(tranche.status)
  const settlement = conditionAmounts(tranche)
  const canDispute = operation.status === 'funded' && role !== 'arbiter' && !locked && canOpenConditionDispute(tranche.status)
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
            const contractMatch = requirement.key === 'contrato_certificado' && file && operation.contractSha256 ?
              file.sha256 === operation.contractSha256 : null
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
            'El plazo de respuesta terminó. ' + (esquoraResolution ? 'Las partes ya pueden presentar una instrucción.' : 'Le toca al tercero designado resolver.') :
            'El desarrollador puede responder hasta el ' + formatDate(responseDeadline, true) + ' (Bolivia).'}</p>}
          {tranche.refundResponse && !isResolved && <p>El desarrollador {tranche.refundResponse === 'accepted' ? 'aceptó la devolución' : 'rechazó la devolución'}. {esquoraResolution ?
            'Las partes ya pueden presentar una instrucción.' : 'Le toca al tercero designado.'}</p>}
          {tranche.refundResponseReason && <p>{tranche.refundResponseReason}</p>}
          <Link className="text-link" to={operationPath(id) + '/acuerdo'}>Consultar el acuerdo</Link>
        </section>}
        {presentingEvidence && <EvidenceForm operation={operation} tranche={tranche} locked={locked} feedback={chain.feedback} onReady={(items, note) =>
          open({ kind: 'evidence', items, note }, 'Presentar documentos', 'El comprador recibirá estos documentos para revisar la condición.', 'Documentos presentados. El comprador ya puede revisarlos.')} />}
      </div>
      <section className="section action-section">
        <h2>{settlement.state === 'shared' ? 'Reparto confirmado' : state}</h2>
        {settlement.state !== 'shared' && <Amount cents={settlement.amount} />}
        <dl className="details">
          {!isResolved && <div><dt>Fecha límite</dt><dd>{formatDate(tranche.dueAt, true)}</dd></div>}
          {isResolved && <>
            {settlement.state === 'shared' && <><div><dt>Entregado al desarrollador</dt><dd>{money(settlement.seller)}</dd></div>
              <div><dt>Devuelto al comprador</dt><dd>{money(settlement.buyer)}</dd></div></>}
            <div><dt>Importe del tramo</dt><dd>{money(gross)}</dd></div>
            {!!tranche.fee && <div><dt>Comisiones</dt><dd>{money(tranche.fee)}</dd></div>}</>}
        </dl>
        <ExplorerLink base={session.data?.config.explorerUrl} hash={tranche.txHash} />
        {tranche.pendingAction?.status === 'pending' && <Loading>Confirmando…</Loading>}
        {((action && !(esquoraResolution && action === 'resolve')) || form === 'dispute') &&
          action !== 'refund-response' && !signer && <ReconnectLink />}
        {action === 'approve' && signer && <>
          <button className="button primary" type="button" onClick={() => open({ kind: 'approve' }, 'Confirmar la condición',
            'Esta confirmación es definitiva. El desarrollador podrá recibir el pago de esta condición.', 'Listo. El desarrollador ya puede recibir el pago.')}>
            Confirmar condición<ArrowRight size={18} aria-hidden="true" />
          </button>
          <button className="text-button" type="button" onClick={() => setForm('object')}>Objetar documentos</button>
        </>}
        {action === 'release' && signer && <button className="button primary" type="button" onClick={() =>
          open({ kind: 'release' }, 'Recibir pago aprobado',
            'Se entregarán ' + money(net) + ' después de descontar las comisiones de esta condición.', 'Pago entregado.')}>
          Recibir pago aprobado<ArrowRight size={18} aria-hidden="true" /></button>}
        {action === 'refund' && signer && <>
          <p>Si se devuelve el tramo completo, recibirás <strong>{money(net)}</strong> después de comisiones.</p>
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
        {esquoraResolution && <ResolutionInstruction operation={operation} tranche={tranche} locked={locked} onReady={(prompt) => chain.open(prompt)} />}
        {action === 'resolve' && signer && !esquoraResolution && <form className="stack" onSubmit={task.submit(async () => {
          if (buyerShare === null) throw new Error('Ingresa un importe válido para el comprador.')
          const sellerShare = gross - buyerShare
          open({ kind: 'resolve', toBuyer: buyerShare, toSeller: sellerShare, note: response }, 'Ejecutar la resolución',
            'Importe antes de comisiones. Comprador ' + money(buyerShare) + '. Desarrollador ' + money(sellerShare) + '.', 'Resolución confirmada.')
        })}>
          <Field label="Monto para el comprador (USD)"
            help={!agreedRefund && !!toBuyer.trim() && buyerShare === null ? 'Ingresa un importe entre USD 0 y ' + money(gross) + '.' : undefined}>
            <input inputMode="decimal" required value={agreedRefund ? String(gross / 100) : toBuyer} readOnly={agreedRefund}
              onChange={(event) => setToBuyer(event.target.value)} />
          </Field>
          {buyerShare !== null && <p className="muted">Monto para el desarrollador antes de comisiones · {money(gross - buyerShare)}</p>}
          <Field label="Motivo o instrucciones de la resolución"><textarea value={response} onChange={(event) => setResponse(event.target.value)} maxLength={1000} required /></Field>
          <Submit waiting={task.busy} disabled={buyerShare === null}>Revisar y ejecutar resolución</Submit>
        </form>}
        {canDispute && <button className="text-button" type="button" disabled={task.busy} onClick={() => setForm('dispute')}>Abrir desacuerdo</button>}
        <Feedback error={task.error}>{submitted}</Feedback>
        {!presentingEvidence && chain.feedback}
      </section>
    </div>
    {(form === 'object' || (form === 'dispute' && canDispute)) && <Dialog title={form === 'object' ? 'Objetar documentos' : 'Abrir desacuerdo'} onClose={() => setForm(null)}>
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

function EvidenceForm({ operation, tranche, locked, feedback, onReady }: {
  operation: Operation; tranche: Tranche; locked: boolean; feedback: ReactNode;
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
      if (locked) return
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
        <input name={requirement.key} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp"
          required={!linked(requirement.key)?.file} disabled={locked || task.busy} />
      </Field>)}
      <Field label="Comentario para el comprador (opcional)"><textarea name="note" maxLength={1000} disabled={locked || task.busy} /></Field>
      <Feedback error={task.error} />
      {feedback}
      <Submit waiting={task.busy} disabled={locked}>Revisar presentación</Submit>
    </form>
  </section>
}
