import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Asset,
  Horizon,
  Keypair,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk'
import {
  ANCHOR_INITIAL_CENTS,
  CIRCLE_USDC_ISSUER,
  DATA_DIR,
  FRIENDBOT_URL,
  HORIZON_URL,
  NETWORK_PASSPHRASE,
} from './config.ts'

export const horizon = new Horizon.Server(HORIZON_URL)
horizon.httpClient.defaults.timeout = 8_000
export const USDC = new Asset('USDC', CIRCLE_USDC_ISSUER)
export const USDC_CONTRACT = USDC.contractId(NETWORK_PASSPHRASE)

type ServiceRole = 'funder' | 'platform' | 'anchor'
type ServiceKeys = Record<ServiceRole, string>

const keysFile = join(DATA_DIR, 'service-keys.json')
const fee = '2000'
const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

function readKeys(): ServiceKeys {
  try {
    return JSON.parse(readFileSync(keysFile, 'utf-8')) as ServiceKeys
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const keys = { funder: Keypair.random().secret(), platform: Keypair.random().secret(), anchor: Keypair.random().secret() }
  try {
    writeFileSync(keysFile, JSON.stringify(keys), { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    return keys
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return JSON.parse(readFileSync(keysFile, 'utf-8')) as ServiceKeys
  }
}

const keys = readKeys()
const service = {
  funder: Keypair.fromSecret(process.env.STELLAR_FUNDER_SECRET || keys.funder),
  platform: Keypair.fromSecret(process.env.STELLAR_PLATFORM_SECRET || keys.platform),
  anchor: Keypair.fromSecret(process.env.STELLAR_ANCHOR_SECRET || keys.anchor),
}
export const ADDRESSES = {
  funder: service.funder.publicKey(),
  platform: service.platform.publicKey(),
  anchor: service.anchor.publicKey(),
  fees: service.platform.publicKey(),
}
if (new Set([ADDRESSES.anchor, ADDRESSES.funder, ADDRESSES.platform]).size !== 3)
  throw new Error('Las cuentas de servicio de Stellar deben ser distintas.')

export function centsToAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('El monto debe ser un entero no negativo en centavos.')
  const value = BigInt(cents)
  return (value / 100n).toString() + '.' + (value % 100n).toString().padStart(2, '0')
}

export function stroopsToCents(stroops: bigint): number {
  if (stroops < 0n) throw new RangeError('Monto de Stellar negativo.')
  const cents = Number((stroops + 50_000n) / 100_000n)
  if (!Number.isSafeInteger(cents)) throw new RangeError('Monto de Stellar fuera de rango.')
  return cents
}

function amountToStroops(amount: string): bigint {
  if (!/^\d+(?:\.\d{1,7})?$/.test(amount)) throw new RangeError('Monto de Stellar inválido.')
  const [whole, fractional = ''] = amount.split('.')
  return BigInt(whole) * 10_000_000n + BigInt(fractional.padEnd(7, '0'))
}

export function amountToCents(amount: string): number {
  return stroopsToCents(amountToStroops(amount))
}

export class ChainError extends Error {
  constructor(
    message: string,
    public readonly codes: { transaction?: string; operations?: string[] } = {},
    public readonly status?: number,
  ) {
    super(message)
  }
}

type HorizonError = {
  name?: string
  response?: { status?: number; data?: { extras?: { result_codes?: ChainError['codes'] } } }
}

function chainError(error: unknown): ChainError {
  const response = (error as HorizonError | undefined)?.response
  const codes = response?.data?.extras?.result_codes
  return codes
    ? new ChainError('Stellar rechazó la transacción.', codes, response?.status)
    : new ChainError('No pudimos consultar Stellar. Inténtalo de nuevo en unos segundos.', {}, response?.status)
}

function isNotFound(error: unknown): boolean {
  const e = error as HorizonError | undefined
  return e?.name === 'NotFoundError' || e?.response?.status === 404
}

const queues = new Map<string, Promise<void>>()

async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const afterPrevious = (queues.get(key) ?? Promise.resolve()).then(work)
  const settled = afterPrevious.then(() => {}, () => {})
  queues.set(key, settled)
  try {
    return await afterPrevious
  } finally {
    if (queues.get(key) === settled) queues.delete(key)
  }
}

export async function submit(tx: Transaction): Promise<string> {
  try {
    const response = await horizon.submitTransaction(tx)
    return response.hash
  } catch (error) {
    throw chainError(error)
  }
}

async function loadOrNull(publicKey: string) {
  try {
    return await horizon.loadAccount(publicKey)
  } catch (error) {
    if (isNotFound(error)) return null
    throw chainError(error)
  }
}

export interface AccountInfo {
  exists: boolean
  xlm: string
  usdc: number
  usdcStroops: string
  hasTrustline: boolean
  sequence: string
}

export async function accountInfo(publicKey: string): Promise<AccountInfo> {
  const account = await loadOrNull(publicKey)
  if (!account) return { exists: false, xlm: '0', usdc: 0, usdcStroops: '0', hasTrustline: false, sequence: '0' }
  const circle = account.balances.find((balance) =>
    'asset_code' in balance && balance.asset_code === USDC.code && balance.asset_issuer === USDC.issuer)
  const native = account.balances.find((balance) => balance.asset_type === 'native')
  const usdc = circle ? amountToStroops(circle.balance) : 0n
  return {
    exists: true,
    xlm: native?.balance ?? '0',
    usdc: stroopsToCents(usdc),
    usdcStroops: usdc.toString(),
    hasTrustline: Boolean(circle),
    sequence: account.sequence,
  }
}

async function friendbot(publicKey: string) {
  const url = new URL(FRIENDBOT_URL)
  url.searchParams.set('addr', publicKey)
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) })
  if (!res.ok && res.status !== 400) throw new ChainError('El servicio de fondos de prueba de Stellar no está disponible.', {}, res.status)
  for (let attempt = 0; attempt < 7; attempt++) {
    if (await loadOrNull(publicKey)) return
    await sleep(750)
  }
  throw new ChainError('Stellar todavía no confirma la cuenta de prueba.')
}

