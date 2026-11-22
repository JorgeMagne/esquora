// Recorre una reserva por etapas contra el servidor de capturas, deteniéndose en cada pantalla.
// Guarda el estado entre etapas en CAPTURAS_DIR/estado.json.
// Uso: tsx scripts/capturas/flujo.ts <inicio|aceptar|pagar|acta|aprobar|cobrar|estado>
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Asset, Horizon, Keypair, Networks, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk'
import { projectRequirements } from '../../shared/reservation.ts'

const BASE = 'http://127.0.0.1:8787'
const DEPOSIT_CENTS = 20_000
const dir = process.env.CAPTURAS_DIR ?? join(tmpdir(), 'esquora-capturas')
const stateFile = join(dir, 'estado.json')
const token = readFileSync(join(dir, 'token.txt'), 'utf8').trim()

type Role = 'developer' | 'buyer' | 'arbiter'
type ActorState = { secret: string; publicKey: string; email: string; name: string; cookie: string }
type State = {
  actors: Record<Role, ActorState>
  opId?: string
  inviteToken?: string
  termsDigest?: string
  orderId?: string
  trancheId?: string
  hashes: Record<string, string>
}
type Json = Record<string, unknown>

const load = (): State =>
  existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')) as State) : { actors: {} as State['actors'], hashes: {} }
const save = (state: State) => writeFileSync(stateFile, JSON.stringify(state, null, 2))

