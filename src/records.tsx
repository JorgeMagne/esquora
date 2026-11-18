import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDownLeft, ArrowRight, ArrowUpRight, ShieldCheck } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { conditionPath, operationPath, read, readOperation, useSession, write, type Notification, type Receipt, type Verification, type Wallet } from './api.ts'
import { amountInCents, eventLabels, formatDate, money } from './model.ts'
import { ReconnectLink, useChainAction, useSigningAvailable } from './signing.tsx'
import { ActionLink, Amount, Back, Empty, ExplorerLink, Feedback, Field, Loading, RowLink, Submit, Title, TotalsStrip, useWork } from './ui.tsx'

export function WalletPage() {
  const session = useSession()
  const wallet = read<Wallet>('/wallet')
  const task = useWork()
  const chain = useChainAction()
  const available = useSigningAvailable()
  const [amount, setAmount] = useState('')
  const [withdraw, setWithdraw] = useState(false)
  const config = session.data?.config
  const user = session.data?.user
  if (wallet.isPending) return <Loading>Consultando tu saldo…</Loading>
  if (wallet.isError) return <Feedback error={wallet.error} onRetry={() => void wallet.refetch()} />
  const data = wallet.data
  const balance = data.usdc
  let quote: string | null = null
  if (amount && config) {
    try { quote = money(Math.round(amountInCents(amount) * config.bobPerUsdc), 'Bs') } catch { /* Aún está ingresando un monto. */ }
  }

  return <>
    <Title>Mi saldo</Title>
    <div className="two-column">
      <section className="section wallet-balance">
        <h2>Disponible para retirar</h2>
        <Amount cents={balance} />
        {user?.walletStatus !== 'active' && <ActionLink to="/cuenta?volver=%2Fsaldo">Activar mi cuenta</ActionLink>}
        {user?.walletStatus === 'active' && balance > 0 && !withdraw && (available ? <button type="button" className="button primary"
          onClick={() => setWithdraw(true)}>Retirar a mi banco<ArrowRight size={18} aria-hidden="true" /></button> : <ReconnectLink />)}
        {withdraw && balance > 0 && <form className="stack" onSubmit={task.submit(async (formData) => {
          const cents = amountInCents(amount)
          if (cents > balance) throw new Error('El importe supera tu saldo disponible.')
          chain.open({
            input: { kind: 'withdraw', amount: cents, bank: String(formData.get('bank')), account: String(formData.get('account')), holder: String(formData.get('holder')) },
            title: 'Confirmar retiro',
            detail: 'Solicitas un retiro de ' + money(cents) + (quote ? ' que equivale a ' + quote : '') + '. El retiro bancario se simula en este entorno de pruebas.',
            complete: 'Retiro de prueba confirmado.',
          })
        })}>
          <p>El retiro al banco es simulado. Usa datos ficticios.</p>
          <Field label="Importe a retirar (USD)" help={quote ? 'Equivalente de prueba · ' + quote : undefined}>
            <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required />
          </Field>
          <Field label="Banco de prueba"><input name="bank" maxLength={80} required /></Field>
          <Field label="Número de cuenta ficticio"><input name="account" maxLength={40} required /></Field>
          <Field label="Titular ficticio"><input name="holder" maxLength={120} required /></Field>
          <Feedback error={task.error} />
          <Submit waiting={task.busy} disabled={chain.busy}>Revisar retiro</Submit>
          <button type="button" className="text-button" disabled={chain.busy} onClick={() => setWithdraw(false)}>Cancelar retiro</button>
        </form>}
        {chain.feedback}
      </section>
      <section className="section">
        <h2>Movimientos</h2>
        {data.movements.length ? data.movements.map((movement) => <div className="row money-row" key={movement.id}>
          {movement.incoming ? <ArrowDownLeft size={20} aria-hidden="true" /> : <ArrowUpRight size={20} aria-hidden="true" />}
          <span><strong>{movement.opId ? <Link to={operationPath(movement.opId)}>{user?.kind === 'buyer' ? 'Devolución recibida' : 'Pago recibido'}</Link> : movement.incoming ? 'Ingreso' : 'Retiro'}</strong>
            <small>{formatDate(movement.at, true)}</small><ExplorerLink base={config?.explorerUrl} hash={movement.txHash} /></span>
          <b>{movement.incoming ? '+' : '−'}{money(movement.cents)}</b>
        </div>) : <p className="muted">Los pagos o devoluciones confirmados aparecerán aquí.</p>}
        {!!data.withdrawals.length && <div className="withdrawals">
          <h3>Retiros a banco</h3>
          {data.withdrawals.map((item) => <div className="row receipt-row" key={item.id}>
            <span><strong>{item.bank}</strong><small>{formatDate(item.createdAt, true)} · {['sent', 'confirmed'].includes(item.status) ? 'Confirmado' : 'Confirmando'}</small>
              <ExplorerLink base={config?.explorerUrl} hash={item.txHash} /></span>
            <b>{money(item.amount)}</b>
          </div>)}
        </div>}
      </section>
    </div>
    {chain.dialog}
  </>
}

