import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { PORT, ROOT, TEST_AUTH_TOKEN, validateConfig } from './config.ts'
import { app } from './app.ts'
import { reconcileQueue, recoverPending } from './chain.ts'
import { notifyExpiredRefunds } from './domain.ts'
import { mountWebPages } from './landing.ts'
import { bootstrap } from './stellar.ts'

validateConfig()
const server = new Hono()
server.route('/', app)
mountWebPages(server, join(ROOT, 'dist'))

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
