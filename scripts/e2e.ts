import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Asset, Horizon, Keypair, Networks, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk'

type Role = 'buyer' | 'developer' | 'arbiter'
type SignedAction = { id: string; xdr: string; expiresAt: number | string | null }
type Receipt = { status: 'pending' | 'confirmed' | 'failed'; hash: string; ledger?: number | null; error?: string }
type Probe = SignedAction | { status: 'failed'; rejected: boolean; xdr?: undefined }
type EvidenceView = { reqKey: string; file: { id: string } }
type OperationView = {
  id: string
  code: string
  status: string
  termsDigest: string
  inviteToken: string
  escrow: { contractId?: string; account?: string; txHash: string } | null
  totals: { held: number; released: number; refunded: number; fees: number }
  tranches: {
    id: string; status: string; overdue: boolean; txHash: string | null
    evidence: EvidenceView[]
    evidenceHistory: { txHash: string | null; files: EvidenceView[] }[]
  }[]
}
type PaymentView = { id: string; status: string; txHash: string }
type AssetConfig = { network: string; horizonUrl: string; asset: { code: string; issuer: string }; feeBps: number }
type JsonRequest = { method?: 'POST' | 'PATCH'; data?: unknown; cookie?: string; token?: string }

const ADDRESS = '127.0.0.1'
const MATCH_HASH = /^[a-f0-9]{64}$/
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const DEPOSIT_CENTS = 20_000
const TRANCHE_CENTS = 10_000

