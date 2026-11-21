import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Landmark } from 'lucide-react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { api, ApiError, depositInProgress, operationPath, paymentPath, useSession, write, type DepositOrder } from './api.ts'
import { formatDate, money } from './model.ts'
import { ProtectionPlan } from './plans.tsx'
import { VaultFlight } from './deposit-vault.tsx'
import { ActionLink, Amount, Back, ExplorerLink, Feedback, Loading, useWork } from './ui.tsx'
import './payment.css'

const bolivianRate = new Intl.NumberFormat('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
const paymentHeadings = {
  review: 'Pagar cuota inicial',
  queued: 'Preparando el depósito',
  processing: 'Confirmando el depósito',
  settled: 'Depósito confirmado',
  expired: 'Cotización vencida',
  failed: 'Depósito sin confirmar',
  check: 'Comprueba el estado',
}

const quoteExpired = (order: DepositOrder) => order.expired || Date.parse(order.expiresAt) <= Date.now()
const requestTimeout = 10_000

export function Bank() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const session = useSession()
  const task = useWork()
  const query = useQueryClient()
  const title = useRef<HTMLHeadingElement>(null)
  const plan = useRef<SVGGElement>(null)
  const focusAfterPayment = useRef(false)
  const [expired, setExpired] = useState('')
  const [needsCheck, setNeedsCheck] = useState('')
  const path = '/anchor/orders/' + encodeURIComponent(id)
  const order = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => api<DepositOrder>(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)]) }),
    refetchInterval: ({ state }) => {
      const current = state.data
      if (!current || current.status === 'settled') return false
      if (depositInProgress(current.status)) return 2400
      if (quoteExpired(current)) return false
      return Math.min(15000, Math.max(250, Date.parse(current.expiresAt) - Date.now()))
    },
  })
  const data = order.data
  const [observedOrder, setObservedOrder] = useState('')
  useEffect(() => {
    if (data && data.status !== 'settled') setObservedOrder(id)
  }, [data, id])
  const showDepositArrival = data?.status === 'settled' && observedOrder === id
  const operationId = data?.opId || params.get('operacion')
  const back = operationId ? operationPath(operationId) : '/'
  const stage = data?.status === 'settled' ? 'settled' : data?.status === 'queued' ? 'queued' : depositInProgress(data?.status) ? 'processing' :
    id === needsCheck ? 'check' : data && (id === expired || quoteExpired(data)) ? 'expired' :
      data?.status === 'failed' ? 'failed' : 'review'
  const canPay = stage === 'review' || stage === 'failed'
  const canRenew = stage === 'expired' && session.data?.user?.kind === 'buyer' && !!data?.opId
  const waitingForDeposit = stage === 'queued' || stage === 'processing'

  useEffect(() => {
    if (!focusAfterPayment.current || stage === 'review') return
    title.current?.focus({ preventScroll: stage === 'settled' })
    if (stage !== 'queued' && stage !== 'processing') focusAfterPayment.current = false
  }, [stage])

  useEffect(() => {
    if (data?.status !== 'settled' && data?.status !== 'failed') return
    void query.invalidateQueries({ queryKey: ['/ops'] })
    if (operationId) void query.invalidateQueries({ queryKey: ['/ops/' + operationId] })
  }, [data?.status, operationId, query])

  async function pay() {
    if (!data || !canPay) return
    focusAfterPayment.current = true
    if (quoteExpired(data)) {
      setExpired(id)
      return
    }
    await query.cancelQueries({ queryKey: [path], exact: true })
    try {
      const updated = await api<DepositOrder>(path + '/pay', { method: 'POST', signal: AbortSignal.timeout(requestTimeout) })
      query.setQueryData<DepositOrder>([path], (previous) => ({ ...data, ...previous, ...updated }))
      void query.invalidateQueries({ queryKey: ['/ops'] })
      if (operationId) void query.invalidateQueries({ queryKey: ['/ops/' + operationId] })
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        setExpired(id)
        return
      }
      const needsVerification = !(error instanceof ApiError) || error.status >= 500
      if (needsVerification) setNeedsCheck(id)
      const refreshed = await order.refetch()
      if (!refreshed.isError && (refreshed.data?.status === 'settled' || depositInProgress(refreshed.data?.status))) {
        setNeedsCheck('')
        return
      }
      throw error
    }
  }

  async function renew() {
    if (!canRenew || !data?.opId) return
    const opId = data.opId
    const next = await write<DepositOrder>('/ops/' + encodeURIComponent(opId) + '/deposit')
    navigate(paymentPath(next.id) + '?operacion=' + encodeURIComponent(opId), { replace: true })
  }

  return <article className="payment-sheet">
    <div className="payment-top">
      {stage !== 'settled' && (stage !== 'expired' || canRenew) && <Back to={back}>Volver a la operación</Back>}
      <span className="payment-environment"><Landmark size={17} aria-hidden="true" />Banco de prueba</span>
    </div>
    {order.isPending && <Loading>Consultando el pago…</Loading>}
    {!data && order.isError && <Feedback error={order.error} onRetry={() => void order.refetch()} />}
    {data && <div className={'payment-layout' + (stage === 'settled' ? ' payment-secured' : '')}>
      <header className="payment-header">
        <h1 ref={title} tabIndex={-1} aria-live="polite" aria-atomic="true">{showDepositArrival ?
          <>Tu dinero ahora está <span className="deposit-protected-word">protegido.</span></> : paymentHeadings[stage]}</h1>
        {data.concept && <p>{data.concept.replace(/^Cuota inicial · /, '')}</p>}
      </header>
      <div className="payment-amount">
        <span>{stage === 'settled' ? 'Depósito confirmado en Stellar Testnet' :
          stage === 'expired' ? 'Cotización anterior' : 'Total del depósito'}</span>
        {stage === 'settled' ? <Amount cents={data.amount} currency="USDC" /> : <Amount cents={data.amountBob} currency="Bs" />}
      </div>
      <ProtectionPlan className="payment-plan" planRef={plan} settled={stage === 'settled'} />
      {showDepositArrival && <VaultFlight key={id} plan={plan} />}
      <div className="payment-review">
        <dl className="details payment-details">
          {stage === 'settled' ? <div><dt>Pagaste en bolivianos de prueba</dt><dd>{money(data.amountBob, 'Bs')}</dd></div> :
            <div><dt>{canPay ? 'Quedará protegido' : 'Cuota inicial'}</dt><dd>{money(data.amount)}</dd></div>}
          {canPay && <>
            <div><dt>Tipo de cambio de prueba</dt><dd>Bs {bolivianRate.format(data.rate)} por USD</dd></div>
            <div><dt>Vigente hasta</dt><dd><time dateTime={data.expiresAt}>{formatDate(data.expiresAt, true).replace(/(\d{1,2}:\d{2})\s+([ap]\.)\s+(m\.)/, '$1\u00a0$2\u00a0$3')}</time> (Bolivia)</dd></div>
            {data.beneficiary && <div><dt>Desarrollador</dt><dd>{data.beneficiary}</dd></div>}
          </>}
          {(stage === 'settled' || waitingForDeposit || stage === 'check') && <div><dt>Referencia</dt><dd>{data.reference}</dd></div>}
        </dl>
        <div className="payment-actions">
          {stage === 'settled' ? <>
            <ActionLink to={back}>Volver a mi compra</ActionLink>
            <ExplorerLink base={session.data?.config.explorerUrl} hash={data.txHash}>Ver comprobante público</ExplorerLink>
          </> : waitingForDeposit ? <>
            <p className="payment-note" role="status">{stage === 'queued' ?
              'El banco de prueba recibió la orden. El estado se actualizará automáticamente.' :
              'El depósito se envió a Stellar. Puedes esperar aquí o volver a tu compra.'}</p>
            {order.isRefetchError && <Feedback error="No pudimos consultar el estado del depósito." onRetry={() => void order.refetch()} />}
          </> :
            stage === 'expired' ? <>
              <p className="payment-note">Actualiza la cotización para revisar el nuevo importe antes de simular el pago.</p>
              {canRenew ? <button className="button primary" type="button" disabled={task.busy} onClick={() => void task.run(renew)}>
                {task.busy ? 'Actualizando…' : 'Actualizar cotización'}<ArrowRight size={18} aria-hidden="true" />
              </button> : <Link className="button primary" to={back}>Actualizar desde la operación<ArrowRight size={18} aria-hidden="true" /></Link>}
            </> : stage === 'check' ? <>
              <p className="payment-note">Consulta el estado del depósito antes de hacer otro intento.</p>
              <button className="button primary" type="button" disabled={task.busy} onClick={() => void task.run(async () => {
                const refreshed = await order.refetch()
                if (refreshed.isError) throw refreshed.error
                setNeedsCheck('')
              })}>{task.busy ? 'Consultando…' : 'Comprobar estado'}<ArrowRight size={18} aria-hidden="true" /></button>
            </> : <>
              <p className="payment-note">{stage === 'failed' ? data.error || 'Puedes volver a intentar con esta cotización.' :
                'El pago se simula con fondos de prueba.'}</p>
              <button className="button primary" type="button" disabled={task.busy} onClick={() => void task.run(pay)}>
                {task.busy ? 'Enviando simulación…' : stage === 'failed' ? 'Reintentar pago simulado' : 'Simular pago bancario'}<ArrowRight size={18} aria-hidden="true" />
              </button>
              {task.busy && <span className="payment-visually-hidden" role="status">Enviando el pago de prueba.</span>}
            </>}
          {stage !== 'settled' && !waitingForDeposit && <Feedback error={task.error} />}
        </div>
      </div>
    </div>}
  </article>
}