async function classic(key: Keypair, operations: xdr.Operation[]) {
  const source = await horizon.loadAccount(key.publicKey())
  const builder = new TransactionBuilder(source, { fee, networkPassphrase: NETWORK_PASSPHRASE })
  for (const operation of operations) builder.addOperation(operation)
  const tx = builder.setTimeout(90).build()
  tx.sign(key)
  return submit(tx)
}

export async function bootstrap() {
  for (const key of Object.values(service)) {
    if (!(await loadOrNull(key.publicKey()))) await friendbot(key.publicKey())
  }
  for (const key of [service.platform, service.anchor]) {
    if (!(await accountInfo(key.publicKey())).hasTrustline)
      await classic(key, [Operation.changeTrust({ asset: USDC })])
  }
  if (ANCHOR_INITIAL_CENTS > 0) await ensureAnchorFunds(ANCHOR_INITIAL_CENTS)
}

export function ensureUserAccount(publicKey: string) {
  return serial('funder', async () => {
    const info = await accountInfo(publicKey)
    if (info.exists && Number(info.xlm) >= 4) return
    const operation = info.exists
      ? Operation.payment({ destination: publicKey, asset: Asset.native(), amount: '5' })
      : Operation.createAccount({ destination: publicKey, startingBalance: '5' })
    try {
      await classic(service.funder, [operation])
    } catch (error) {
      // Pollar puede acabar de crear la cuenta entre ambas lecturas.
      if (!info.exists && error instanceof ChainError && error.codes.operations?.includes('op_already_exists')) {
        const current = await accountInfo(publicKey)
        if (Number(current.xlm) < 4)
          await classic(service.funder, [Operation.payment({ destination: publicKey, asset: Asset.native(), amount: '5' })])
        return
      }
      throw error
    }
  })
}

