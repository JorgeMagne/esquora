// Fase 0, S7 y S8: página desechable para probar Pollar con una persona real.
// Abrir con el servidor de prueba (scripts/spikes/pollar-server.ts) y Vite: /scripts/spikes/pollar/index.html

import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PollarProvider, usePollar } from '@pollar/react'
import '@pollar/react/styles.css'

const CIRCLE_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const MENSAJE = 'esquora:acuerdo:sha256:' + '9c2e'.repeat(16)

async function api(path: string, body?: unknown) {
  const res = await fetch('/spike' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
  return j
}
const record = (key: string, value: unknown) => api('/record', { key, value }).catch(() => {})

type Log = { paso: string; ok: boolean | null; detalle: unknown }

function Pruebas() {
  const p = usePollar()
  const [log, setLog] = useState<Log[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const sawConfirmation = useRef(false)
  useEffect(() => { if (p.confirmations.length > 0) sawConfirmation.current = true }, [p.confirmations])

  const add = (paso: string, ok: boolean | null, detalle: unknown) => setLog((l) => [{ paso, ok, detalle }, ...l])
  const address = p.wallet?.address ?? null

  async function run(paso: string, fn: () => Promise<{ ok: boolean | null; detalle: unknown }>) {
    setBusy(paso)
    try { const r = await fn(); add(paso, r.ok, r.detalle) } catch (e) { add(paso, false, String((e as Error).message)) }
    setBusy(null)
  }

  const verify = () => run('S7 · verificar token en el servidor', async () => {
    const st: any = p.getClient().getAuthState()
    const token = st?.session?.token?.accessToken
    if (!token) return { ok: false, detalle: `sin token (paso: ${st?.step})` }
    const r = await api('/s7/verify', { token })
    return { ok: r.ok && r.wallet?.address === address, detalle: r }
  })

  const trustline = () => run('S7 · línea de confianza USDC de Circle', async () => {
    const r: any = await p.setTrustline({ code: 'USDC', issuer: CIRCLE_USDC_ISSUER })
    await record('S7_lineaConfianza', { status: r.status, code: r.code, details: r.details, hash: r.hash })
    return { ok: r.status === 'success' || r.status === 'pending', detalle: r }
  })

  const sep53 = () => run('S7 · firmar la huella del acuerdo (SEP-53)', async () => {
    sawConfirmation.current = false
    const r: any = await p.getClient().stellar.sep53.signMessage(MENSAJE)
    if (r.status !== 'signed') { await record('S7_signMessage', { ok: false, ...r }); return { ok: false, detalle: r } }
    const v = await api('/s7/sep53', { message: MENSAJE, signature: r.signature, signerAddress: r.signerAddress, expected: address })
    return { ok: v.ok, detalle: { ...v, ventanaDeConfirmacion: sawConfirmation.current } }
  })

  const prepare = () => run('Preparar escrow (servidor)', async () => {
    const r = await api('/prepare', { address })
    return { ok: true, detalle: r }
  })

  async function signTxStep(xdr: string) {
    sawConfirmation.current = false
    const t0 = performance.now()
    const r: any = await p.getClient().signTx(xdr, { skipSponsorship: true })
    return { r, ms: Math.round(performance.now() - t0), ventana: sawConfirmation.current }
  }

  const approve = () => run('S7 · signTx: confirmar tramo 1 (transacción de Trustless Work)', async () => {
    const { xdr } = await api('/s7/approve-xdr')
    const { r, ms, ventana } = await signTxStep(xdr)
    await record('S7_ventanaConfirmacion', { aparecio: ventana, politica: (p.appConfig as any)?.application?.signConfirmation ?? null })
    if (r.status !== 'signed') { await record('S7_signTx_TrustlessWork', { ok: false, status: r.status, code: r.code, details: r.details, message: r.message }); return { ok: false, detalle: r } }
    const s = await api('/s7/approve-submit', { signedXdr: r.signedXdr, ms })
    return { ok: s.ok, detalle: { ...s, ventanaDeConfirmacion: ventana } }
  })

  const routeA = () => run('S8 · ruta A: signTx de la resolución (origen = cuenta 2 de 3)', async () => {
    const x = await api('/s8a/xdr')
    const { r, ms, ventana } = await signTxStep(x.xdr)
    if (r.status !== 'signed') {
      const out = { ok: false, status: r.status, code: r.code, details: r.details, message: r.message, ms, ventana }
      await record('S8_rutaA_signTx', out)
      return { ok: false, detalle: out }
    }
    const s = await api('/s8a/submit', { signedXdr: r.signedXdr, ms })
    return { ok: s.ok, detalle: s }
  })

  const routeB = () => run('S8 · ruta B: signAuthEntry (origen = plataforma)', async () => {
    const e = await api('/s8b/entry')
    sawConfirmation.current = false
    const t0 = performance.now()
    const r: any = await p.getClient().signAuthEntry(e.entryXdr, { validUntilLedger: e.validUntilLedger })
    const ms = Math.round(performance.now() - t0)
    if (r.status !== 'signed') {
      const out = { ok: false, status: r.status, code: r.code, details: r.details, ms, ventana: sawConfirmation.current }
      await record('S8_rutaB_signAuthEntry', out)
      return { ok: false, detalle: out }
    }
    const s = await api('/s8b/submit', { signedAuthEntry: r.signedAuthEntry, ms })
    return { ok: s.ok, detalle: s }
  })

  const steps: [string, () => void, boolean][] = [
    ['1 · Verificar token en el servidor', verify, !!address],
    ['2 · Línea de confianza USDC', trustline, !!address],
    ['3 · Firmar mensaje (SEP-53)', sep53, !!address],
    ['4 · Preparar escrow', prepare, !!address],
    ['5 · signTx: confirmar tramo 1', approve, !!address],
    ['6 · S8 ruta A (signTx 2 de 3)', routeA, !!address],
    ['7 · S8 ruta B (signAuthEntry)', routeB, !!address],
  ]

  return (
    <main style={{ font: '15px/1.45 system-ui, sans-serif', maxWidth: 720, margin: '0 auto', padding: 16, color: '#111' }}>
      <p style={{ background: '#fff4cc', padding: '6px 10px', borderRadius: 6, margin: 0 }}>Entorno de pruebas · Fase 0 · Stellar Testnet</p>
      <h1 style={{ fontSize: 22, margin: '16px 0 4px' }}>Prueba de Pollar (S7 y S8)</h1>
      <p style={{ margin: '0 0 12px', color: '#555' }}>
        {p.isAuthenticated ? <>Sesión iniciada · billetera <code>{address ?? 'creándose…'}</code> · {p.wallet?.custody}</> : 'Sin sesión.'}
      </p>
      {!p.isAuthenticated ? (
        <button onClick={p.openLoginModal} style={btn}>Iniciar sesión con Pollar</button>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {steps.map(([label, fn, enabled]) => (
            <button key={label} onClick={fn} disabled={!enabled || !!busy} style={btn}>{busy === label ? 'Procesando…' : label}</button>
          ))}
          <button onClick={p.logout} style={{ ...btn, background: '#eee', color: '#111' }}>Cerrar sesión</button>
        </div>
      )}
      {busy && <p>En curso: {busy}</p>}
      <ol style={{ listStyle: 'none', padding: 0, marginTop: 16 }}>
        {log.map((l, i) => (
          <li key={i} data-paso={l.paso} data-ok={String(l.ok)} style={{ borderTop: '1px solid #ddd', padding: '8px 0' }}>
            <strong>{l.ok === true ? '✅' : l.ok === false ? '❌' : '•'} {l.paso}</strong>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '4px 0 0' }}>{JSON.stringify(l.detalle, null, 2)}</pre>
          </li>
        ))}
      </ol>
    </main>
  )
}

const btn: React.CSSProperties = { padding: '10px 14px', fontSize: 15, borderRadius: 8, border: 0, background: '#1d3f9a', color: '#fff', textAlign: 'left', cursor: 'pointer' }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PollarProvider client={{ apiKey: import.meta.env.VITE_POLLAR_PUBLISHABLE_KEY, stellarNetwork: 'testnet' }}>
      <Pruebas />
    </PollarProvider>
  </StrictMode>,
)