async function request(path: string, options: { method?: string; data?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers = new Headers()
  if (options.cookie) headers.set('Cookie', options.cookie)
  if (options.bearer) headers.set('Authorization', `Bearer ${options.bearer}`)
  const form = options.data instanceof FormData
  if (options.data !== undefined && !form) headers.set('Content-Type', 'application/json')
  return fetch(BASE + path, {
    method: options.method ?? (options.data === undefined ? 'GET' : 'POST'),
    headers,
    body: form ? (options.data as FormData) : options.data === undefined ? undefined : JSON.stringify(options.data),
    signal: AbortSignal.timeout(60_000),
  })
}

async function json<T = Json>(path: string, options?: Parameters<typeof request>[1]): Promise<T> {
  const response = await request(path, options)
  const body = await response.text()
  assert.ok(response.ok, `${response.status} en ${path}: ${body.slice(0, 300)}`)
  return JSON.parse(body) as T
}

async function poll<T>(stage: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 150_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  do {
    const value = await read()
    if (done(value)) return value
    await sleep(1_500)
  } while (Date.now() < deadline)
  throw new Error(`Se agotó la espera de ${stage}.`)
}

const signatureFor = (key: Keypair, termsDigest: string) =>
  Buffer.from(key.sign(createHash('sha256').update(`Stellar Signed Message:\nesquora:acuerdo:sha256:${termsDigest}`).digest())).toString('base64')

async function newActor(role: Role, name: string, config: { horizonUrl: string; asset: { code: string; issuer: string } }): Promise<ActorState> {
  const key = Keypair.random()
  const email = `${role}.capturas@example.test`
  const response = await request('/api/auth/test', { bearer: token, data: { email, name, publicKey: key.publicKey() } })
  assert.ok(response.ok, `Sesión de prueba ${role}: HTTP ${response.status}`)
  const cookie = (response.headers.get('Set-Cookie') ?? '').split(';')[0]
  assert.ok(cookie, 'La API no devolvió la sesión de prueba.')
  await json('/api/me', {
    cookie, method: 'PATCH',
    data: { name, kind: role, orgName: role === 'buyer' ? undefined : name, orgNit: role === 'developer' ? '123456789' : undefined },
  })
  const activate = () => json<{ status: string; needsTrustline: boolean }>('/api/wallet/activate', { cookie, data: {} })
  const first = await activate()
  if (first.needsTrustline) {
    const horizon = new Horizon.Server(config.horizonUrl)
    const source = await horizon.loadAccount(key.publicKey())
    const trustline = new TransactionBuilder(source, { fee: '10000', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.changeTrust({ asset: new Asset(config.asset.code, config.asset.issuer) })).setTimeout(60).build()
    trustline.sign(key)
    await horizon.submitTransaction(trustline)
  }
  await poll(`activar ${role}`, activate, (value) => value.status === 'active')
  return { secret: key.secret(), publicKey: key.publicKey(), email, name, cookie }
}

async function upload(actor: ActorState, name: string, content: string) {
  const data = new FormData()
  data.set('file', new File([content], name, { type: 'text/plain' }))
  return json<{ id: string }>('/api/files', { cookie: actor.cookie, data })
}

async function signAction(actor: ActorState, data: Json) {
  const action = await json<{ id: string; xdr: string }>('/api/acciones', { cookie: actor.cookie, data })
  const envelope = TransactionBuilder.fromXDR(action.xdr, Networks.TESTNET)
  assert.ok(envelope instanceof Transaction)
  envelope.sign(Keypair.fromSecret(actor.secret))
  const url = `/api/acciones/${action.id}`
  const receipt = await json<{ status: string; hash: string; error?: string }>(`${url}/enviar`, { cookie: actor.cookie, data: { signedXdr: envelope.toXDR() } })
  const result = receipt.status === 'pending'
    ? await poll(`confirmar ${String(data.kind)}`, () => json<{ status: string; hash: string; error?: string }>(url, { cookie: actor.cookie }), (item) => item.status !== 'pending')
    : receipt
  assert.equal(result.status, 'confirmed', result.error ?? String(data.kind))
  return result.hash
}

const command = process.argv[2]
const state = load()
const { developer, buyer, arbiter } = state.actors as Record<Role, ActorState>
const op = (cookie: string) => json<Json & { status: string; tranches: { id: string }[]; escrow: { contractId?: string; txHash?: string } | null }>(`/api/ops/${state.opId}`, { cookie })

if (command === 'inicio') {
  const config = await json<{ horizonUrl: string; asset: { code: string; issuer: string } }>('/api/config')
  const actors = {
    developer: await newActor('developer', 'Constructora Altavista', config),
    buyer: await newActor('buyer', 'Carla Rojas', config),
    arbiter: await newActor('arbiter', 'Centro de Arbitraje de prueba', config),
  }
  const project = await json<{ id: string }>('/api/projects', {
    cookie: actors.developer.cookie, data: { name: 'Edificio Curupaú', city: 'Santa Cruz', address: 'Av. Beni, 4.º anillo' },
  })
  const projectFiles: Record<string, string> = {}
  for (const { key, label } of projectRequirements) {
    const file = await upload(actors.developer, `${key}.txt`, `${label}. Documento ficticio de la demostración.`)
    await json(`/api/projects/${project.id}/docs`, { cookie: actors.developer.cookie, data: { reqKey: key, fileId: file.id } })
    projectFiles[key] = file.id
  }
  const contract = await upload(actors.developer, 'contrato-preventa-4B.txt', 'Contrato ficticio de preventa del departamento 4B.')
  const draft = await json<{ id: string; arbiterInviteToken: string }>('/api/ops', {
    cookie: actors.developer.cookie, data: {
      agreementKind: 'reservation', projectId: project.id, projectFiles, reviewed: true, contractFileId: contract.id,
      professional: 'Arq. Daniela Suárez', startCondition: 'Excavación de cimientos del bloque B',
      startDeadline: new Date(Date.now() + 86_400_000).toISOString(),
      unit: '4B', price: 6_100_000, deposit: DEPOSIT_CENTS, buyerName: actors.buyer.name, buyerEmail: actors.buyer.email,
      resolutionMode: 'external', arbiterEmail: actors.arbiter.email,
    },
  })
  await json(`/api/resolver-invitations/${draft.arbiterInviteToken}/claim`, { cookie: actors.arbiter.cookie, data: {} })
  const ready = await json<{ termsDigest: string }>(`/api/ops/${draft.id}`, { cookie: actors.developer.cookie })
  const sent = await json<{ inviteToken: string; termsDigest: string }>(`/api/ops/${draft.id}/send`, {
    cookie: actors.developer.cookie, data: { signature: signatureFor(Keypair.fromSecret(actors.developer.secret), ready.termsDigest) },
  })
  await json(`/api/invitations/${sent.inviteToken}/claim`, { cookie: actors.buyer.cookie, data: {} })
  save({ actors, opId: draft.id, inviteToken: sent.inviteToken, termsDigest: sent.termsDigest, hashes: {} })
  console.log('Acuerdo enviado. Operación', draft.id)
} else if (command === 'aceptar') {
  await json(`/api/ops/${state.opId}/accept`, { cookie: buyer.cookie, data: { signature: signatureFor(Keypair.fromSecret(buyer.secret), state.termsDigest ?? '') } })
  const ready = await poll('registro de la reserva', () => op(buyer.cookie), (value) => value.status === 'awaiting_deposit')
  const order = await json<{ id: string }>(`/api/ops/${state.opId}/deposit`, { cookie: buyer.cookie, data: {} })
  state.orderId = order.id
  if (ready.escrow?.txHash) state.hashes.contrato = ready.escrow.txHash
  save(state)
  console.log('Acuerdo aceptado. Orden de pago', order.id, 'Contrato', ready.escrow?.contractId)
} else if (command === 'pagar') {
  await json(`/api/anchor/orders/${state.orderId}/pay`, { cookie: buyer.cookie, data: {} })
  const paid = await poll('depósito', () => json<{ status: string; txHash: string }>(`/api/anchor/orders/${state.orderId}`, { cookie: buyer.cookie }), (value) => value.status === 'settled')
  const funded = await op(buyer.cookie)
  state.trancheId = funded.tranches[0].id
  state.hashes.deposito = paid.txHash
  save(state)
  console.log('Depósito confirmado', paid.txHash)
} else if (command === 'acta') {
  const act = await upload(developer, 'acta-inicio-de-obra.txt', 'Acta ficticia de excavación de cimientos del bloque B, firmada por la profesional designada.')
  state.hashes.acta = await signAction(developer, { kind: 'evidence', trancheId: state.trancheId, items: [{ reqKey: 'acta_inicio', fileId: act.id }] })
  save(state)
  console.log('Acta presentada', state.hashes.acta)
} else if (command === 'aprobar') {
  state.hashes.aprobacion = await signAction(buyer, { kind: 'approve', trancheId: state.trancheId })
  save(state)
  console.log('Aprobación', state.hashes.aprobacion)
} else if (command === 'cobrar') {
  state.hashes.cobro = await signAction(developer, { kind: 'release', trancheId: state.trancheId })
  save(state)
  console.log('Cobro', state.hashes.cobro)
} else if (command === 'estado') {
  const current = state.opId ? await op(developer.cookie) : null
  console.log(JSON.stringify({
    opId: state.opId, orderId: state.orderId, trancheId: state.trancheId, inviteToken: state.inviteToken,
    status: current?.status, contractId: current?.escrow?.contractId, hashes: state.hashes,
    sesiones: Object.fromEntries(Object.entries(state.actors).map(([role, actor]) => [role, { email: actor.email, name: actor.name, publicKey: actor.publicKey }])),
  }, null, 2))
} else {
  console.error('Etapas: inicio, aceptar, pagar, acta, aprobar, cobrar, estado')
  process.exitCode = 1
}