export function ensureAnchorFunds(cents: number) {
  return serial('anchor-usdc', async () => {
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new RangeError('Monto de depósito inválido.')
    const anchor = await accountInfo(ADDRESSES.anchor)
    if (!anchor.exists || !anchor.hasTrustline) throw new ChainError('La pasarela de pruebas todavía se está preparando.')
    const required = BigInt(cents) * 100_000n - BigInt(anchor.usdcStroops)
    if (required <= 0n) return

    // La compra se hace en centavos y cubre cualquier fracción faltante.
    const amount = centsToAmount(Number((required + 99_999n) / 100_000n))
    const paths = await horizon.strictReceivePaths([Asset.native()], USDC, amount).call()
    const best = paths.records[0]
    if (!best) throw new ChainError('La pasarela no encontró USDC disponible en Testnet.')
    const maximum = Number(best.source_amount) * 1.02
    const fundingAccounts = Math.max(0, Math.ceil((maximum + 10 - Number(anchor.xlm)) / 9_900))
    if (!Number.isFinite(maximum) || fundingAccounts > 6)
      throw new ChainError('El importe supera la liquidez de la pasarela de pruebas.')
    for (let i = 0; i < fundingAccounts; i++) {
      const temp = Keypair.random()
      await friendbot(temp.publicKey())
      await classic(temp, [Operation.accountMerge({ destination: ADDRESSES.anchor })])
    }
    await classic(service.anchor, [Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: maximum.toFixed(7),
      destination: ADDRESSES.anchor,
      destAsset: USDC,
      destAmount: amount,
      path: best.path.map((asset) => asset.asset_type === 'native'
        ? Asset.native()
        : new Asset(asset.asset_code, asset.asset_issuer)),
    })])
  })
}

export async function buildTrustlineXdr(publicKey: string) {
  const account = await horizon.loadAccount(publicKey)
  return new TransactionBuilder(account, { fee, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(120)
    .build()
    .toXDR()
}

export async function buildWithdrawXdr(publicKey: string, cents: number, reference: string) {
  const account = await horizon.loadAccount(publicKey)
  const circle = account.balances.find((balance) =>
    'asset_code' in balance && balance.asset_code === USDC.code && balance.asset_issuer === USDC.issuer)
  if (!circle || amountToStroops(circle.balance) < BigInt(cents) * 100_000n)
    throw new ChainError('El saldo en dólares de prueba no alcanza para este retiro.', {}, 409)
  return new TransactionBuilder(account, { fee, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.payment({ destination: ADDRESSES.anchor, asset: USDC, amount: centsToAmount(cents) }))
    .addMemo(Memo.text(reference.slice(0, 28)))
    .setTimeout(120)
    .build()
    .toXDR()
}

export function parseTx(envelope: string): Transaction {
  const tx = TransactionBuilder.fromXDR(envelope, NETWORK_PASSPHRASE)
  if (!(tx instanceof Transaction)) throw new Error('La transacción debe ser un sobre Stellar sin patrocinio.')
  return tx
}

export function signService(xdr: string, role: 'platform' | 'anchor'): string {
  const tx = parseTx(xdr)
  const signer = service[role]
  if (tx.source !== signer.publicKey() || tx.signatures.length !== 0)
    throw new Error('El sobre no corresponde a la cuenta de origen esperada.')
  tx.sign(signer)
  return tx.toXDR()
}

export interface AssetTransfer {
  from: string
  to: string
  cents: number
  stroops?: string
}

interface HorizonAsset {
  asset_code?: string
  asset_issuer?: string
  type: string
  from?: string
  to?: string
  amount?: string
}

export function circleTransfers(records: HorizonAsset[]): AssetTransfer[] {
  return records.flatMap((change) => {
    if (!['transfer', 'payment'].includes(change.type) ||
      change.asset_code !== USDC.code || change.asset_issuer !== USDC.issuer ||
      !change.from || !change.to || !change.amount) return []
    const stroops = amountToStroops(change.amount)
    return [{ from: change.from, to: change.to, cents: stroopsToCents(stroops), stroops: stroops.toString() }]
  })
}

type Movement = AssetTransfer & { id: string; at: string; txHash: string }

export async function recentPayments(publicKey: string, limit = 25): Promise<Movement[]> {
  const info = await accountInfo(publicKey)
  if (!info.exists) return []
  try {
    const page = await horizon.operations().forAccount(publicKey).order('desc').limit(Math.min(200, limit * 4)).call()
    return page.records.flatMap((record) => {
      const changes = record.type === 'invoke_host_function'
        ? (record.asset_balance_changes ?? []) as HorizonAsset[]
        : [record]
      return circleTransfers(changes).flatMap((change, index) =>
        change.from === publicKey || change.to === publicKey
          ? [{ ...change, id: record.id + ':' + index, at: record.created_at, txHash: record.transaction_hash }]
          : [])
    }).slice(0, limit)
  } catch (error) {
    throw chainError(error)
  }
}
