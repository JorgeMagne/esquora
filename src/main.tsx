import { lazy, StrictMode, Suspense, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Bell, Building2, FolderOpen, ReceiptText, UserRound, WalletCards } from 'lucide-react'
import { BrowserRouter, Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useMatch, useSearchParams } from 'react-router'
import type { ReactNode } from 'react'
import { api, operationPath, read, useSession, type Notification, type OperationSummary, type User } from './api.ts'
import { initials, operationLabels, roleNames } from './model.ts'
import { ActionLink, Brand, Empty, Feedback, Loading, RowLink, Title } from './ui.tsx'
import './styles.css'

const PollarSession = lazy(() => import('./session.tsx').then((module) => ({ default: module.PollarSession })))
const Login = lazy(() => import('./session.tsx').then((module) => ({ default: module.Login })))
const Account = lazy(() => import('./session.tsx').then((module) => ({ default: module.Account })))
const Home = lazy(() => import('./workspace.tsx').then((module) => ({ default: module.Home })))
const InvitationPage = lazy(() => import('./workspace.tsx').then((module) => ({ default: module.InvitationPage })))
const ResolverInvitationPage = lazy(() => import('./workspace.tsx').then((module) => ({ default: module.ResolverInvitationPage })))
const ProjectNew = lazy(() => import('./workspace.tsx').then((module) => ({ default: module.ProjectNew })))
const ProjectPage = lazy(() => import('./workspace.tsx').then((module) => ({ default: module.ProjectPage })))
const OperationNew = lazy(() => import('./workspace.tsx').then((module) => ({ default: module.OperationNew })))
const OperationPage = lazy(() => import('./operation.tsx').then((module) => ({ default: module.OperationPage })))
const AgreementPage = lazy(() => import('./operation.tsx').then((module) => ({ default: module.AgreementPage })))
const ConditionPage = lazy(() => import('./operation.tsx').then((module) => ({ default: module.ConditionPage })))
const Bank = lazy(() => import('./payment.tsx').then((module) => ({ default: module.Bank })))
const Notifications = lazy(() => import('./records.tsx').then((module) => ({ default: module.Notifications })))
const Receipts = lazy(() => import('./records.tsx').then((module) => ({ default: module.Receipts })))
const VerificationPage = lazy(() => import('./records.tsx').then((module) => ({ default: module.VerificationPage })))
const WalletPage = lazy(() => import('./records.tsx').then((module) => ({ default: module.WalletPage })))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 30000,
      retry: false,
    },
    mutations: { retry: false },
  },
})

function watchesOperations(path: string) {
  return path === '/ops' || path === '/notifications' || path.startsWith('/projects') ||
    path.startsWith('/invitations/') || path.startsWith('/resolver-invitations/') ||
    (path.startsWith('/tranches/') && path.endsWith('/resolution-instruction'))
}

function LiveUpdates({ userId }: { userId: string }) {
  const query = useQueryClient()
  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return
      void query.refetchQueries({
        type: 'active',
        predicate: ({ queryKey }) => {
          const path = String(queryKey[0])
          return watchesOperations(path) || /^\/ops\/[^/]+$/.test(path)
        },
      }, { cancelRefetch: false })
    }
    const stream = new EventSource('/api/stream')
    stream.onopen = refreshVisible
    stream.onmessage = (message) => {
      try {
        const update = JSON.parse(message.data) as { type: string; id?: string }
        if (update.type === 'op' && typeof update.id === 'string') {
          const operation = '/ops/' + encodeURIComponent(update.id)
          void query.invalidateQueries({ predicate: ({ queryKey }) => {
            const path = String(queryKey[0])
            return watchesOperations(path) || path === operation || path === operation + '/verification'
          } })
        }
        if (update.type === 'wallet') void query.invalidateQueries({ queryKey: ['/wallet'] })
      } catch { /* Ignorar un aviso inválido y mantener la conexión. */ }
    }
    const poll = window.setInterval(refreshVisible, 5000)
    window.addEventListener('online', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      stream.close()
      window.clearInterval(poll)
      window.removeEventListener('online', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [userId, query])
  return null
}

