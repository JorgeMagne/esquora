import { existsSync, mkdirSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Networks } from '@stellar/stellar-sdk'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envFile = join(ROOT, '.env')
if (existsSync(envFile)) loadEnvFile(envFile)

export const DATA_DIR = resolve(ROOT, process.env.DATA_DIR ?? 'data')
export const UPLOAD_DIR = join(DATA_DIR, 'uploads')
mkdirSync(UPLOAD_DIR, { recursive: true })

export const PORT = Number(process.env.PORT ?? 8787)
export const HORIZON_URL = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
export const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org'
export const SOROBAN_RPC_FALLBACK_URL = process.env.SOROBAN_RPC_FALLBACK_URL || 'https://soroban-rpc.testnet.stellar.gateway.fm'
export const NETWORK_PASSPHRASE = Networks.TESTNET
export const NETWORK_NAME = 'Testnet'
export const EXPLORER_URL = 'https://stellar.expert/explorer/testnet'
export const FRIENDBOT_URL = 'https://friendbot.stellar.org'
export const CIRCLE_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

export const TRUSTLESS_WORK_API_KEY = process.env.TRUSTLESS_WORK_API_KEY ?? ''
export const TRUSTLESS_WORK_URL = (process.env.TRUSTLESS_WORK_API_URL ?? 'https://dev.api.trustlesswork.com').replace(/\/$/, '')
export const POLLAR_SECRET_KEY = process.env.POLLAR_SECRET_KEY ?? ''
export const POLLAR_SERVER_URL = (process.env.POLLAR_SERVER_URL ?? 'https://server.api.pollar.xyz').replace(/\/$/, '')

export const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS ?? 90)
export { TW_FEE_BPS } from '../shared/fees.ts'
// Referencia del BCB del 17-11-2026 para el proveedor simulado.
export const BOB_PER_USDC = Number(process.env.ANCHOR_BOB_PER_USDC ?? 11.70)
export const ANCHOR_INITIAL_CENTS = Number(process.env.ANCHOR_INITIAL_CENTS ?? 1_200_000)
export const APP_URL = new URL(process.env.APP_URL ?? 'http://localhost:5173').origin
export const SECURE_COOKIES = APP_URL.startsWith('https:')
const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(APP_URL).hostname)
export const TEST_AUTH_TOKEN = process.env.NODE_ENV !== 'production' && local && (process.env.ESQUORA_TEST_AUTH_TOKEN?.length ?? 0) >= 32
  ? process.env.ESQUORA_TEST_AUTH_TOKEN
  : undefined
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
export const SESSION_DAYS = 30

export function validateConfig() {
  if (!TRUSTLESS_WORK_API_KEY) throw new Error('Falta TRUSTLESS_WORK_API_KEY en la configuración.')
  if (!POLLAR_SECRET_KEY && !TEST_AUTH_TOKEN) throw new Error('Falta POLLAR_SECRET_KEY en la configuración.')
  if (!Number.isInteger(PLATFORM_FEE_BPS) || PLATFORM_FEE_BPS < 0 || PLATFORM_FEE_BPS > 1000) {
    throw new Error('PLATFORM_FEE_BPS debe estar entre 0 y 1000.')
  }
  if (!Number.isFinite(BOB_PER_USDC) || BOB_PER_USDC <= 0) throw new Error('ANCHOR_BOB_PER_USDC debe ser positivo.')
  if (!Number.isSafeInteger(ANCHOR_INITIAL_CENTS) || ANCHOR_INITIAL_CENTS < 0) throw new Error('ANCHOR_INITIAL_CENTS no es válido.')
  if (process.env.NODE_ENV === 'production' && !SECURE_COOKIES) {
    throw new Error('APP_URL debe usar HTTPS para desplegar ESQUORA.')
  }
}
