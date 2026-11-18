import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Landmark } from 'lucide-react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { api, ApiError, operationPath, paymentPath, useSession, write, type DepositOrder } from './api.ts'
import { formatDate, money } from './model.ts'
import { ProtectionPlan } from './plans.tsx'
import { ActionLink, Amount, Back, ExplorerLink, Feedback, Loading, useWork } from './ui.tsx'
import './payment.css'

const bolivianRate = new Intl.NumberFormat('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
const paymentHeadings = {
  review: 'Pagar cuota inicial',
  processing: 'Confirmando el depósito',
  settled: 'Depósito confirmado',
  expired: 'Cotización vencida',
  failed: 'Depósito sin confirmar',
  check: 'Comprueba el estado',
}

const paymentPending = (status?: string) => ['paid', 'pending_confirmation', 'confirming'].includes(status ?? '')
const quoteExpired = (order: DepositOrder) => order.expired || Date.parse(order.expiresAt) <= Date.now()

export function Bank() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const session = useSession()
  const task = useWork()
  const query = useQueryClient()
  const title = useRef<HTMLHeadingElement>(null)
  const focusAfterPayment = useRef(false)
  const [expired, setExpired] = useState('')
  const [needsCheck, setNeedsCheck] = useState('')
  const path = '/anchor/orders/' + encodeURIComponent(id)
  const order = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => api<DepositOrder>(path, { signal }),
    refetchInterval: ({ state }) => {
      const current = state.data
      if (!current || current.status === 'settled') return false
      if (paymentPending(current.status)) return 2400
      if (quoteExpired(current)) return false
      return Math.min(15000, Math.max(250, Date.parse(current.expiresAt) - Date.now()))
    },
  })
  const data = order.data
  const operationId = data?.opId || params.get('operacion')
  const back = operationId ? operationPath(operationId) : '/'
  const stage = data?.status === 'settled' ? 'settled' : paymentPending(data?.status) ? 'processing' :
    id === needsCheck ? 'check' : data && (id === expired || quoteExpired(data)) ? 'expired' :
      data?.status === 'failed' ? 'failed' : 'review'
  const canPay = stage === 'review' || stage === 'failed'
  const canRenew = stage === 'expired' && session.data?.user?.kind === 'buyer' && !!data?.opId

  useEffect(() => {
    if (!focusAfterPayment.current || stage === 'review') return
    title.current?.focus()
    if (stage !== 'processing') focusAfterPayment.current = false
  }, [stage])

  async function pay() {
    if (!data || !canPay) return
    focusAfterPayment.current = true
    if (quoteExpired(data)) {
      setExpired(id)
      return
    }
    await query.cancelQueries({ queryKey: [path], exact: true })
    try {
      const updated = await write<DepositOrder>(path + '/pay')
      query.setQueryData<DepositOrder>([path], (previous) => ({ ...data, ...previous, ...updated }))
      void query.invalidateQueries({ queryKey: ['/ops'] })
      if (operationId) void query.invalidateQueries({ queryKey: ['/ops/' + operationId] })
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        setExpired(id)
        return
      }
      const refreshed = await order.refetch()
      if (refreshed.data?.status === 'settled' || paymentPending(refreshed.data?.status)) return
      if (refreshed.isError && (!(error instanceof ApiError) || error.status >= 500)) setNeedsCheck(id)
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
    {data && <div className="payment-layout">
      <header className="payment-header">
        <h1 ref={title} tabIndex={-1}>{paymentHeadings[stage]}</h1>
        {data.concept && <p>{data.concept.replace(/^Cuota inicial · /, '')}</p>}
      </header>
      <div className="payment-amount">
        <span>{stage === 'settled' ? 'Importe depositado' :
          stage === 'expired' ? 'Cotización anterior' : 'Total del depósito'}</span>
        {stage === 'settled' ? <Amount cents={data.amount} /> : <Amount cents={data.amountBob} currency="Bs" />}
      </div>
      <ProtectionPlan className="payment-plan" protectedFunds={stage === 'settled'} />
      <div className="payment-review">
        <dl className="details payment-details">
          {stage === 'settled' ? <div><dt>Pago simulado</dt><dd>{money(data.amountBob, 'Bs')}</dd></div> :
            <div><dt>{canPay ? 'Quedará protegido' : 'Cuota inicial'}</dt><dd>{money(data.amount)}</dd></div>}
          {canPay && <>
            <div><dt>Tipo de cambio de prueba</dt><dd>Bs {bolivianRate.format(data.rate)} por USD</dd></div>
            <div><dt>Vigente hasta</dt><dd><time dateTime={data.expiresAt}>{formatDate(data.expiresAt, true).replace(/(\d{1,2}:\d{2})\s+([ap]\.)\s+(m\.)/, '$1\u00a0$2\u00a0$3')}</time> (Bolivia)</dd></div>
            {data.beneficiary && <div><dt>Desarrollador</dt><dd>{data.beneficiary}</dd></div>}
          </>}
          {(stage === 'settled' || stage === 'processing' || stage === 'check') && <div><dt>Referencia</dt><dd>{data.reference}</dd></div>}
        </dl>
        <div className="payment-actions">
          {stage === 'settled' ? <>
            <ActionLink to={back}>Volver a mi compra</ActionLink>
            <ExplorerLink base={session.data?.config.explorerUrl} hash={data.txHash}>Ver comprobante público</ExplorerLink>
          </> : stage === 'processing' ? <>
            <p className="payment-note" role="status">Puedes volver a tu compra. El depósito aparecerá allí cuando la red lo confirme.</p>
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
              <p className="payment-note">{stage === 'failed' ? 'Puedes volver a intentar con esta cotización.' : 'El pago se simula con fondos de prueba.'}</p>
              <button className="button primary" type="button" disabled={task.busy} onClick={() => void task.run(pay)}>
                {task.busy ? 'Enviando simulación…' : stage === 'failed' ? 'Reintentar pago simulado' : 'Simular pago bancario'}<ArrowRight size={18} aria-hidden="true" />
              </button>
              {task.busy && <span className="payment-visually-hidden" role="status">Enviando el pago de prueba.</span>}
            </>}
          {stage !== 'settled' && stage !== 'processing' && <Feedback error={task.error} />}
        </div>
      </div>
    </div>}
  </article>
}