function Shell({ user, children }: { user?: User | null; children: ReactNode }) {
  const location = useLocation()
  const op = useMatch('/operaciones/:id/*')
  const home = user?.kind === 'developer' ? { label: 'Proyectos', icon: Building2 } : user?.kind === 'arbiter' ?
    { label: 'Casos', icon: FolderOpen } : { label: 'Mis compras', icon: Building2 }
  const middle = user?.kind === 'developer' ? { label: 'Mi saldo', path: '/saldo', icon: WalletCards } : user?.kind === 'arbiter' ?
    { label: 'Avisos', path: '/avisos', icon: Bell } :
    { label: 'Comprobantes', path: op?.params.id ? operationPath(op.params.id) + '/comprobantes' : '/comprobantes', icon: ReceiptText }
  const signedIn = !!user?.kind
  const notices = useQuery({
    queryKey: ['/notifications'],
    queryFn: ({ signal }) => api<{ items: Notification[]; unread: number }>('/notifications', { signal }),
    enabled: signedIn,
  })
  const unread = notices.data?.unread ?? 0
  const homeActive = location.pathname === '/' || (user?.kind === 'buyer' && !!op && !location.pathname.endsWith('/comprobantes'))

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [location.pathname])

  return <div className={'app-frame' + (signedIn ? ' signed-in' : '')}>
    <a href="#contenido" className="skip-link">Ir al contenido</a>
    <header className="app-header">
      <div className="header-inner">
        <Brand />
        {signedIn && <nav className="desktop-nav" aria-label="Principal">
          <Link to="/" aria-current={homeActive ? 'page' : undefined}>{home.label}</Link>
          <NavLink to={middle.path}>{middle.label}</NavLink>
          {user.kind === 'buyer' && <NavLink to="/saldo">Mi saldo</NavLink>}
        </nav>}
        <div className="header-actions">
          <span className="test-label">Entorno de pruebas</span>
          {signedIn && <Link className="icon-button notify-link" to="/avisos" aria-label={unread ? 'Avisos, ' + unread + ' sin leer' : 'Avisos'}>
            <Bell size={19} aria-hidden="true" />{unread > 0 && <i aria-hidden="true" />}
          </Link>}
          {user && <Link className="avatar" to="/cuenta" aria-label="Mi cuenta">{initials(user.name)}</Link>}
        </div>
      </div>
    </header>
    <main id="contenido" className="page" tabIndex={-1}><Suspense fallback={<Loading />}>{children}</Suspense></main>
    {signedIn && <nav className="mobile-nav" aria-label="Principal">
      <Link to="/" aria-current={homeActive ? 'page' : undefined}>
        <home.icon size={21} aria-hidden="true" />{home.label}</Link>
      <NavLink to={middle.path}><middle.icon size={21} aria-hidden="true" />{middle.label}</NavLink>
      <NavLink to="/cuenta"><UserRound size={21} aria-hidden="true" />Cuenta</NavLink>
    </nav>}
    {signedIn && <LiveUpdates userId={user.id} />}
  </div>
}

function AccountOnly({ user }: { user: User }) {
  return <>
    <Account user={user} />
    {user.kind === 'buyer' && <div className="account-saldo"><ActionLink to="/saldo">Ver mi saldo</ActionLink></div>}
  </>
}

function SessionNotice({ user }: { user: User }) {
  if (user.walletStatus === 'active') return null
  return <div className="account-notice"><span>Activa tu cuenta para confirmar operaciones.</span>
    <Link to="/cuenta">Ir a mi cuenta<ArrowRight size={15} aria-hidden="true" /></Link>
  </div>
}