export function Receipts() {
  const { id = '' } = useParams()
  const operation = readOperation(id)
  const session = useSession()
  if (operation.isPending) return <Loading>Buscando comprobantes…</Loading>
  if (operation.isError) return <Feedback error={operation.error} onRetry={() => void operation.refetch()} />
  const data = operation.data
  const events = data.events.filter((event) => !!event.txHash)
  const back = operationPath(id)
  return <>
    <Back to={back}>Volver a la operación</Back>
    <Title detail={data.project.name + ' · ' + data.unit}>Comprobantes</Title>
    <TotalsStrip totals={data.totals} />
    <section className="section">
      {events.length ? events.map((event) => <div className="row receipt-row" key={event.id}>
        <span><strong>{eventLabels[event.type] ?? 'Movimiento registrado'}</strong><small>{formatDate(event.at, true)}</small></span>
        <ExplorerLink base={session.data?.config.explorerUrl} hash={event.txHash} />
      </div>) : <Empty title="Aún no hay comprobantes">Aparecerán aquí una vez se confirmen los movimientos.</Empty>}
    </section>
  </>
}

const verificationRoles: Record<string, string> = {
  approver: 'Comprador que confirma', serviceProvider: 'Desarrollador que presenta', releaseSigner: 'Desarrollador que cobra',
  receiver: 'Receptor', disputeResolver: 'Tercero designado', platformAddress: 'Plataforma', platform: 'Plataforma',
  buyer: 'Comprador', seller: 'Desarrollador', arbiter: 'Tercero designado',
}

const transactionNames: Record<string, string> = {
  deploy: 'Registro del acuerdo', fund: 'Depósito', evidence: 'Presentación de documentos', approve: 'Confirmación',
  release: 'Pago', dispute: 'Desacuerdo', refund: 'Solicitud de devolución', resolve: 'Resolución', probe: 'Prueba de protección',
}

