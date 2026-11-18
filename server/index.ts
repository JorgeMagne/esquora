import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { APP_URL, PORT, ROOT, TEST_AUTH_TOKEN, validateConfig } from './config.ts'
import { app } from './app.ts'
import { reconcileQueue, recoverPending } from './chain.ts'
import { notifyExpiredRefunds } from './domain.ts'
import { privateAccess } from './private-access.ts'
import { bootstrap } from './stellar.ts'

validateConfig()
const credentials = process.env.ESQUORA_PREVIEW_CREDENTIALS?.trim() ?? ''
const server = new Hono()
if (process.env.NODE_ENV === 'production' || credentials) {
  server.use('*', privateAccess({ origin: APP_URL, credentials }))
}
server.all('*', (c) => app.fetch(c.req.raw))

const dist = join(ROOT, 'dist')
const entry = join(dist, 'index.html')
if (existsSync(entry)) {
  const index = readFileSync(entry, 'utf8')
  app.use('/*', serveStatic({ root: dist }))
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/assets/')) return c.notFound()
    c.header('Cache-Control', 'no-cache')
    c.header('Referrer-Policy', 'same-origin')
    return c.html(index)
  })
}

console.log('Preparando las cuentas de ESQUORA en Stellar Testnet…')
await bootstrap()
void recoverPending().catch(() => console.error('La recuperación inicial de operaciones se volverá a intentar cuando se abran.'))
function checkRefundDeadlines() {
  try {
    notifyExpiredRefunds()
  } catch (error) {
    console.error('No se pudieron registrar los avisos de vencimiento. Se volverá a intentar.', error)
  }
}
checkRefundDeadlines()
setInterval(() => {
  checkRefundDeadlines()
  void reconcileQueue().catch(() => console.error('La verificación de movimientos pendientes se volverá a intentar.'))
}, 15_000).unref()

serve({ fetch: server.fetch, port: PORT, hostname: TEST_AUTH_TOKEN ? '127.0.0.1' : (process.env.HOST || '0.0.0.0') }, (info) => {
  console.log('API de ESQUORA en http://localhost:' + info.port)
})