function ReceiptDirectory() {
  const operations = read<OperationSummary[]>('/ops')
  if (operations.isPending) return <Loading />
  if (operations.isError) return <Feedback error={operations.error} onRetry={() => void operations.refetch()} />
  return <>
    <Title>Comprobantes</Title>
    {operations.data.length ? <div className="row-list">
      {operations.data.map((operation) => <RowLink key={operation.id} to={operationPath(operation.id) + '/comprobantes'}
        title={operation.unit + ' · ' + operation.project.name} detail={operationLabels[operation.status]} />)}
    </div> : <Empty title="Todavía no hay comprobantes">Los encontrarás aquí cuando se registren movimientos en tu compra.</Empty>}
  </>
}

function Protected({ user, kind, children }: { user?: User | null; kind?: User['kind']; children: ReactNode }) {
  const location = useLocation()
  const returnTo = encodeURIComponent(location.pathname + location.search)
  if (!user) return <Navigate to={'/entrar?volver=' + returnTo} replace />
  if (!user.kind) return <Navigate to={'/cuenta?volver=' + returnTo} replace />
  if (kind && user.kind !== kind) return <><Title>Acceso a la operación</Title><Feedback error={'Esta pantalla requiere una cuenta de ' + roleNames[kind].toLowerCase() + '.'} /><ActionLink to="/">Volver al inicio</ActionLink></>
  return <>{children}</>
}

function App() {
  const session = useSession()
  const user = session.data?.user
  const [params] = useSearchParams()
  if (session.isPending) return <Shell><Loading>Abriendo ESQUORA…</Loading></Shell>
  if (session.isError) return <Shell><Feedback error={session.error} onRetry={() => void session.refetch()} /></Shell>

  return <Routes>
    <Route path="/pago/:id" element={<main className="bank-shell"><Suspense fallback={<Loading />}>
      <Protected user={user} kind="buyer"><Bank /></Protected>
    </Suspense></main>} />
    <Route path="*" element={<Shell user={user}>
      <Routes>
        <Route path="/invitacion/:token" element={<InvitationPage />} />
        <Route path="/tercero/:token" element={<ResolverInvitationPage />} />
        <Route path="/" element={user ? <Protected user={user}><SessionNotice user={user} /><Home user={user} /></Protected> :
          <PollarSession><Login /></PollarSession>} />
        <Route element={<PollarSession><Outlet /></PollarSession>}>
          <Route path="/entrar" element={<Login />} />
          <Route path="/cuenta" element={user ? <AccountOnly key={user.id} user={user} /> :
            <Navigate to={'/entrar?volver=' + encodeURIComponent(params.get('volver') || '/cuenta')} replace />} />
          <Route path="/operaciones/:id" element={<Protected user={user}><OperationPage /></Protected>} />
          <Route path="/operaciones/:id/acuerdo" element={<Protected user={user}><AgreementPage /></Protected>} />
          <Route path="/operaciones/:id/condiciones/:trancheId" element={<Protected user={user}><ConditionPage /></Protected>} />
          <Route path="/operaciones/:id/verificacion" element={<Protected user={user}><VerificationPage /></Protected>} />
          <Route path="/saldo" element={<Protected user={user}><WalletPage /></Protected>} />
        </Route>
        <Route path="/proyectos/nuevo" element={<Protected user={user} kind="developer"><ProjectNew /></Protected>} />
        <Route path="/proyectos/:id" element={<Protected user={user} kind="developer"><ProjectPage /></Protected>} />
        <Route path="/proyectos/:id/nueva-operacion" element={<Protected user={user} kind="developer"><OperationNew /></Protected>} />
        <Route path="/operaciones/:id/comprobantes" element={<Protected user={user}><Receipts /></Protected>} />
        <Route path="/comprobantes" element={<Protected user={user}><ReceiptDirectory /></Protected>} />
        <Route path="/avisos" element={<Protected user={user}><Notifications /></Protected>} />
        <Route path="*" element={<><Title>Esta página no está disponible</Title><ActionLink to="/">Volver al inicio</ActionLink></>} />
      </Routes>
    </Shell>} />
  </Routes>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter><App /></BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