export function VerificationPage() {
  const { id = '' } = useParams()
  const operation = readOperation(id)
  const verification = read<Verification>('/ops/' + id + '/verification')
  const session = useSession()
  const [result, setResult] = useState<Receipt | null>(null)
  const chain = useChainAction(setResult)
  const simulation = useWork()
  const signer = useSigningAvailable()
  const back = operationPath(id)

  if (operation.isPending || verification.isPending) return <Loading>Consultando el registro público…</Loading>
  if (operation.isError || verification.isError) return <>
    <Back to={back}>Volver a la operación</Back>
    <Feedback error={operation.error ?? verification.error} onRetry={() => { void operation.refetch(); void verification.refetch() }} />
  </>
  const data = verification.data
  const op = operation.data
  const explorer = data.explorerUrl ?? session.data?.config.explorerUrl
  return <>
    <Back to={back}>Volver a la operación</Back>
    <Title detail={op.project.name + ' · ' + op.unit}>Verificación en Stellar</Title>
    <div className="two-column verification">
      <div>
        <section className="section">
          <h2>Contrato de protección</h2>
          <dl className="details technical-details">
            <div><dt>Red</dt><dd>Stellar Testnet</dd></div>
            <div><dt>Contrato</dt><dd><code>{data.contractId ?? 'Pendiente de registro'}</code></dd></div>
            <div><dt>Saldo leído de la red</dt><dd>{money(data.held)}</dd></div>
            <div><dt>Activo de prueba</dt><dd>{data.asset?.code}</dd></div>
            {data.asset?.issuer && <div><dt>Emisor</dt><dd><code>{data.asset.issuer}</code></dd></div>}
            {data.contractSha256 && <div><dt>Huella del contrato adjunto</dt><dd><code>{data.contractSha256}</code></dd></div>}
            <div><dt>Huella del acuerdo</dt><dd><code>{data.termsDigest}</code></dd></div>
          </dl>
          <ExplorerLink base={explorer} hash={data.contractId} kind="contract">Ver contrato en Stellar</ExplorerLink>
        </section>
        <section className="section">
          <h2>Roles registrados</h2>
          <dl className="details technical-details">{Object.entries(data.roles ?? {}).map(([role, value]) => <div key={role}>
            <dt>{verificationRoles[role] ?? role}</dt><dd><code>{typeof value === 'string' ? value : JSON.stringify(value)}</code></dd>
          </div>)}</dl>
        </section>
      </div>
      <div>
        <section className="section">
          <h2>Prueba de protección</h2>
          <p>Comprueba qué ocurre cuando una parte intenta retirar un tramo sin autorización. Se muestra el rechazo de la red o de la simulación.</p>
          {data.contractId && data.held > 0 && op.role !== 'arbiter' && (signer ?
            <button className="button primary" type="button" disabled={chain.busy} onClick={() => {
              setResult(null)
              chain.open({ input: { kind: 'probe', opId: id, ledger: true }, title: 'Probar protección', detail: 'Se envía un intento de retiro sin la autorización requerida. Si la red lo rechaza, el intento queda registrado y los fondos siguen protegidos.', complete: 'La red devolvió el resultado de la prueba.' })
            }}>Probar protección<ShieldCheck size={18} aria-hidden="true" /></button> : <ReconnectLink />)}
          {data.contractId && data.held > 0 && op.role !== 'arbiter' && !result?.ledger && <button className="text-button" type="button"
            disabled={chain.busy || simulation.busy} onClick={() => void simulation.run(async () => {
              setResult(null)
              const response = await write<Receipt>('/acciones', { kind: 'probe', opId: id })
              setResult(response)
            })}>{simulation.busy ? 'Comprobando…' : 'Simular la comprobación'}</button>}
          {data.held === 0 && <p className="muted">La prueba estará disponible cuando haya dinero protegido.</p>}
          {chain.feedback}
          <Feedback error={simulation.error} />
          {result?.status === 'failed' && <div className="stack"><Feedback>{result.ledger ?
            'Rechazo registrado en Stellar. El retiro no fue autorizado.' : 'Simulación rechazada. La prueba no se envió a la red.'}</Feedback>
            {result.error && <p className="muted">{result.error}</p>}
            {!!result.ledger && <ExplorerLink base={explorer} hash={result.hash} />}
          </div>}
          {result?.status === 'confirmed' && <div className="stack">
            <Feedback error="La prueba registró un resultado inesperado. Revisa la transacción en el explorador." />
            <ExplorerLink base={explorer} hash={result.hash} />
          </div>}
        </section>
        <section className="section">
          <h2>Transacciones</h2>
          {data.transactions?.length ? data.transactions.map((item, index) => <div className="row receipt-row" key={item.id ?? item.hash ?? index}>
            <span><strong>{transactionNames[item.kind ?? ''] ?? 'Transacción'}</strong><small>
              {item.status === 'confirmed' ? 'Confirmada' : item.status === 'failed' ? 'Rechazada' : 'Confirmando'}
              {item.confirmedAt && ' · ' + formatDate(item.confirmedAt, true)}</small></span>
            {(item.kind !== 'probe' || item.ledger) && <ExplorerLink base={explorer} hash={item.hash} />}
          </div>) : <p className="muted">Los movimientos se muestran al registrarse en la red.</p>}
        </section>
      </div>
    </div>
    {chain.dialog}
  </>
}

export function Notifications() {
  const notices = read<{ items: Notification[]; unread: number }>('/notifications')
  const task = useWork()
  const query = useQueryClient()
  return <>
    <Title action={!!notices.data?.unread && <button className="button secondary" type="button" disabled={task.busy} onClick={() => void task.run(async () => {
      await write('/notifications/seen')
      await query.invalidateQueries({ queryKey: ['/notifications'] })
    })}>Marcar como leídos</button>}>Avisos</Title>
    {notices.isPending && <Loading>Buscando avisos…</Loading>}
    <Feedback error={notices.error ?? task.error} onRetry={notices.isError ? () => void notices.refetch() : undefined} />
    {notices.data && (notices.data.items.length ? <div className="row-list">
      {notices.data.items.map((item) => {
        const trancheId = item.data?.trancheId
        const to = typeof trancheId === 'string' ? conditionPath(item.opId, trancheId) : operationPath(item.opId)
        return <RowLink key={item.id} to={to}
          title={<>{item.unread && <i className="unread-dot" aria-label="Sin leer" />} {eventLabels[item.type] ?? 'Novedad en tu operación'}</>}
          detail={item.unit + ' · ' + formatDate(item.at, true)} />
      })}
    </div> : <Empty title="No tienes avisos">Aquí verás los cambios y confirmaciones de tus operaciones.</Empty>)}
  </>
}
