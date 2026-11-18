import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import test from 'node:test'
import { Hono } from 'hono'
import { privateAccess } from '../server/private-access.ts'

const origin = 'https://example.test'
const code = randomBytes(32).toString('base64url')
const signingKey = randomBytes(32).toString('hex')
const credentials = (accessCode: string) => createHash('sha256').update(accessCode).digest('hex') + ':' + signingKey

function testApp(accessCode = code, clock = () => Date.now()) {
  const app = new Hono()
  app.use('*', privateAccess({ origin, credentials: credentials(accessCode), clock }))
  app.get('/api/me', (c) => c.json({ private: true }))
  app.get('/api/health', (c) => c.json({ ready: true, network: 'private' }))
  app.post('/api/auth/pollar', (c) => c.json({ login: true }))
  app.get('*', (c) => c.text('private application', 200, { 'Cache-Control': 'public, max-age=300' }))
  return app
}

function unlock(app: Hono, accessCode: string, next = '/entrar', requestOrigin = origin, ip = '192.0.2.1') {
  return app.request(origin + '/_acceso', {
    method: 'POST',
    headers: { Origin: requestOrigin, 'X-Real-IP': ip },
    body: new URLSearchParams({ code: accessCode, next }),
  })
}

test('the outer gate blocks application pages, assets and APIs even with an application cookie', async () => {
  const app = testApp()
  const headers = { Cookie: 'esquora_session=existing', Accept: 'text/html' }
  for (const path of ['/', '/entrar', '/invitacion/private', '/pago/private']) {
    const response = await app.request(origin + path, { headers })
    assert.equal(response.status, 403)
    const html = await response.text()
    assert.match(html, /Acceso privado/)
    assert.doesNotMatch(html, /ESQUORA|private application|<script/)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
  }
  for (const path of ['/assets/app.js', '/fonts/brand.woff2', '/api/me', '/api/invitations/private', '/api/files/private']) {
    const response = await app.request(origin + path, { headers: { Cookie: headers.Cookie } })
    assert.equal(response.status, 403)
    assert.doesNotMatch(await response.text(), /private application|true/)
  }
  assert.equal((await app.request(origin + '/api/auth/pollar', { method: 'POST' })).status, 403)
  const health = await app.request(origin + '/api/health')
  assert.deepEqual(await health.json(), { ready: true })
})

test('the valid code issues a session bound to its expiry and the current code', async () => {
  let time = Date.now()
  const app = testApp(code, () => time)
  const response = await unlock(app, code, '/entrar?volver=%2Fpago%2Fprueba')
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('Location'), '/entrar?volver=%2Fpago%2Fprueba')
  const cookie = response.headers.get('Set-Cookie')!
  assert.match(cookie, /^__Host-preview=/)
  for (const flag of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=43200']) assert.ok(cookie.includes(flag))
  assert.doesNotMatch(cookie, new RegExp(code))
  const session = cookie.split(';')[0]
  const responseWithSession = await app.request(origin + '/assets/app.js', { headers: { Cookie: session } })
  assert.equal(await responseWithSession.text(), 'private application')
  assert.equal(responseWithSession.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(await (await app.request(origin + '/api/me', { headers: { Cookie: session } })).json(), { private: true })
  assert.equal((await app.request(origin + '/api/me', { headers: { Cookie: session + 'x' } })).status, 403)
  const rotated = testApp(randomBytes(32).toString('base64url'), () => time)
  assert.equal((await rotated.request(origin + '/api/me', { headers: { Cookie: session } })).status, 403)
  time += 43_200_000
  assert.equal((await app.request(origin + '/api/me', { headers: { Cookie: session } })).status, 403)
})

test('unlock rejects other origins, unsafe return URLs and repeated incorrect codes', async () => {
  let time = Date.now()
  const app = testApp(code, () => time)
  const crossOrigin = await unlock(app, code, '/entrar', 'https://other.test')
  assert.equal(crossOrigin.status, 403)
  assert.equal(crossOrigin.headers.get('Set-Cookie'), null)
  for (const target of ['//other.test', '/.//other.test', 'https://other.test']) {
    assert.equal((await unlock(app, code, target)).headers.get('Location'), '/')
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const wrong = await unlock(app, 'incorrect')
    assert.equal(wrong.status, 403)
    assert.equal(wrong.headers.get('Set-Cookie'), null)
  }
  const limited = await unlock(app, code)
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('Retry-After')) > 0)
  assert.equal((await unlock(app, code, '/', origin, '192.0.2.2')).status, 303)
  time += 900_000
  assert.equal((await unlock(app, code)).status, 303)
})

test('requires HTTPS and well-formed credentials', () => {
  assert.throws(() => privateAccess({ origin, credentials: '' }))
  assert.throws(() => privateAccess({ origin: 'http://example.test', credentials: credentials(code) }))
})

test('unlock has a small body limit', async () => {
  const response = await unlock(testApp(), 'x'.repeat(4200))
  assert.equal(response.status, 413)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(response.headers.get('Set-Cookie'), null)
})
