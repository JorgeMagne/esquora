import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { Hono } from 'hono'
import { mountWebPages } from '../server/landing.ts'

test('el visitante abre la portada y la demo sin un código compartido', async (t) => {
  const dist = mkdtempSync(join(tmpdir(), 'esquora-web-'))
  t.after(() => rmSync(dist, { recursive: true, force: true }))
  const landing = '<a href="/entrar">Probar demo</a>'
  const entry = '<script src="/assets/app.js"></script>'
  const files = {
    'conoce/index.html': landing,
    'index.html': entry,
    'assets/app.js': '/* aplicación */',
    'landing/phone.webp': 'imagen',
    '.vite/manifest.json': '{}',
  }
  for (const [path, content] of Object.entries(files)) {
    const target = join(dist, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  const server = new Hono()
  mountWebPages(server, dist)
  const canonical = await server.request('/conoce?ref=demo')
  assert.equal(canonical.status, 308)
  assert.equal(canonical.headers.get('Location'), '/conoce/?ref=demo')
  for (const path of ['/?ref=atlas', '/conoce/', '/entrar', '/app', '/invitacion/ejemplo']) {
    const response = await server.request(path)
    assert.equal(response.status, 200, path)
    assert.equal(await response.text(), path.startsWith('/?') || path === '/conoce/' ? landing : entry)
    assert.equal(response.headers.get('Set-Cookie'), null)
  }
  for (const path of ['assets/app.js', 'landing/phone.webp'] as const) {
    assert.equal(await (await server.request('/' + path)).text(), files[path])
  }
  for (const path of ['/api/desconocida', '/assets/ausente.js', '/.vite/manifest.json']) {
    assert.equal((await server.request(path)).status, 404, path)
  }
})
