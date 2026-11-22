import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PollarClient } from '@pollar/core'
import { PollarProvider, usePollar } from '@pollar/react'
import { ArrowRight, CircleCheck, LogOut, Mail } from 'lucide-react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { useSession, write, type Session, type User } from './api.ts'
import { initials, roleNames, wait } from './model.ts'
import { AccessPlan } from './plans.tsx'
import { ActionLink, Feedback, Field, Loading, Submit, Title, useWork } from './ui.tsx'
import '@pollar/react/styles.css'

const sessionKey = ['/me']
const pollarKey: string = import.meta.env.VITE_POLLAR_PUBLISHABLE_KEY || ''
const pollarClient = new PollarClient({ apiKey: pollarKey, stellarNetwork: 'testnet' })

export function PollarSession({ children }: { children: ReactNode }) {
  return <PollarProvider client={pollarClient}>{children}</PollarProvider>
}

export function safeReturn(path: string | null) {
  return path && path.split(/[?#]/, 1)[0] !== '/' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? path : '/app'
}

export function useChangeSession() {
  const query = useQueryClient()
  return useCallback((session: Session) => {
    query.cancelQueries({ predicate: (entry) => entry.queryKey[0] !== '/me' }).catch(() => {})
    query.removeQueries({ predicate: (entry) => entry.queryKey[0] !== '/me' })
    query.setQueryData(sessionKey, session)
  }, [query])
}

export function useAuthorize() {
  const pollar = usePollar()
  const user = useSession().data?.user
  return () => {
    if (!pollar.verified || !pollar.wallet || pollar.wallet.address !== user?.publicKey) {
      throw new Error('Vuelve a entrar con la cuenta de esta operación para confirmar.')
    }
    return pollar.getClient()
  }
}

const activationReasons: Record<NonNullable<User['kind']>, string> = {
  developer: 'Es un paso único para firmar acuerdos y recibir los tramos liberados.',
  buyer: 'Es un paso único para firmar tu acuerdo y depositar el adelanto.',
  arbiter: 'Es un paso único para aceptar casos y ejecutar resoluciones.',
}

function useActivation(user: User) {
  const session = useSession()
  const authorize = useAuthorize()
  const pollar = usePollar()
  const location = useLocation()
  const work = useWork()
  const [message, setMessage] = useState('')
  const matchesPollar = pollar.verified && pollar.wallet?.address === user.publicKey
  const reconnectPath = '/entrar?reconectar=1&volver=' + encodeURIComponent(location.pathname + location.search)

  async function activate() {
    setMessage('')
    const client = authorize()
    const prepare = () => write<{ status: string; needsTrustline?: boolean }>('/wallet/activate')
    const result = await prepare()
    if (result.status !== 'active' && result.needsTrustline) {
      const asset = session.data!.config.asset
      const trustline = await client.setTrustline(asset)
      if (trustline.status !== 'success' && trustline.status !== 'pending') {
        throw new Error('La activación no se confirmó. Vuelve a intentar y acepta en la ventana de confirmación.')
      }
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if ((await prepare()).status === 'active') break
        await wait(1800)
      }
    }
    const next = await session.refetch()
    setMessage(next.data?.user?.walletStatus === 'active' ? 'Tu cuenta ya está activa.' : 'La activación sigue confirmándose. Vuelve a comprobarla en unos segundos.')
  }

  return { busy: work.busy, error: work.error, message, matchesPollar, reconnectPath, start: () => void work.run(activate) }
}

export function ActivationNotice({ user }: { user: User }) {
  const activation = useActivation(user)
  const active = user.walletStatus === 'active'
  const [showDone, setShowDone] = useState(false)
  useEffect(() => {
    if (!active || !activation.message) return
    setShowDone(true)
    const timer = window.setTimeout(() => setShowDone(false), 4000)
    return () => window.clearTimeout(timer)
  }, [active, activation.message])

  if (!user.kind) return null
  if (active) return showDone ? <p className={'activation-done activation-' + user.kind} role="status">
    <CircleCheck size={18} aria-hidden="true" />Tu cuenta ya está activa.
  </p> : null
  return <section className={'activation-card activation-' + user.kind} aria-labelledby="activation-title">
    <div className="activation-copy">
      <h2 id="activation-title">Activa tu cuenta</h2>
      <p>{activationReasons[user.kind]} Es posible que aparezca una ventana en inglés para confirmar.</p>
      <Feedback error={activation.error}>{activation.message}</Feedback>
    </div>
    {activation.matchesPollar ?
      <button className="button primary" type="button" onClick={activation.start} disabled={activation.busy}>
        {activation.busy ? 'Confirmando…' : 'Activar mi cuenta'}<ArrowRight size={18} aria-hidden="true" />
      </button> : <ActionLink to={activation.reconnectPath}>Reconectar mi cuenta</ActionLink>}
  </section>
}

export function Login() {
  const pollar = usePollar()
  const session = useSession()
  const [params] = useSearchParams()
  const changeSession = useChangeSession()
  const destination = safeReturn(params.get('volver'))
  const reauthenticate = params.get('reconectar') === '1'
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const exchanged = useRef<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [serverError, setServerError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [creating, setCreating] = useState(false)
  const client = pollar.getClient()
  const [state, setState] = useState(() => client.getAuthState())
  useEffect(() => {
    setState(client.getAuthState())
    return client.onAuthStateChange(setState)
  }, [client])
  const token = state.step === 'authenticated' && state.verified ? state.session.token.accessToken : null
  const wallet = pollar.wallet?.address
  const current = session.data?.user
  const activeSession = !!current && (!reauthenticate || (pollar.verified && wallet === current.publicKey))
  const setupTarget = '/cuenta?volver=' + encodeURIComponent(destination)

  useEffect(() => {
    if (activeSession || (reauthenticate && current) || !token || !wallet || exchanged.current === token) return
    exchanged.current = token
    setConnecting(true)
    setServerError(null)
    void write<Session>('/auth/pollar', { token }).then(changeSession).catch((error: Error) => {
      setServerError(error.message)
    }).finally(() => setConnecting(false))
  }, [activeSession, current, reauthenticate, token, wallet, retry, changeSession])

  const enterCode = state.step === 'entering_code' || state.step === 'verifying_email_code' ||
    (state.step === 'error' && !!state.clientSessionId && !!state.email)
  const sending = ['creating_session', 'sending_email', 'opening_oauth', 'authenticating'].includes(state.step)
  const checking = state.step === 'verifying_email_code'
  const wrongWallet = reauthenticate && current && pollar.verified && wallet && wallet !== current.publicKey
  const authError = state.step === 'error' ?
    enterCode ? 'No pudimos verificar el código. Revísalo o solicita uno nuevo.' : 'No pudimos iniciar sesión. Vuelve a intentar.' : null

  if (session.isPending) return <Loading>Abriendo la sesión…</Loading>
  if (session.isError) return <Feedback error={session.error} onRetry={() => void session.refetch()} />
  if (activeSession) return <Navigate to={current?.kind ? destination : setupTarget} replace />

  return <div className="access-layout">
    <section className="access-copy">
      <h1>Entra a tu cuenta</h1>
      <p>Consulta tu operación, revisa sus condiciones y encuentra tus comprobantes.</p>
    </section>
    <section className="access-form" aria-label="Métodos de acceso">
      {!pollarKey ? <Feedback error="El acceso todavía no está disponible en este entorno." /> : <>
        <Feedback error={serverError || authError} onRetry={serverError ? () => {
          exchanged.current = null
          setRetry((previous) => previous + 1)
        } : undefined} />
        {connecting || (state.step === 'authenticated' && !state.verified) ? <Loading>Verificando tu sesión…</Loading> :
          wrongWallet ? <>
            <Feedback error="Usa la cuenta con la que abriste esta operación." />
            <button className="button secondary" type="button" onClick={() => pollar.logout()}>Usar otra cuenta</button>
          </> : token && !wallet ? <div className="stack">
            <p>Prepara tu cuenta para guardar y confirmar operaciones.</p>
            <button className="button primary" type="button" disabled={creating} onClick={async () => {
              setCreating(true)
              try { await pollar.createWallet() }
              catch { setServerError('No pudimos preparar tu cuenta. Vuelve a intentar.') }
              finally { setCreating(false) }
            }}>Preparar mi cuenta<ArrowRight size={18} aria-hidden="true" /></button>
          </div> : enterCode ? <form className="stack" onSubmit={(event) => {
            event.preventDefault()
            pollar.getClient().verifyEmailCode(code.trim())
          }}>
            <p>Usa el código que enviamos a <strong>{state.email ?? email}</strong>.</p>
            <Field label="Código de acceso"><input name="code" inputMode="numeric" autoComplete="one-time-code"
              value={code} onChange={(event) => setCode(event.target.value)} required autoFocus /></Field>
            <Submit waiting={checking}>Confirmar código</Submit>
            <button className="text-button" type="button" disabled={checking} onClick={() => {
              pollar.getClient().cancelLogin()
              setCode('')
              pollar.login({ provider: 'email', email: state.email || email })
            }}>Enviar un código nuevo</button>
            <button className="text-button" type="button" disabled={checking} onClick={() => {
              pollar.getClient().cancelLogin()
              setCode('')
            }}>Usar otro correo</button>
          </form> : <>
            <form className="stack" onSubmit={(event) => {
              event.preventDefault()
              pollar.login({ provider: 'email', email: email.trim() })
            }}>
              <Field label="Correo electrónico"><input name="email" type="email" autoComplete="email"
                value={email} onChange={(event) => setEmail(event.target.value)} placeholder="nombre@correo.com" required /></Field>
              <Submit waiting={sending}>Recibir código por correo</Submit>
            </form>
            <div className="separator" aria-hidden="true"><span>o</span></div>
            <button className="button secondary" type="button" disabled={sending} onClick={() => pollar.login({ provider: 'google' })}>
              Continuar con Google<ArrowRight size={18} aria-hidden="true" />
            </button>
            {sending && <button className="text-button" type="button" onClick={() => pollar.getClient().cancelLogin()}>Cancelar acceso</button>}
          </>}
      </>}
    </section>
    {!reauthenticate && <aside className="access-hint" aria-label="Cómo probar la demo">
      <h2>Para recorrer la demo completa</h2>
      <p>Crea dos cuentas con correos distintos: una como <strong>Desarrollador</strong>, que ofrece el inmueble, y otra como <strong>Comprador</strong>.</p>
      <p>Al definir la resolución, elige <strong>Invitar a un tercero</strong> y escribe <strong className="access-hint-email">amagnesoto@gmail.com</strong>. El equipo de ESQUORA actuará como tercero designado.</p>
    </aside>}
    <div className="access-drawing"><AccessPlan /></div>
  </div>
}

export function Account({ user }: { user: User }) {
  const session = useSession()
  const pollar = usePollar()
  const task = useWork()
  const activation = useActivation(user)
  const logout = useWork()
  const [params] = useSearchParams()
  const destination = safeReturn(params.get('volver'))
  const [kind, setKind] = useState(user.kind || (user.esquoraVerifier || destination.startsWith('/tercero/') ?
    'arbiter' : destination.startsWith('/invitacion/') ? 'buyer' : ''))
  const [saved, setSaved] = useState(false)
  const query = useQueryClient()
  const navigate = useNavigate()
  const changeSession = useChangeSession()
  const active = user.walletStatus === 'active'

  return <>
    <Title detail={user.kind ? roleNames[user.kind] : 'Elige cómo vas a participar en una operación.'}>{user.kind ? 'Mi cuenta' : 'Completa tu perfil'}</Title>
    <div className="two-column">
      <section className="section">
        {user.kind && <h2>Datos de contacto</h2>}
        <div className="profile-email"><span className="avatar" aria-hidden="true">{initials(user.name)}</span><Mail size={17} aria-hidden="true" />{user.email}</div>
        <form className="stack" onSubmit={task.submit(async (data) => {
          setSaved(false)
          const firstSetup = !user.kind
          const updated = await write<{ user: User }>('/me', Object.fromEntries(data), 'PATCH')
          query.setQueryData<Session>(sessionKey, (previous) => previous ? { ...previous, user: updated.user } : previous)
          if (firstSetup && updated.user.kind) navigate(destination, { replace: true })
          else setSaved(true)
        })}>
          {!user.kind && user.esquoraVerifier && <>
            <input type="hidden" name="kind" value="arbiter" />
            <p>Esta cuenta está designada para verificar y ejecutar resoluciones de ESQUORA.</p>
          </>}
          {!user.kind && !user.esquoraVerifier && <Field label="Tipo de cuenta"><select name="kind" required value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">Selecciona una opción</option>
            {Object.entries(roleNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></Field>}
          <Field label="Nombre completo"><input name="name" autoComplete="name" defaultValue={user.name} maxLength={120} required /></Field>
          {kind && kind !== 'buyer' && <Field label={kind === 'developer' ? 'Empresa o inmobiliaria' : 'Institución'}>
            <input name="orgName" autoComplete="organization" defaultValue={user.orgName ?? ''} maxLength={160} required />
          </Field>}
          {kind === 'developer' && <Field label="NIT"><input name="orgNit" defaultValue={user.orgNit ?? ''} maxLength={40} required /></Field>}
          <Field label="Teléfono (opcional)"><input name="phone" type="tel" autoComplete="tel" defaultValue={user.phone ?? ''} maxLength={40} /></Field>
          <Feedback error={task.error}>{saved && 'Perfil guardado.'}</Feedback>
          <Submit waiting={task.busy}>Guardar perfil</Submit>
        </form>
      </section>
      {user.kind && <section className="section">
        <h2>{active ? 'Cuenta activa' : 'Activa tu cuenta'}</h2>
        <p>{active ? 'Ya puedes participar en una operación.' : 'La activación habilita los movimientos de prueba de tu cuenta. Es posible que aparezca una ventana en inglés para confirmar.'}</p>
        <Feedback error={activation.error}>{activation.message}</Feedback>
        {!active && (activation.matchesPollar ?
          <button className="button primary" type="button" onClick={activation.start} disabled={activation.busy}>
            {activation.busy ? 'Confirmando…' : 'Activar mi cuenta'}<ArrowRight size={18} aria-hidden="true" />
          </button> : <ActionLink to={activation.reconnectPath}>Reconectar mi cuenta</ActionLink>)}
        {active && params.has('volver') && <ActionLink to={destination}>Continuar</ActionLink>}
        <div className="sign-out">
          <Feedback error={logout.error} />
          <button className="text-button" type="button" disabled={logout.busy} onClick={() => void logout.run(async () => {
            await pollar.getClient().logout()
            await write('/auth/logout')
            if (session.data) changeSession({ ...session.data, user: null })
          })}><LogOut size={17} aria-hidden="true" />Cerrar sesión</button>
        </div>
      </section>}
    </div>
  </>
}