async function availablePort() {
  const socket = createServer()
  socket.listen(0, ADDRESS)
  await once(socket, 'listening')
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function poll<T>(stage: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  do {
    const value = await read()
    if (done(value)) return value
    await sleep(1_250)
  } while (Date.now() < deadline)
  throw new Error(`Se agotó el plazo de espera para ${stage}.`)
}

function parseLoopbackUrl(input: string) {
  const url = new URL(input)
  assert.ok(['http:', 'https:'].includes(url.protocol), 'El E2E exige una URL de HTTP de loopback.')
  assert.ok(['localhost', ADDRESS, '[::1]'].includes(url.hostname), 'El E2E solo acepta una API local.')
  assert.ok(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash)
  return url.origin
}

function client(base: string) {
  async function request(path: string, { method, data, cookie, token }: JsonRequest = {}) {
    const headers = new Headers()
    if (cookie) headers.set('Cookie', cookie)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    if (data !== undefined && !(data instanceof FormData)) headers.set('Content-Type', 'application/json')
    return fetch(base + path, {
      method: method ?? (data === undefined ? 'GET' : 'POST'),
      headers,
      body: data instanceof FormData ? data : data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(45_000),
      redirect: 'error',
    })
  }
  async function json<T>(path: string, options?: JsonRequest): Promise<T> {
    const response = await request(path, options)
    const body = await response.text()
    assert.ok(response.ok, `${response.status} en ${path}: ${body.slice(0, 350)}`)
    return JSON.parse(body) as T
  }
  return { request, json }
}

function signatureFor(key: Keypair, termsDigest: string) {
  const digest = createHash('sha256').update(`Stellar Signed Message:\nesquora:acuerdo:sha256:${termsDigest}`).digest()
  return Buffer.from(key.sign(digest)).toString('base64')
}

async function run(base: string, token: string, restart?: () => Promise<void>) {
  const api = client(base)
  const config = await api.json<AssetConfig>('/api/config')
  assert.equal(config.network.toLowerCase(), 'testnet', 'El E2E solo escribe en Stellar Testnet.')
  assert.deepEqual(config.asset, { code: 'USDC', issuer: USDC_ISSUER })
  const horizon = new Horizon.Server(config.horizonUrl)
  const usdc = new Asset(config.asset.code, config.asset.issuer)
  const runId = randomBytes(4).toString('hex')

  async function newActor(role: Role) {
    const key = Keypair.random()
    const email = `${role}.${runId}@example.test`
    const name = { developer: 'Desarrollador de prueba', buyer: 'Compradora de prueba', arbiter: 'Tercero de prueba' }[role]
    const response = await api.request('/api/auth/test', { token, data: { email, name, publicKey: key.publicKey() } })
    assert.ok(response.ok, `La sesión de prueba para ${role} devolvió HTTP ${response.status}.`)
    const setCookie = response.headers.get('Set-Cookie')
    assert.ok(setCookie, 'La API no devolvió la sesión de prueba.')
    const cookie = setCookie.split(';')[0]
    const { user } = await response.json() as { user: { id: string } }
    const actor = { key, email, name, id: user.id, cookie }

    await api.json('/api/me', {
      cookie, method: 'PATCH', data: {
        name, kind: role,
        orgName: role === 'buyer' ? undefined : name,
        orgNit: role === 'developer' ? '123456789' : undefined,
      },
    })

    async function activate() {
      return api.json<{ status: 'active' | 'pending'; needsTrustline: boolean }>('/api/wallet/activate', { cookie, data: {} })
    }
    const activation = await activate()
    if (activation.needsTrustline) {
      const source = await horizon.loadAccount(key.publicKey())
      const trustline = new TransactionBuilder(source, { fee: '10000', networkPassphrase: Networks.TESTNET })
        .addOperation(Operation.changeTrust({ asset: usdc })).setTimeout(60).build()
      trustline.sign(key)
      await horizon.submitTransaction(trustline)
    }
    await poll(`activar ${role}`, activate, value => value.status === 'active')
    return actor
  }

  type Actor = Awaited<ReturnType<typeof newActor>>

  async function upload(actor: Actor, name: string, content: string) {
    const data = new FormData()
    data.set('file', new File([content], name, { type: 'text/plain' }))
    return api.json<{ id: string; sha256: string }>('/api/files', { cookie: actor.cookie, data })
  }

  async function assertTransaction(hash: string, successful: boolean) {
    assert.match(hash, MATCH_HASH)
    const tx = await poll(`comprobante ${hash.slice(0, 8)}`, async () => {
      try {
        return await horizon.transactions().transaction(hash).call()
      } catch (error) {
        if ((error as { response?: { status?: number } }).response?.status === 404) return null
        throw error
      }
    }, transaction => transaction !== null, 45_000)
    assert.ok(tx)
    assert.equal(tx.successful, successful, `Estado del comprobante ${hash}`)
  }

  async function assertWalletBalance(actor: Actor, cents: number) {
    const account = await horizon.loadAccount(actor.key.publicKey())
    const balance = account.balances.find(row => 'asset_code' in row
      && row.asset_code === 'USDC' && row.asset_issuer === USDC_ISSUER)
    assert.ok(balance)
    assert.equal(Math.round(Number(balance.balance) * 100), cents)
  }

  async function submitAction(actor: Actor, action: SignedAction, kind: string, expected: 'confirmed' | 'failed') {
    const envelope = TransactionBuilder.fromXDR(action.xdr, Networks.TESTNET)
    assert.ok(envelope instanceof Transaction, 'Se esperaba una transacción estándar de Stellar.')
    assert.equal(envelope.source, actor.key.publicKey())
    const actionUrl = `/api/acciones/${action.id}`
    if (kind === 'approve') {
      const wrongSigner = TransactionBuilder.fromXDR(action.xdr, Networks.TESTNET)
      assert.ok(wrongSigner instanceof Transaction)
      wrongSigner.sign(Keypair.random())
      const rejected = await api.request(`${actionUrl}/enviar`, {
        cookie: actor.cookie, data: { signedXdr: wrongSigner.toXDR() },
      })
      assert.equal(rejected.status, 400, 'Solo la billetera de la cuenta puede confirmar esta condición.')
    }
    envelope.sign(actor.key)
    const receipt = await api.json<Receipt>(`${actionUrl}/enviar`, {
      cookie: actor.cookie, data: { signedXdr: envelope.toXDR() },
    })
    const result = receipt.status === 'pending'
      ? await poll(`confirmar ${kind}`, () => api.json<Receipt>(actionUrl, { cookie: actor.cookie }), item => item.status !== 'pending')
      : receipt
    assert.equal(result.status, expected, result.error ?? `Resultado de ${kind}`)
    assert.equal(result.hash, Buffer.from(envelope.hash()).toString('hex'))
    if (expected === 'failed') assert.ok(result.ledger && result.ledger > 0, 'El rechazo debe quedar registrado en el ledger.')
    await assertTransaction(result.hash, expected === 'confirmed')
    return result.hash
  }

  async function signAction(actor: Actor, data: { kind: string; [key: string]: unknown }) {
    const action = await api.json<SignedAction>('/api/acciones', { cookie: actor.cookie, data })
    return submitAction(actor, action, data.kind, 'confirmed')
  }

  const developer = await newActor('developer')
  const buyer = await newActor('buyer')
  const arbiter = await newActor('arbiter')
  const project = await api.json<{ id: string }>('/api/projects', {
    cookie: developer.cookie, data: {
      name: `Edificio Curupaú de prueba ${runId}`, city: 'Santa Cruz', address: 'Av. de pruebas 100',
    },
  })
  const contract = await upload(developer, 'contrato.txt', 'Contrato ficticio para la prueba automatizada de Stellar Testnet.')
  const requirements = [
    { key: 'contrato', label: 'Contrato certificado por Defensa del Consumidor' },
    { key: 'registro', label: 'Registro del proveedor inmobiliario' },
    { key: 'terreno', label: 'Derecho sobre el terreno' },
    { key: 'permiso', label: 'Permiso municipal de construcción' },
  ]
  const refundDue = Date.now() + 90_000
  const draft = await api.json<OperationView>('/api/ops', {
    cookie: developer.cookie,
    data: {
      projectId: project.id, unit: 'A-302', price: 8_000_000, deposit: DEPOSIT_CENTS,
      buyerName: buyer.name, buyerEmail: buyer.email, arbiterId: arbiter.id, contractFileId: contract.id,
      tranches: [
        {
          title: 'Documentación del proyecto', condition: 'Presentar los documentos del proyecto.',
          amount: TRANCHE_CENTS, dueAt: new Date(Date.now() + 86_400_000).toISOString(), requirements,
        },
        {
          title: 'Inicio de obra', condition: 'Presentar el acta y fotos fechadas del inicio de obra.',
          amount: TRANCHE_CENTS, dueAt: new Date(refundDue).toISOString(),
          requirements: [
            { key: 'acta', label: 'Acta de inicio de obra' },
            { key: 'fotos', label: 'Fotografías fechadas' },
          ],
        },
      ],
    },
  })
  assert.equal(draft.status, 'draft')
  assert.equal(draft.tranches.length, 2)
  const opUrl = `/api/ops/${draft.id}`
  assert.equal((await api.request(opUrl, { cookie: buyer.cookie })).status, 404)
  assert.equal((await api.request(opUrl, { cookie: arbiter.cookie })).status, 404)
  const buyerNotices = await api.json<{ items: { opId: string }[] }>('/api/notifications', { cookie: buyer.cookie })
  assert.ok(buyerNotices.items.every(item => item.opId !== draft.id), 'Los avisos de comprador no deben revelar borradores.')
  const sent = await api.json<OperationView>(`${opUrl}/send`, {
    cookie: developer.cookie, data: { signature: signatureFor(developer.key, draft.termsDigest) },
  })
  assert.equal(sent.status, 'invited')
  assert.ok(sent.inviteToken)
  await api.json(`/api/invitations/${sent.inviteToken}/claim`, { cookie: buyer.cookie, data: {} })
  const accepted = await api.json<OperationView>(`${opUrl}/accept`, {
    cookie: buyer.cookie, data: { signature: signatureFor(buyer.key, draft.termsDigest) },
  })
  const operation = (cookie = buyer.cookie) => api.json<OperationView>(opUrl, { cookie })
  const deployed = accepted.status === 'awaiting_deposit'
    ? accepted
    : await poll('desplegar contrato', operation, op => op.status === 'awaiting_deposit')
  const contractId = deployed.escrow?.contractId ?? deployed.escrow?.account
  assert.match(contractId ?? '', /^C[A-Z2-7]{55}$/)
  assert.ok(deployed.escrow)
  await assertTransaction(deployed.escrow.txHash, true)
  console.log(`Acuerdo ${draft.code} confirmado. Contrato ${contractId}.`)

  const order = await api.json<PaymentView>(`${opUrl}/deposit`, { cookie: buyer.cookie, data: {} })
  const orderUrl = `/api/anchor/orders/${order.id}`
  const paid = await api.json<PaymentView>(`${orderUrl}/pay`, { data: {} })
  const settled = paid.status === 'settled'
    ? paid
    : await poll('depositar la cuota inicial', () => api.json<PaymentView>(orderUrl), order => order.status === 'settled')
  await assertTransaction(settled.txHash, true)
  const funded = await operation()
  assert.equal(funded.status, 'funded')
  assert.deepEqual(funded.totals, { held: DEPOSIT_CENTS, released: 0, refunded: 0, fees: 0 })
  assert.deepEqual((await operation(developer.cookie)).totals, funded.totals)
  assert.equal((await api.request(opUrl, { cookie: arbiter.cookie })).status, 404)
  const repeatedPayment = await api.json<PaymentView>(`${orderUrl}/pay`, { data: {} })
  assert.equal(repeatedPayment.status, 'settled')
  assert.equal(repeatedPayment.txHash, settled.txHash)
  const simulated = await api.json<Probe>('/api/acciones', {
    cookie: buyer.cookie, data: { kind: 'probe', opId: draft.id },
  })
  assert.equal(simulated.xdr, undefined, 'La prueba por simulación no debe pedir una firma.')
  assert.equal(simulated.status, 'failed')
  assert.equal(simulated.rejected, true)
  for (const actor of [buyer, developer]) {
    const proof = await api.json<Probe>('/api/acciones', {
      cookie: actor.cookie, data: { kind: 'probe', opId: draft.id, ledger: true },
    })
    if (proof.xdr !== undefined) {
      const probeHash = await submitAction(actor, proof, 'prueba de protección', 'failed')
      console.log(`Prueba de protección rechazada y registrada. Comprobante ${probeHash}.`)
    } else {
      assert.equal(proof.status, 'failed')
      assert.equal(proof.rejected, true)
      console.log('Prueba de protección rechazada en la simulación de Stellar.')
    }
    assert.equal((await operation()).totals.held, DEPOSIT_CENTS)
  }

  const [first, second] = funded.tranches
  const items = await Promise.all(requirements.map(async requirement => ({
    reqKey: requirement.key,
    fileId: (await upload(developer, `${requirement.key}.txt`, `Evidencia ficticia: ${requirement.label}.`)).id,
  })))
  const earlyRelease = await api.request('/api/acciones', {
    cookie: developer.cookie, data: { kind: 'release', trancheId: first.id },
  })
  assert.equal(earlyRelease.status, 409, 'Un tramo sin confirmar no se puede cobrar.')
  assert.equal((await operation()).totals.held, DEPOSIT_CENTS)

  const firstEvidenceHash = await signAction(developer, {
    kind: 'evidence', trancheId: first.id, items, note: 'Documentos de la prueba.',
  })
  await api.json(`/api/tranches/${first.id}/object`, {
    cookie: buyer.cookie, data: { reason: 'Adjuntar la versión corregida del contrato.' },
  })
  const original = items[0]
  const replacement = await upload(developer, 'contrato-corregido.txt', 'Versión corregida para la prueba.')
  await signAction(developer, {
    kind: 'evidence',
    trancheId: first.id,
    items: [{ reqKey: original.reqKey, fileId: replacement.id }, ...items.slice(1)],
    note: 'Documentos de la prueba con la corrección solicitada.',
  })
  const revised = (await operation()).tranches[0]
  assert.ok(revised.evidence.some(item => item.file.id === replacement.id))
  assert.ok(revised.evidence.every(item => item.file.id !== original.fileId))
  assert.ok(revised.evidenceHistory.some(version => version.txHash === firstEvidenceHash
    && version.files.some(item => item.file.id === original.fileId)))
  assert.equal((await api.request(`/api/files/${original.fileId}`, { cookie: buyer.cookie })).status, 200)

  await signAction(buyer, { kind: 'approve', trancheId: first.id })
  const releaseHash = await signAction(developer, { kind: 'release', trancheId: first.id })
  const expectedNet = Math.round(TRANCHE_CENTS * (10_000 - config.feeBps - 30) / 10_000)
  const expectedFee = TRANCHE_CENTS - expectedNet
  const afterRelease = await operation()
  assert.equal(afterRelease.tranches[0].status, 'released')
  assert.equal(afterRelease.tranches[0].txHash, releaseHash)
  assert.deepEqual(afterRelease.totals, { held: TRANCHE_CENTS, released: expectedNet, refunded: 0, fees: expectedFee })
  await assertWalletBalance(developer, expectedNet)
  console.log(`Depósito y primera liberación confirmados. Cobro ${releaseHash}.`)
  if (restart) {
    await restart()
    const restored = await operation()
    assert.deepEqual(restored.totals, afterRelease.totals)
    assert.equal(restored.tranches[0].txHash, releaseHash)
    console.log('La sesión y los saldos confirmados se conservaron después del reinicio.')
  }

  await poll('vencimiento de la segunda condición', operation, op => op.tranches[1].overdue)
  await signAction(buyer, { kind: 'refund', trancheId: second.id, reason: 'Venció la condición sin evidencia.' })
  assert.equal((await operation()).totals.held, TRANCHE_CENTS)
  await api.json(`/api/tranches/${second.id}/refund-response`, {
    cookie: developer.cookie, data: { decision: 'accepted', reason: 'Confirmo la devolución solicitada.' },
  })
  await operation(arbiter.cookie)
  const refundHash = await signAction(arbiter, {
    kind: 'resolve', trancheId: second.id, toBuyer: TRANCHE_CENTS, toSeller: 0, note: 'Devolución acordada.',
  })
  const closed = await operation()
  assert.equal(closed.status, 'closed')
  assert.equal(closed.tranches[1].txHash, refundHash)
  assert.deepEqual(closed.totals, { held: 0, released: expectedNet, refunded: expectedNet, fees: 2 * expectedFee })
  assert.deepEqual((await operation(developer.cookie)).totals, closed.totals)
  await assertWalletBalance(buyer, expectedNet)
  const verification = await api.json<{ contractId: string; held: number }>(`${opUrl}/verification`, { cookie: buyer.cookie })
  assert.equal(verification.contractId, contractId)
  assert.equal(verification.held, 0)
  console.log(`Devolución confirmada. Operación cerrada y saldo del contrato en cero. Comprobante ${refundHash}.`)

  const withdrawalCents = 1_000
  const withdrawalHash = await signAction(buyer, {
    kind: 'withdraw', amount: withdrawalCents, bank: 'Banco de pruebas',
    account: '00000001', holder: buyer.name,
  })
  await assertWalletBalance(buyer, expectedNet - withdrawalCents)
  const wallet = await api.json<{ usdc: number; withdrawals: { amount: number; txHash: string }[] }>('/api/wallet', { cookie: buyer.cookie })
  assert.equal(wallet.usdc, expectedNet - withdrawalCents)
  assert.ok(wallet.withdrawals.some(item => item.amount === withdrawalCents && item.txHash === withdrawalHash))
  assert.deepEqual((await operation()).totals, closed.totals)
  console.log(`Retiro al banco simulado confirmado. Comprobante ${withdrawalHash}.`)
}

async function main() {
  if (process.env.ESQUORA_RUN_TESTNET_E2E !== '1') {
    throw new Error('Define ESQUORA_RUN_TESTNET_E2E=1 para autorizar escrituras en Stellar Testnet.')
  }
  const existing = process.env.ESQUORA_E2E_BASE_URL
  if (existing) {
    const token = process.env.ESQUORA_TEST_AUTH_TOKEN ?? ''
    assert.ok(token.length >= 32, 'Define ESQUORA_TEST_AUTH_TOKEN con el mismo valor que la API de prueba.')
    await run(parseLoopbackUrl(existing), token)
    return
  }

  const port = await availablePort()
  const token = randomBytes(32).toString('hex')
  const dataDir = await mkdtemp(join(tmpdir(), 'esquora-testnet-e2e-'))
  const base = `http://${ADDRESS}:${port}`
  let server: ChildProcess | undefined

  async function start() {
    server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      env: {
        ...process.env, PORT: String(port), APP_URL: base, DATA_DIR: dataDir, NODE_ENV: 'test',
        ESQUORA_TEST_AUTH_TOKEN: token,
        STELLAR_FUNDER_SECRET: '', STELLAR_PLATFORM_SECRET: '', STELLAR_ANCHOR_SECRET: '',
        ANCHOR_INITIAL_CENTS: '0',
      },
      stdio: 'inherit', windowsHide: true,
    })
    const local = client(base)
    await poll('arranque de la API', async () => {
      if (server?.exitCode !== null || server?.signalCode !== null) {
        throw new Error('La API de prueba terminó antes de estar disponible.')
      }
      const response = await local.request('/api/health').catch(() => null)
      return response?.ok ?? false
    }, Boolean)
  }

  async function stop() {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit')
      server.kill()
      await exited
    }
  }

  try {
    await start()
    await run(base, token, async () => {
      await stop()
      await start()
    })
  } finally {
    await stop()
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 })
  }
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
