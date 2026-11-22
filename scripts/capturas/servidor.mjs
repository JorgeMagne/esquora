// Arranca la API y la web en local para tomar capturas de la interfaz.
// Usa un directorio de datos aparte y habilita el acceso de prueba con un token local,
// el mismo mecanismo del ensayo de extremo a extremo. Escribe en Stellar Testnet.
// Uso: node scripts/capturas/servidor.mjs
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = process.env.CAPTURAS_DIR ?? join(tmpdir(), 'esquora-capturas')
mkdirSync(dir, { recursive: true })
const tokenFile = join(dir, 'token.txt')
const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : randomBytes(32).toString('hex')
writeFileSync(tokenFile, token)

const apiEnv = {
  ...process.env,
  PORT: '8787',
  APP_URL: 'http://localhost:5173',
  DATA_DIR: dir,
  NODE_ENV: 'test',
  ESQUORA_TEST_AUTH_TOKEN: token,
  STELLAR_FUNDER_SECRET: '',
  STELLAR_PLATFORM_SECRET: '',
  STELLAR_ANCHOR_SECRET: '',
  ANCHOR_INITIAL_CENTS: '0',
}

const api = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: apiEnv, stdio: 'inherit' })
const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { env: process.env, stdio: 'inherit' })

const stop = () => {
  api.kill()
  web.kill()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.on('exit', stop)
api.on('exit', (code) => {
  web.kill()
  process.exit(code ?? 1)
})
web.on('exit', (code) => {
  api.kill()
  process.exit(code ?? 1)
})
