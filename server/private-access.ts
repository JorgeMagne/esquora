import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie, setCookie } from 'hono/cookie'
import { html } from 'hono/html'

const ACCESS_PATH = '/_acceso'
const COOKIE = '__Host-preview'
const SESSION_SECONDS = 12 * 60 * 60
const WINDOW_MS = 15 * 60_000
const MAX_ATTEMPTS = 8
const MAX_CLIENTS = 2048
const codeDigest = (value: string) => createHash('sha256').update(value)

const styles = `
  :root { color-scheme: light; background: #f5f6f8; color: #17212d; font: 16px/1.5 system-ui, sans-serif; }
  *, *::before, *::after { box-sizing: border-box; }
  body { min-height: 100svh; margin: 0; padding: 24px; display: grid; place-items: center; }
  main { width: min(100%, 420px); padding: clamp(20px, 5vw, 36px); background: white; border: 1px solid #d5dce4; border-radius: 12px; }
  h1 { margin: 0; font-size: 1.65rem; line-height: 1.2; }
  p { margin: 12px 0 24px; color: #475463; }
  form { display: grid; gap: 10px; }
  label { font-weight: 600; }
  input, button { min-width: 0; min-height: 48px; border-radius: 6px; font: inherit; }
  input { color: inherit; padding: 8px 12px; border: 1px solid #7e8995; }
  input:focus { border-color: #1460a5; }
  button { margin-top: 6px; border: 0; padding: 8px 12px; color: white; background: #243b53; cursor: pointer; font-weight: 650; }
  button:hover { background: #172839; }
  :focus-visible { outline: 3px solid #1460a5; outline-offset: 3px; }
  [role=alert] { color: #9e2c26; margin: 0; }
  @media (prefers-reduced-motion: no-preference) {
    input { transition: border-color 150ms ease; }
    button { transition: background-color 150ms ease; }
  }
`
const formPolicy = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'sha256-" +
  codeDigest(styles).digest('base64') + "'"

function accessPage(c: Context, target: string, status: 403 | 429, error?: string) {
  c.header('Content-Security-Policy', formPolicy)
  c.header('Referrer-Policy', 'same-origin')
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  c.header('X-Content-Type-Options', 'nosniff')
  return c.html(html`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Acceso privado</title>
  <style>${styles}</style>
</head>
<body>
  <main>
    <h1>Acceso privado</h1>
    <p>Introduce tu código para continuar.</p>
    <form method="post" action="${ACCESS_PATH}">
      <input type="hidden" name="next" value="${target}">
      <label for="access-code">Código de acceso</label>
      <input id="access-code" name="code" type="password" autocomplete="current-password" maxlength="80" required>
      ${error ? html`<p role="alert">${error}</p>` : ''}
      <button type="submit">Entrar</button>
    </form>
  </main>
</body>
</html>`, status)
}

export function privateAccess({ origin, credentials, clock = Date.now }: {
  origin: string; credentials: string; clock?: () => number
}): MiddlewareHandler {
  if (new URL(origin).protocol !== 'https:') throw new Error('El acceso privado requiere un APP_URL con HTTPS.')
  if (!/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(credentials)) {
    throw new Error('Configura ESQUORA_PREVIEW_CREDENTIALS para habilitar el acceso privado.')
  }
  const [digestHex, sessionKey] = credentials.split(':')
  const expectedDigest = Buffer.from(digestHex, 'hex')
  const key = Buffer.from(sessionKey, 'hex')
  const signature = (payload: string) => createHmac('sha256', key)
    .update(origin + ':' + digestHex + ':' + payload).digest('base64url')
  const limitBody = bodyLimit({ maxSize: 4096, onError: (c) => c.text('Solicitud demasiado grande.', 413) })
  const failures = new Map<string, number>()
  let resetAt = 0

  function returnPath(value: string) {
    if (value.length > 1024 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
    const url = new URL(value, origin)
    if (url.origin !== origin || url.pathname.startsWith('//') || url.pathname === ACCESS_PATH) return '/'
    return url.pathname + url.search
  }

  function hasSession(c: Context) {
    const cookie = getCookie(c, COOKIE) ?? ''
    const parsed = /^(\d{10})\.([\w-]{22})\.([\w-]{43})$/.exec(cookie)
    if (!parsed) return false
    const [, expiresAt, nonce, supplied] = parsed
    if (Number(expiresAt) <= Math.floor(clock() / 1000)) return false
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(signature(expiresAt + '.' + nonce)))
  }

  async function unlock(c: Context) {
    if (c.req.header('origin') !== origin) return c.text('Acceso privado.', 403)
    if (c.req.header('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') {
      return c.text('Formato de solicitud no admitido.', 415)
    }
    const data = new URLSearchParams(await c.req.text())
    const target = returnPath(data.get('next') ?? '/')
    const time = clock()
    if (time >= resetAt) {
      failures.clear()
      resetAt = time + WINDOW_MS
    }
    // El proxy de Railway identifica al cliente con X-Real-IP. El mapa tiene tamaño acotado.
    const address = c.req.header('x-real-ip') ?? ''
    const client = isIP(address) ? address : ''
    const bucket = failures.has(client) || failures.size < MAX_CLIENTS ? client : 'overflow'
    const attempts = failures.get(bucket) ?? 0
    if (attempts >= MAX_ATTEMPTS) {
      c.header('Retry-After', String(Math.ceil((resetAt - time) / 1000)))
      return accessPage(c, target, 429, 'Demasiados intentos. Espera unos minutos y vuelve a probar.')
    }

    const code = (data.get('code') ?? '').trim()
    if (!timingSafeEqual(codeDigest(code).digest(), expectedDigest)) {
      failures.set(bucket, attempts + 1)
      return accessPage(c, target, 403, 'El código no coincide. Revísalo y vuelve a intentarlo.')
    }
    failures.delete(bucket)
    const payload = (Math.floor(time / 1000) + SESSION_SECONDS) + '.' + randomBytes(16).toString('base64url')
    setCookie(c, COOKIE, payload + '.' + signature(payload), {
      httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_SECONDS,
    })
    return c.redirect(target, 303)
  }

  return async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (c.req.path === ACCESS_PATH && c.req.method === 'POST') {
      return limitBody(c, async () => { c.res = await unlock(c) })
    }
    if (hasSession(c)) {
      await next()
      c.header('Cache-Control', 'no-store')
      return
    }
    if (c.req.path === '/api/health' && c.req.method === 'GET') return c.json({ ready: true })
    if (c.req.method === 'GET' && !c.req.path.startsWith('/api/') && c.req.header('accept')?.includes('text/html')) {
      return accessPage(c, returnPath(c.req.path + new URL(c.req.url).search), 403)
    }
    return c.text('Acceso privado.', 403)
  }
}
