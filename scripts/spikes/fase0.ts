// Fase 0 de PLAN.md contra Trustless Work V1 en Stellar Testnet.
// Uso: npx tsx scripts/spikes/fase0.ts <etapa>
//   setup | deploy | fund | release | s6a | s5 | s6b | s9 | s10 | report
// El estado (cuentas de prueba, contratos, resultados) queda en data/fase0-state.json.
// Las cuentas son de Testnet y no tienen valor; la llave de la API se lee de .env y nunca se imprime.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  Account, Address, Asset, BASE_FEE, Contract, Horizon, Keypair, Networks, Operation, SorobanDataBuilder,
  Transaction, TransactionBuilder, contract, nativeToScVal, rpc, scValToNative, xdr,
} from '@stellar/stellar-sdk'

const ROOT = process.cwd()
const PASS = Networks.TESTNET
const API = 'https://dev.api.trustlesswork.com'
const EXPLORER = 'https://stellar.expert/explorer/testnet'
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org')
const soroban = new rpc.Server('https://soroban-testnet.stellar.org')
const CIRCLE_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const CODE = 'TRAMOUSD'

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
    .map((m) => [m![1], m![2].trim()]),
)
const KEY = env.TRUSTLESS_WORK_API_KEY
if (!KEY) throw new Error('Falta TRUSTLESS_WORK_API_KEY en .env')

mkdirSync(join(ROOT, 'data'), { recursive: true })
const STATE = join(ROOT, 'data', 'fase0-state.json')
const st: any = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { keys: {}, results: {} }
const save = () => writeFileSync(STATE, JSON.stringify(st, null, 2))
const kp = (n: string) => Keypair.fromSecret(st.keys[n])
const pk = (n: string) => kp(n).publicKey()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (...a: unknown[]) => console.log(...a)
const record = (k: string, v: unknown) => { st.results[k] = v; save(); log(`\n[${k}]`, JSON.stringify(v, null, 2)) }

// ───────────── API de Trustless Work ─────────────
let last = 0
async function tw(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const wait = last + 1400 - Date.now()
  if (wait > 0) await sleep(wait)
  last = Date.now()
  const res = await fetch(API + path, {
    method,
    headers: { 'x-api-key': KEY, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  if (res.status === 429) { log('  429, espero 60 s'); await sleep(61_000); return tw(method, path, body) }
  return { status: res.status, json }
}

function inspect(xdrStr: string) {
  const tx = TransactionBuilder.fromXDR(xdrStr, PASS) as Transaction
  return {
    source: tx.source,
    sequence: tx.sequence,
    fee: tx.fee,
    timeBounds: tx.timeBounds,
    windowSeconds: tx.timeBounds && Number(tx.timeBounds.maxTime) ? Number(tx.timeBounds.maxTime) - Math.floor(Date.now() / 1000) : 'sin límite',
    signatures: tx.signatures.length,
    ops: tx.operations.map((o: any) => ({
      type: o.type,
      fn: o.func?.invokeContract?.functionName?.toString(),
      auth: (o.auth ?? []).map((a: any) => a.credentials?.type),
    })),
  }
}

function sign(xdrStr: string, signers: Keypair[]) {
  const tx = TransactionBuilder.fromXDR(xdrStr, PASS) as Transaction
  for (const s of signers) tx.sign(s)
  return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString('hex') }
}

async function send(xdrStr: string, signers: Keypair[], label: string) {
  const signed = sign(xdrStr, signers)
  const r = await tw('POST', '/helper/send-transaction', { signedXdr: signed.xdr })
  const ok = r.status < 300 && (r.json?.status ?? 'SUCCESS') !== 'FAILED'
  log(`  ${label}: HTTP ${r.status} ${ok ? 'OK' : 'FALLÓ'} ${ok ? '' : JSON.stringify(r.json).slice(0, 300)}`)
  return { ok, status: r.status, body: r.json, hash: signed.hash, explorer: `${EXPLORER}/tx/${signed.hash}` }
}

// La API exige una línea de confianza al USDC de Circle en ciertas cuentas, sea cual sea el activo
// del escrow. Cuando lo pide, se agrega a esa cuenta, se anota y se reintenta.
async function build(path: string, body: any, method = 'POST', retry = 3): Promise<{ status: number; xdr?: string; message?: string; body: any }> {
  const r = await tw(method, path, body)
  const msg: string = r.json?.message ?? ''
  const m = msg.match(/wallet for role '([^']+)' does not have the required asset/) ?? (/Your wallet does not have the required asset/.test(msg) ? [msg, 'signer'] : null)
  if (m && retry > 0) {
    const role = m[1]
    const addr = body?.[role] ?? body?.roles?.[role] ?? (role === 'receiver' ? body?.milestones?.[0]?.receiver : undefined)
    const name = addr ? Object.keys(st.keys).find((n) => pk(n) === addr) : undefined
    if (name) {
      await classic(kp(name), [Operation.changeTrust({ asset: new Asset('USDC', CIRCLE_USDC_ISSUER) })], [kp(name)])
      st.results.lineasUSDCExigidas = [...new Set([...(st.results.lineasUSDCExigidas ?? []), `${path} → ${role} (${name})`])]
      save()
      log(`  la API exigió USDC de Circle a ${role} (${name}); agregada`)
      return build(path, body, method, retry - 1)
    }
  }
  return { status: r.status, xdr: r.json?.unsignedTransaction as string | undefined, message: r.json?.message, body: r.json }
}

async function readEscrow(id: string) {
  let r = await tw('GET', `/helper/get-escrow-by-contract-ids?contractIds=${id}&validateOnChain=true`)
  if (r.status >= 300 || !Array.isArray(r.json) || !r.json.length)
    r = await tw('GET', `/helper/get-escrow-by-contract-ids?contractIds[]=${id}&validateOnChain=true`)
  return r.json?.[0] ?? r.json
}

// ───────────── Red ─────────────
async function classic(source: Keypair, ops: xdr.Operation[], signers: Keypair[]) {
  const acc = await horizon.loadAccount(source.publicKey())
  const b = new TransactionBuilder(acc, { fee: '1000', networkPassphrase: PASS })
  ops.forEach((o) => b.addOperation(o))
  const tx = b.setTimeout(120).build()
  tx.sign(...signers)
  try { return (await horizon.submitTransaction(tx)).hash } catch (e: any) {
    throw new Error('tx clásica: ' + JSON.stringify(e?.response?.data?.extras?.result_codes ?? e?.message))
  }
}

async function waitTx(hash: string) {
  for (let i = 0; i < 40; i++) {
    const g = await soroban.getTransaction(hash)
    if (g.status !== 'NOT_FOUND') return g
    await sleep(1500)
  }
  throw new Error('timeout ' + hash)
}

const CIRCLE = new Asset('USDC', CIRCLE_USDC_ISSUER)
const CIRCLE_SAC = CIRCLE.contractId(PASS)

// Cuenta de resolución 2 de 3: comprador, desarrollador y tercero con peso 1, umbrales en 2 y llave maestra en 0.
// Horizon lista también la llave maestra (con peso 0), así que se cuentan solo los firmantes con peso.
function checkResolver(acc: any) {
  const active = acc.signers.filter((s: any) => s.weight > 0)
  const expected = ['buyer', 'seller', 'arbiter'].map(pk)
  const master = acc.signers.find((s: any) => s.key === acc.account_id)
  const t = acc.thresholds
  return active.length === 3 && expected.every((k) => active.some((s: any) => s.key === k && s.weight === 1))
    && (master?.weight ?? 0) === 0 && t.low_threshold === 2 && t.med_threshold === 2 && t.high_threshold === 2
}

async function sacBalance(addr: string, sacId: string = st.sac): Promise<number> {
  const sac = new Contract(sacId)
  const acc = await soroban.getAccount(pk('funder'))
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(sac.call('balance', Address.fromString(addr).toScVal())).setTimeout(60).build()
  const sim = await soroban.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) return NaN
  return Number(scValToNative(sim.result!.retval)) / 1e7
}

async function balanceChanges(hash: string) {
  for (let i = 0; i < 10; i++) {
    try {
      const ops = await horizon.operations().forTransaction(hash).call()
      return ops.records.flatMap((o: any) => (o.asset_balance_changes ?? []).map((c: any) => ({
        type: c.type, from: c.from, to: c.to, amount: Number(c.amount), asset: c.asset_code,
      })))
    } catch { await sleep(2000) }
  }
  return []
}

const g = (o: any, k: string) => (typeof o?.[k] === 'function' ? o[k]() : o?.[k])
const tname = (t: any): string => String(typeof t?.switch === 'function' ? t.switch().name : t?.type ?? t?.switch ?? '')
const who = (addr: string) => Object.keys(st.keys).find((n) => pk(n) === addr) ?? (addr === st.escrow1 ? 'escrow1' : addr === st.escrow2 ? 'escrow2' : addr)
const named = (changes: any[]) => changes.map((c) => ({ ...c, from: who(c.from), to: who(c.to) }))

function describeErr(r: any) {
  try { return JSON.stringify(r.errorResult?.result ?? r.errorResult).slice(0, 200) } catch { return 'ERROR' }
}

const clients = new Map<string, any>()
async function getClient(id: string) {
  if (!clients.has(id)) clients.set(id, await contract.Client.from({ contractId: id, networkPassphrase: PASS, rpcUrl: 'https://soroban-testnet.stellar.org' }))
  return clients.get(id)
}

// Arma (simulando) una llamada al contrato, la firma con las llaves indicadas y opcionalmente la envía.
async function invoke(source: string, id: string, fn: string, args: Record<string, unknown>, signers: string[],
  opts: { timeout?: number; submit?: boolean } = {}) {
  const client = await getClient(id)
  const scArgs = client.spec.funcArgsToScVals(fn, args)
  const acc = await soroban.getAccount(pk(source))
  const raw = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(Operation.invokeContractFunction({ contract: id, function: fn, args: scArgs }))
    .setTimeout(opts.timeout ?? 120).build()
  let tx: Transaction
  try { tx = await soroban.prepareTransaction(raw) as Transaction } catch (e: any) {
    return { ok: false, etapa: 'simulación', error: String(e?.message ?? e).slice(0, 600) } as any
  }
  for (const s of signers) tx.sign(kp(s))
  const hash = Buffer.from(tx.hash()).toString('hex')
  if (opts.submit === false) return { ok: true, xdr: tx.toXDR(), hash } as any
  const r = await soroban.sendTransaction(tx)
  if (r.status === 'ERROR') return { ok: false, etapa: 'envío', error: describeErr(r), hash } as any
  const g: any = await waitTx(r.hash)
  return { ok: g.status === 'SUCCESS', estado: g.status, hash: r.hash, explorer: `${EXPLORER}/tx/${r.hash}`, xdr: tx.toXDR() } as any
}

const probeBody = (trustline: any) => ({
  signer: pk('platform'), engagementId: 'ESQ-PROBE', title: 'probe', description: 'probe',
  roles: { approver: pk('buyer'), serviceProvider: pk('seller'), platformAddress: pk('platform'), releaseSigner: pk('seller'), disputeResolver: pk('resolver') },
  platformFee: 1, milestones: [{ description: 'x', amount: 10, receiver: pk('seller') }], trustline,
})

// ───────────── Etapas ─────────────
const stages: Record<string, () => Promise<void>> = {
  async setup() {
    for (const n of ['funder', 'issuer', 'platform', 'buyer', 'seller', 'arbiter', 'anchor', 'outsider', 'resolver'])
      st.keys[n] ??= Keypair.random().secret()
    save()
    const fb = await fetch(`https://friendbot.stellar.org/?addr=${pk('funder')}`)
    log('friendbot', fb.status)
    const asset = new Asset(CODE, pk('issuer'))
    const f = kp('funder')
    await classic(f, ['issuer', 'platform', 'buyer', 'seller', 'arbiter', 'anchor', 'outsider'].map((n) =>
      Operation.createAccount({ destination: pk(n), startingBalance: '200' })), [f])
    // Cuenta de resolución 2 de 3, en una sola transacción: firmantes, umbrales y llave maestra a cero.
    const r = kp('resolver')
    await classic(f, [
      Operation.createAccount({ destination: r.publicKey(), startingBalance: '50' }),
      Operation.setOptions({ source: r.publicKey(), signer: { ed25519PublicKey: pk('buyer'), weight: 1 } }),
      Operation.setOptions({ source: r.publicKey(), signer: { ed25519PublicKey: pk('seller'), weight: 1 } }),
      Operation.setOptions({ source: r.publicKey(), signer: { ed25519PublicKey: pk('arbiter'), weight: 1 },
        masterWeight: 0, lowThreshold: 2, medThreshold: 2, highThreshold: 2 }),
    ], [f, r])
    const racc = await horizon.loadAccount(r.publicKey())
    const ok = checkResolver(racc)
    record('resolverVerificada', { ok, signers: racc.signers.map((s: any) => [who(s.key), s.weight]), thresholds: racc.thresholds })
    for (const n of ['platform', 'buyer', 'seller', 'anchor', 'outsider'])
      await classic(kp(n), [Operation.changeTrust({ asset })], [kp(n)])
    await classic(kp('issuer'), [Operation.payment({ destination: pk('anchor'), asset, amount: '100000' })], [kp('issuer')])
    const acc = await soroban.getAccount(pk('funder'))
    const tx = await soroban.prepareTransaction(new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASS })
      .addOperation(Operation.createStellarAssetContract({ asset })).setTimeout(120).build())
    tx.sign(f)
    await waitTx((await soroban.sendTransaction(tx)).hash)
    st.sac = asset.contractId(PASS)
    save()
    log('listo. SAC', st.sac)
  },

  async deploy() {
    const contratoSha = 'a3f1'.repeat(16), acuerdoSha = '9c2e'.repeat(16)
    const base = (trustline: any, milestones: any[], title: string) => ({
      signer: pk('platform'),
      engagementId: 'ESQ-P0-' + Date.now().toString(36),
      title,
      description: `contrato:sha256:${contratoSha} acuerdo:sha256:${acuerdoSha}`,
      roles: { approver: pk('buyer'), serviceProvider: pk('seller'), platformAddress: pk('platform'), releaseSigner: pk('seller'), disputeResolver: pk('resolver') },
      platformFee: 1,
      milestones,
      trustline,
    })
    const ms = [
      { description: 'Documentacion del proyecto', amount: 6000, receiver: pk('seller') },
      { description: 'Inicio de obra', amount: 3000, receiver: pk('seller') },
      { description: 'Tramo de prueba firma diferida', amount: 3000, receiver: pk('seller') },
    ]
    let body: any = base({ address: pk('issuer'), symbol: CODE }, ms, 'ESQUORA fase 0 TRAMOUSD')
    let b = await build('/deployer/multi-release', body)
    const shape = { roles: 'objeto', trustline: 'objeto' }
    if (!b.xdr) {
      log('  objeto rechazado:', b.status, b.message ?? JSON.stringify(b.body).slice(0, 200), '→ pruebo con arreglos')
      body = { ...body, roles: [body.roles], trustline: [body.trustline] }
      shape.roles = 'arreglo'; shape.trustline = 'arreglo'
      b = await build('/deployer/multi-release', body)
    }
    if (!b.xdr) { record('S1_TRAMOUSD', { ok: false, status: b.status, body: b.body }); return }
    st.bodyShape = shape
    const insp = inspect(b.xdr)
    const s = await send(b.xdr, [kp('platform')], 'desplegar TRAMOUSD')
    st.escrow1 = s.body?.contractId ?? s.body?.escrow?.contractId
    save()
    record('S1_TRAMOUSD', { ok: s.ok && !!st.escrow1, contractId: st.escrow1, forma: shape, explorer: s.explorer, xdr: insp, respuesta: Object.keys(s.body ?? {}) })

    const bc = base(shape.trustline === 'objeto' ? { address: CIRCLE_USDC_ISSUER, symbol: 'USDC' } : [{ address: CIRCLE_USDC_ISSUER, symbol: 'USDC' }],
      [{ description: 'Prueba', amount: 10, receiver: pk('seller') }], 'ESQUORA fase 0 USDC Circle')
    if (shape.roles === 'arreglo') bc.roles = [bc.roles] as any
    const b2 = await build('/deployer/multi-release', bc)
    if (b2.xdr) {
      const s2 = await send(b2.xdr, [kp('platform')], 'desplegar USDC Circle')
      record('S1_USDC_Circle', { ok: s2.ok, contractId: s2.body?.contractId, explorer: s2.explorer })
    } else record('S1_USDC_Circle', { ok: false, status: b2.status, message: b2.message ?? b2.body })

    const e = await readEscrow(st.escrow1)
    record('S2_lectura', { platformFeeGuardado: e?.platformFee, trustline: e?.trustline, roles: e?.roles,
      tramos: e?.milestones?.map((m: any) => ({ amount: m.amount, status: m.status, flags: m.flags ?? m })), balance: e?.balance })
  },

  async fund() {
    const b = await build('/escrow/multi-release/fund-escrow', { contractId: st.escrow1, signer: pk('anchor'), amount: 12000 })
    if (!b.xdr) { record('S3_deposito', { ok: false, status: b.status, body: b.body }); return }
    const insp = inspect(b.xdr)
    const s = await send(b.xdr, [kp('anchor')], 'depositar 12.000')
    await sleep(4000)
    const api = await tw('GET', `/helper/get-multiple-escrow-balance?addresses=${st.escrow1}`)
    record('S3_deposito', { ok: s.ok, explorer: s.explorer, xdr: insp, saldoRed: await sacBalance(st.escrow1), saldoAPI: api.json })
  },

  async release() {
    const id = st.escrow1
    const neg: any = {}
    const evid = 'sha256:' + 'd0c5'.repeat(16)
    let b = await build('/escrow/multi-release/change-milestone-status', { contractId: id, milestoneIndex: '0', newStatus: 'Completed', newEvidence: evid, serviceProvider: pk('seller') })
    record('S4a_evidencia_xdr', b.xdr ? inspect(b.xdr) : { status: b.status, body: b.body })
    if (b.xdr) await send(b.xdr, [kp('seller')], 'evidencia tramo 0')

    const r1 = await build('/escrow/multi-release/release-milestone-funds', { contractId: id, releaseSigner: pk('seller'), milestoneIndex: '0' })
    neg.desarrolladorCobraSinConfirmacion = { status: r1.status, construyo: !!r1.xdr, message: r1.message }
    const r2 = await build('/escrow/multi-release/approve-milestone', { contractId: id, milestoneIndex: '0', approver: pk('seller') })
    neg.desarrolladorConfirmaPorElComprador = { status: r2.status, construyo: !!r2.xdr, message: r2.message }
    const r3 = await build('/escrow/multi-release/approve-milestone', { contractId: id, milestoneIndex: '0', approver: pk('outsider') })
    neg.ajenoConfirma = { status: r3.status, construyo: !!r3.xdr, message: r3.message }

    b = await build('/escrow/multi-release/approve-milestone', { contractId: id, milestoneIndex: '0', approver: pk('buyer') })
    if (b.xdr) await send(b.xdr, [kp('buyer')], 'confirmación del comprador')

    const r4 = await build('/escrow/multi-release/release-milestone-funds', { contractId: id, releaseSigner: pk('buyer'), milestoneIndex: '0' })
    neg.compradorCobra = { status: r4.status, construyo: !!r4.xdr, message: r4.message }
    const r5 = await build('/escrow/multi-release/release-milestone-funds', { contractId: id, releaseSigner: pk('outsider'), milestoneIndex: '0' })
    neg.ajenoCobra = { status: r5.status, construyo: !!r5.xdr, message: r5.message }
    record('S10_parte1', neg)

    b = await build('/escrow/multi-release/release-milestone-funds', { contractId: id, releaseSigner: pk('seller'), milestoneIndex: '0' })
    if (!b.xdr) { record('S4_liberacion', { ok: false, status: b.status, body: b.body }); return }
    const insp = inspect(b.xdr)
    const s = await send(b.xdr, [kp('seller')], 'liberación tramo 0')
    await sleep(5000)
    const changes = s.ok ? named(await balanceChanges(s.hash)) : []
    const feeAddr = changes.find((c) => !['seller', 'platform'].includes(c.to) && c.from === 'escrow1')?.to
    record('S4_liberacion', { ok: s.ok, explorer: s.explorer, xdr: insp, movimientos: changes, cuentaComisionTW: feeAddr ?? null,
      saldoEscrowDespues: await sacBalance(id), error: s.ok ? undefined : s.body })
  },

  // ── Llamadas directas al contrato (sin la API), con una cuenta propia como receptora de la comisión de TW ──
  async twfee() {
    st.keys.twfee ??= Keypair.random().secret(); save()
    const asset = new Asset(CODE, pk('issuer'))
    await classic(kp('funder'), [Operation.createAccount({ destination: pk('twfee'), startingBalance: '20' })], [kp('funder')])
    await classic(kp('twfee'), [Operation.changeTrust({ asset })], [kp('twfee')])
    log('cuenta sustituta de comisión TW', pk('twfee'))
  },

  async release3() {
    const s = await invoke('seller', st.escrow1, 'release_milestone_funds',
      { release_signer: pk('seller'), trustless_work_address: pk('twfee'), milestone_index: 0 }, ['seller'])
    await sleep(5000)
    const mov = s.ok ? named(await balanceChanges(s.hash)) : []
    const total = mov.reduce((a, c) => a + (c.from === 'escrow1' ? c.amount : 0), 0)
    record('S4_liberacion_directa', { ...s, movimientos: mov, totalSalido: total, saldoEscrowDespues: await sacBalance(st.escrow1),
      lectura: mov.map((c) => `${c.to}: ${c.amount} (${((c.amount / 6000) * 100).toFixed(3)} %)`) })
  },

  async apiresolve() {
    const id = st.escrow1
    const d = await build('/escrow/multi-release/dispute-milestone', { contractId: id, milestoneIndex: '1', signer: pk('buyer') })
    record('S5a_desacuerdo_xdr', d.xdr ? inspect(d.xdr) : { status: d.status, body: d.body })
    if (d.xdr) await send(d.xdr, [kp('buyer')], 'desacuerdo tramo 1')
    const d2 = await build('/escrow/multi-release/dispute-milestone', { contractId: id, milestoneIndex: '2', signer: pk('seller') })
    if (d2.xdr) await send(d2.xdr, [kp('seller')], 'desacuerdo tramo 2 (lo abre el desarrollador)')
    const b = await build('/escrow/multi-release/resolve-milestone-dispute', { contractId: id, disputeResolver: pk('resolver'), milestoneIndex: '1', distributions: [{ address: pk('buyer'), amount: 3000 }] })
    record('S5_resolucion_por_API', { construyo: !!b.xdr, status: b.status, message: b.message, xdr: b.xdr ? inspect(b.xdr) : undefined })
    if (b.xdr) st.apiResolveXdr = b.xdr, save()
  },

  // Firma diferida, parte 1: transacción de resolución del tramo 2 con ventana de 1 día; firma solo el comprador.
  async s6a2() {
    const tx = await invoke('resolver', st.escrow1, 'resolve_milestone_dispute',
      { dispute_resolver: pk('resolver'), milestone_index: 2, trustless_work_address: pk('twfee'), distributions: new Map([[pk('buyer'), 30000000000n]]) },
      ['buyer'], { timeout: 86400, submit: false })
    st.pending2 = { xdr: tx.xdr, at: new Date().toISOString() }; save()
    record('S6a_primera_firma', { guardada: st.pending2.at, xdr: inspect(tx.xdr!) })
  },

  // Devolución acordada del tramo 1 con 2 de 3 firmas (comprador + desarrollador).
  async s5d() {
    const antes = await sacBalance(pk('buyer'))
    let s: any
    if (st.apiResolveXdr) {
      s = await send(st.apiResolveXdr, [kp('buyer'), kp('seller')], 'resolución armada por la API con 2 firmas')
      s.via = 'API de Trustless Work'
    }
    if (!s?.ok) {
      s = await invoke('resolver', st.escrow1, 'resolve_milestone_dispute',
        { dispute_resolver: pk('resolver'), milestone_index: 1, trustless_work_address: pk('twfee'), distributions: new Map([[pk('buyer'), 30000000000n]]) },
        ['buyer', 'seller'])
      s.via = 'contrato directo (Soroban RPC)'
    }
    await sleep(5000)
    record('S5_devolucion_2de3', { ...s, compradorRecibe: +((await sacBalance(pk('buyer'))) - antes).toFixed(7),
      movimientos: s.ok ? named(await balanceChanges(s.hash)) : [] })
  },

  // Firma diferida, parte 2 (otro proceso).
  async s6b2() {
    const viejo = TransactionBuilder.fromXDR(st.pending2.xdr, PASS) as Transaction
    viejo.sign(kp('seller'))
    const r = await soroban.sendTransaction(viejo)
    const res: any = { transaccionGuardada: { firmadaDesde: st.pending2.at, estado: r.status, error: r.status === 'ERROR' ? describeErr(r) : undefined } }
    const nueva = await invoke('resolver', st.escrow1, 'resolve_milestone_dispute',
      { dispute_resolver: pk('resolver'), milestone_index: 2, trustless_work_address: pk('twfee'), distributions: new Map([[pk('buyer'), 30000000000n]]) },
      ['buyer'], { timeout: 86400, submit: false })
    const una = await soroban.sendTransaction(TransactionBuilder.fromXDR(nueva.xdr!, PASS) as Transaction)
    res.unaSolaFirma = { estado: una.status, error: una.status === 'ERROR' ? describeErr(una) : undefined }
    st.pending3 = { xdr: nueva.xdr, at: new Date().toISOString() }; save()
    record('S6_parte2', res)
    log('espero 150 s, más que la ventana de 100 s de la API…')
    await sleep(150_000)
  },

  async s6c() {
    const tx = TransactionBuilder.fromXDR(st.pending3.xdr, PASS) as Transaction
    tx.sign(kp('arbiter'))
    const r = await soroban.sendTransaction(tx)
    const g: any = r.status === 'ERROR' ? null : await waitTx(r.hash)
    record('S6_parte3', { primeraFirma: st.pending3.at, segundaFirma: new Date().toISOString(), firmantes: 'comprador + tercero',
      estado: g?.status ?? r.status, error: r.status === 'ERROR' ? describeErr(r) : undefined, explorer: `${EXPLORER}/tx/${r.hash}` })
  },

  // S9: intentos no autorizados enviados a la red para que queden registrados como fallidos.
  async s9b() {
    if (!st.escrow2) {
      const d = await build('/deployer/multi-release', {
        signer: pk('platform'), engagementId: 'ESQ-P0-S9-' + Date.now().toString(36), title: 'ESQUORA fase 0 proteccion', description: 'prueba de proteccion',
        roles: { approver: pk('buyer'), serviceProvider: pk('seller'), platformAddress: pk('platform'), releaseSigner: pk('seller'), disputeResolver: pk('resolver') },
        platformFee: 1,
        milestones: [{ description: 'Aprobado', amount: 1000, receiver: pk('seller') }, { description: 'Sin aprobar', amount: 1000, receiver: pk('seller') }],
        trustline: { address: pk('issuer'), symbol: CODE },
      })
      const s = await send(d.xdr!, [kp('platform')], 'desplegar escrow de protección')
      st.escrow2 = s.body?.contractId; save()
      const f = await build('/escrow/multi-release/fund-escrow', { contractId: st.escrow2, signer: pk('anchor'), amount: 2000 })
      await send(f.xdr!, [kp('anchor')], 'depositar 2.000')
      const c = await build('/escrow/multi-release/change-milestone-status', { contractId: st.escrow2, milestoneIndex: '0', newStatus: 'Completed', newEvidence: 'x', serviceProvider: pk('seller') })
      await send(c.xdr!, [kp('seller')], 'evidencia tramo 0')
      const a = await build('/escrow/multi-release/approve-milestone', { contractId: st.escrow2, milestoneIndex: '0', approver: pk('buyer') })
      await send(a.xdr!, [kp('buyer')], 'confirmación tramo 0')
      await sleep(4000)
    }
    const id = st.escrow2
    const client = await getClient(id)
    const valid = await invoke('seller', id, 'release_milestone_funds', { release_signer: pk('seller'), trustless_work_address: pk('twfee'), milestone_index: 0 }, [], { submit: false })
    const find = (o: any, key: string, seen = new Set()): any => {
      if (!o || typeof o !== 'object' || seen.has(o)) return undefined
      seen.add(o)
      if (key in o && o[key]) return o[key]
      for (const v of Object.values(o)) { const r = find(v, key, seen); if (r) return r }
    }
    const sorobanData = find((TransactionBuilder.fromXDR(valid.xdr, PASS) as Transaction).toEnvelope(), 'sorobanData')

    async function intento(actor: string, fn: string, args: Record<string, unknown>, label: string) {
      const scArgs = client.spec.funcArgsToScVals(fn, args)
      // Simulación del mismo intento: da el código de error del contrato.
      const acc0 = await soroban.getAccount(pk(actor))
      const sim: any = await soroban.simulateTransaction(new TransactionBuilder(acc0, { fee: BASE_FEE, networkPassphrase: PASS })
        .addOperation(Operation.invokeContractFunction({ contract: id, function: fn, args: scArgs })).setTimeout(60).build())
      const codigo = rpc.Api.isSimulationError(sim) ? (String(sim.error).match(/Error\(Contract, #\d+\)/)?.[0] ?? String(sim.error).slice(0, 120)) : 'la simulación pasó'
      const auth = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(id).toScAddress(), functionName: fn, args: scArgs })),
          subInvocations: [],
        }),
      })
      const acc = await soroban.getAccount(pk(actor))
      const raw = new TransactionBuilder(acc, { fee: '3000000', networkPassphrase: PASS })
        .addOperation(Operation.invokeContractFunction({ contract: id, function: fn, args: scArgs, auth: [auth] }))
        .setSorobanData(new SorobanDataBuilder(sorobanData).build()).setTimeout(120).build()
      raw.sign(kp(actor))
      const sent = await soroban.sendTransaction(raw)
      if (sent.status === 'ERROR') return { intento: label, registradaEnLaRed: false, rechazo: describeErr(sent), codigoContrato: codigo }
      const res: any = await waitTx(sent.hash)
      return { intento: label, registradaEnLaRed: true, estado: res.status, codigoContrato: codigo,
        explorer: `${EXPLORER}/tx/${sent.hash}`, saldoEscrowDespues: await sacBalance(id) }
    }

    const antes = await sacBalance(id)
    const out: any[] = [{ saldoEscrowAntes: antes }]
    out.push(await intento('seller', 'release_milestone_funds',
      { release_signer: pk('seller'), trustless_work_address: pk('twfee'), milestone_index: 1 }, 'El desarrollador intenta cobrar el tramo 2 sin la confirmación del comprador'))
    out.push(await intento('buyer', 'withdraw_remaining_funds',
      { dispute_resolver: pk('buyer'), trustless_work_address: pk('twfee'), distributions: new Map([[pk('buyer'), 20000000000n]]) }, 'El comprador intenta retirar todo el dinero por su cuenta'))
    out.push(await intento('buyer', 'resolve_milestone_dispute',
      { dispute_resolver: pk('buyer'), milestone_index: 0, trustless_work_address: pk('twfee'), distributions: new Map([[pk('buyer'), 10000000000n]]) }, 'El comprador intenta resolver un tramo a su favor sin el tercero'))
    out.push(await intento('platform', 'withdraw_remaining_funds',
      { dispute_resolver: pk('platform'), trustless_work_address: pk('platform'), distributions: new Map([[pk('platform'), 20000000000n]]) }, 'La plataforma intenta llevarse el dinero'))
    record('S9_intentos_en_red', out)
  },

  // S10 por contrato: la plataforma intenta cambiar el destinatario de un tramo con fondos depositados.
  async s10b() {
    const id = st.escrow2
    const client = await getClient(id)
    const acc = await soroban.getAccount(pk('platform'))
    const sim: any = await soroban.simulateTransaction(new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASS })
      .addOperation(Operation.invokeContractFunction({ contract: id, function: 'get_escrow', args: [] })).setTimeout(60).build())
    const escrow: any = scValToNative(sim.result.retval)
    const cambiado = { ...escrow, milestones: escrow.milestones.map((m: any) => ({ ...m, receiver: pk('platform') })) }
    const r = await invoke('platform', id, 'update_escrow', { plataform_address: pk('platform'), escrow_properties: cambiado }, ['platform'], { submit: false })
    record('S10_plataforma_redirige_por_contrato', {
      saldoEscrow: await sacBalance(id),
      resultado: r.ok ? 'LA SIMULACIÓN PASÓ: la plataforma podría redirigir' : 'rechazado',
      codigo: r.ok ? undefined : (String(r.error).match(/Error\(Contract, #\d+\)/)?.[0] ?? String(r.error).slice(0, 200)),
    })
  },

  // Diagnóstico: simular la liberación directo contra el contrato para ver el error real.
  async diag() {
    const id = st.escrow1
    const client = await contract.Client.from({ contractId: id, networkPassphrase: PASS, rpcUrl: 'https://soroban-testnet.stellar.org' })
    const fns = client.spec.funcs().map((f: any) => ({
      name: g(f,'name').toString(),
      inputs: g(f,'inputs').map((i: any) => `${g(i,'name').toString()}:${tname(g(i,'type')).replace('scSpecType', '')}`).join(', '),
    }))
    const rel = fns.find((f: any) => f.name.startsWith('release_milestone'))
    log('funciones:', JSON.stringify(fns, null, 1))
    if (!rel) throw new Error('No se encontró release_milestone_funds en la interfaz del contrato.')
    const inputs = g(client.spec.getFunc(rel.name),'inputs')
    const args: any = {}
    for (const i of inputs) {
      const n = g(i,'name').toString(); const t = tname(g(i,'type'))
      args[n] = /index/.test(n) ? (/U32|I32/.test(t) ? 0 : 0n) : pk('seller')
    }
    const scArgs = client.spec.funcArgsToScVals(rel.name, args)
    const acc = await soroban.getAccount(pk('seller'))
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASS })
      .addOperation(Operation.invokeContractFunction({ contract: id, function: rel.name, args: scArgs })).setTimeout(60).build()
    const sim: any = await soroban.simulateTransaction(tx)
    const events = (sim.events ?? []).map((e: any) => { try { return JSON.stringify(scValToNative((e as any).event?.body?.v0?.data ?? (e as any).event?.body?.value?.data)).slice(0, 220) } catch { return String(e).slice(0, 220) } })
    record('S4_diagnostico', {
      firmaRelease: rel,
      simulacion: rpc.Api.isSimulationError(sim) ? { error: String(sim.error).slice(0, 900), eventos: events.slice(-6) } : { ok: true },
    })
  },

  // Reintento aislado de la liberación del tramo 0.
  async release2() {
    const id = st.escrow1
    const intentos: any[] = []
    let b = await build('/escrow/multi-release/release-milestone-funds', { contractId: id, releaseSigner: pk('seller'), milestoneIndex: '0' })
    intentos.push({ cuando: 'reintento directo', status: b.status, message: b.message })
    if (!b.xdr) {
      const e = await readEscrow(id)
      intentos.push({ cuando: 'lectura del escrow', tramo0: e?.milestones?.[0]?.flags ?? e?.milestones?.[0], encontrado: !!e?.milestones })
      await sleep(20000)
      b = await build('/escrow/multi-release/release-milestone-funds', { contractId: id, releaseSigner: pk('seller'), milestoneIndex: '0' })
      intentos.push({ cuando: 'tras 20 s y lectura con validateOnChain', status: b.status, message: b.message })
    }
    if (!b.xdr) { record('S4_liberacion', { ok: false, intentos }); return }
    const insp = inspect(b.xdr)
    const s = await send(b.xdr, [kp('seller')], 'liberación tramo 0')
    await sleep(5000)
    const changes = s.ok ? named(await balanceChanges(s.hash)) : []
    const feeAddr = changes.find((c) => !['seller', 'platform'].includes(c.to) && c.from === 'escrow1')?.to
    record('S4_liberacion', { ok: s.ok, intentos, explorer: s.explorer, xdr: insp, movimientos: changes, cuentaComisionTW: feeAddr ?? null,
      saldoEscrowDespues: await sacBalance(id), error: s.ok ? undefined : s.body })
  },

  // Firma diferida: se arma la resolución del tramo 2, firma una parte y el proceso termina.
  async s6a() {
    const id = st.escrow1
    for (const i of ['1', '2']) {
      const d = await build('/escrow/multi-release/dispute-milestone', { contractId: id, milestoneIndex: i, signer: pk('buyer') })
      if (i === '1') record('S5a_desacuerdo_xdr', d.xdr ? inspect(d.xdr) : { status: d.status, body: d.body })
      if (d.xdr) await send(d.xdr, [kp('buyer')], `desacuerdo tramo ${i}`)
    }
    const b = await build('/escrow/multi-release/resolve-milestone-dispute', { contractId: id, disputeResolver: pk('resolver'), milestoneIndex: '2', distributions: [{ address: pk('buyer'), amount: 3000 }] })
    if (!b.xdr) { record('S6a', { ok: false, status: b.status, body: b.body }); return }
    const firmado = sign(b.xdr, [kp('buyer')])
    st.pending = { xdr: firmado.xdr, at: new Date().toISOString() }
    save()
    record('S6a_primera_firma', { guardada: true, xdr: inspect(b.xdr) })
  },

  // Devolución acordada: 2 de 3 firmas (comprador y desarrollador).
  async s5() {
    const id = st.escrow1
    const b = await build('/escrow/multi-release/resolve-milestone-dispute', { contractId: id, disputeResolver: pk('resolver'), milestoneIndex: '1', distributions: [{ address: pk('buyer'), amount: 3000 }] })
    if (!b.xdr) { record('S5_resolucion', { ok: false, status: b.status, body: b.body }); return }
    const insp = inspect(b.xdr)
    const antes = await sacBalance(pk('buyer'))
    let s = await send(b.xdr, [kp('buyer'), kp('seller')], 'resolución 2 de 3 por la API')
    let via = 'API de Trustless Work'
    if (!s.ok) {
      const signed = sign(b.xdr, [kp('buyer'), kp('seller')])
      const r = await soroban.sendTransaction(TransactionBuilder.fromXDR(signed.xdr, PASS) as Transaction)
      const g = r.status === 'ERROR' ? null : await waitTx(r.hash)
      s = { ...s, ok: g?.status === 'SUCCESS', hash: r.hash, explorer: `${EXPLORER}/tx/${r.hash}` }
      via = 'Soroban RPC directo'
      if (s.ok) await tw('PUT', '/indexer/update-from-txhash', { txHash: r.hash })
    }
    await sleep(5000)
    record('S5_resolucion', { ok: s.ok, via, explorer: s.explorer, xdr: insp, compradorRecibe: (await sacBalance(pk('buyer'))) - antes,
      movimientos: s.ok ? named(await balanceChanges(s.hash)) : [], error: s.ok ? undefined : s.body })
  },

  // Segunda firma en otro proceso, después de que la cuenta de resolución ya firmó otra transacción.
  async s6b() {
    const id = st.escrow1
    const tx = TransactionBuilder.fromXDR(st.pending.xdr, PASS) as Transaction
    tx.sign(kp('seller'))
    const r1 = await tw('POST', '/helper/send-transaction', { signedXdr: tx.toXDR() })
    const viejo = { status: r1.status, body: r1.json }
    const b = await build('/escrow/multi-release/resolve-milestone-dispute', { contractId: id, disputeResolver: pk('resolver'), milestoneIndex: '2', distributions: [{ address: pk('buyer'), amount: 3000 }] })
    const una = await send(b.xdr!, [kp('buyer')], 'rearmada con una sola firma')
    let enRed = false
    try { await horizon.transactions().transaction(una.hash).call(); enRed = true } catch {}
    const dos = await send(b.xdr!, [kp('buyer'), kp('arbiter')], 'rearmada con comprador y tercero')
    record('S6_firma_diferida', {
      firmaGuardadaDesde: st.pending.at, transaccionVieja: viejo,
      rearmadaUnaFirma: { ok: una.ok, status: una.status, body: una.body, quedoRegistrada: enRed },
      rearmadaDosFirmas: { ok: dos.ok, explorer: dos.explorer },
    })
  },

  // Intentos no autorizados registrados en la red, y negativos por la API.
  async s9() {
    if (!st.escrow2) {
      const base: any = {
        signer: pk('platform'), engagementId: 'ESQ-P0-S9-' + Date.now().toString(36), title: 'ESQUORA fase 0 protección', description: 'prueba de protección',
        roles: { approver: pk('buyer'), serviceProvider: pk('seller'), platformAddress: pk('platform'), releaseSigner: pk('seller'), disputeResolver: pk('resolver') },
        platformFee: 1,
        milestones: [{ description: 'Aprobado', amount: 1000, receiver: pk('seller') }, { description: 'Sin aprobar', amount: 1000, receiver: pk('seller') }],
        trustline: { address: pk('issuer'), symbol: CODE },
      }
      if (st.bodyShape?.roles === 'arreglo') { base.roles = [base.roles]; base.trustline = [base.trustline] }
      const d = await build('/deployer/multi-release', base)
      const s = await send(d.xdr!, [kp('platform')], 'desplegar escrow de protección')
      st.escrow2 = s.body?.contractId; save()
      const f = await build('/escrow/multi-release/fund-escrow', { contractId: st.escrow2, signer: pk('anchor'), amount: 2000 })
      await send(f.xdr!, [kp('anchor')], 'depositar 2.000')
      const c = await build('/escrow/multi-release/change-milestone-status', { contractId: st.escrow2, milestoneIndex: '0', newStatus: 'Completed', newEvidence: 'x', serviceProvider: pk('seller') })
      await send(c.xdr!, [kp('seller')], 'evidencia tramo 0')
      const a = await build('/escrow/multi-release/approve-milestone', { contractId: st.escrow2, milestoneIndex: '0', approver: pk('buyer') })
      await send(a.xdr!, [kp('buyer')], 'confirmación tramo 0')
    }
    const id = st.escrow2
    const client = await contract.Client.from({ contractId: id, networkPassphrase: PASS, rpcUrl: 'https://soroban-testnet.stellar.org' })
    const fnSig = (n: string) => {
      const f = client.spec.getFunc(n)
      return g(f,'inputs').map((i: any) => `${g(i,'name').toString()}: ${tname(g(i,'type')).replace('scSpecType', '')}`).join(', ')
    }
    const funcs = client.spec.funcs().map((f: any) => g(f,'name').toString())
    record('S9_funciones_contrato', Object.fromEntries(funcs.map((n: string) => [n, fnSig(n)])))

    // Recursos y huella: de una simulación válida (liberar el tramo 0, ya aprobado).
    const valid = await build('/escrow/multi-release/release-milestone-funds', { contractId: id, releaseSigner: pk('seller'), milestoneIndex: '0' })
    const vtx = TransactionBuilder.fromXDR(valid.xdr!, PASS) as Transaction
    const sorobanData = (vtx.toEnvelope() as any).v1?.tx?.ext?.sorobanData ?? (vtx as any)._tx?.ext?.sorobanData

    async function intento(actor: string, fn: string, args: Record<string, unknown>, label: string) {
      const scArgs = client.spec.funcArgsToScVals(fn, args)
      const auth = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(id).toScAddress(), functionName: fn, args: scArgs })),
          subInvocations: [],
        }),
      })
      const acc = await horizon.loadAccount(pk(actor))
      const data = new SorobanDataBuilder(sorobanData)
      const raw = new TransactionBuilder(new Account(pk(actor), acc.sequence), { fee: '2000000', networkPassphrase: PASS })
        .addOperation(Operation.invokeContractFunction({ contract: id, function: fn, args: scArgs, auth: [auth] }))
        .setSorobanData(data.build()).setTimeout(120).build()
      raw.sign(kp(actor))
      const sent = await soroban.sendTransaction(raw)
      if (sent.status === 'ERROR') return { label, registrada: false, error: JSON.stringify(sent.errorResult).slice(0, 200) }
      const g: any = await waitTx(sent.hash)
      let detalle = ''
      try {
        const evs = (g.diagnosticEventsXdr ?? []).map((e: any) => JSON.stringify(scValToNative(e.event?.body?.v0?.data ?? e)).slice(0, 160))
        detalle = evs.filter((x: string) => /rror|ontract/.test(x)).slice(0, 3).join(' | ')
      } catch {}
      const saldo = await sacBalance(id)
      return { label, registrada: true, estado: g.status, explorer: `${EXPLORER}/tx/${sent.hash}`, saldoEscrowDespues: saldo, detalle }
    }

    const relName = funcs.find((n: string) => n.startsWith('release_milestone')) ?? 'release_milestone_funds'
    const relIn = g(client.spec.getFunc(relName),'inputs').map((i: any) => g(i,'name').toString())
    const idxType = g(client.spec.getFunc(relName),'inputs').find((i: any) => /index/.test(g(i,'name').toString()))?.type ? tname(g(g(client.spec.getFunc(relName),'inputs').find((i: any) => /index/.test(g(i,'name').toString())),'type')) : ''
    const idx = (n: number) => (/U32|I32/.test(idxType) ? n : BigInt(n))
    const relArgs = (who_: string, n: number) => Object.fromEntries(relIn.map((k: string) => [k, /index/.test(k) ? idx(n) : pk(who_)]))
    const out: any[] = []
    out.push(await intento('seller', relName, relArgs('seller', 1), 'El desarrollador intenta cobrar el tramo 1 sin confirmación'))
    const wName = funcs.find((n: string) => n.startsWith('withdraw'))
    if (wName) {
      const wIn = g(client.spec.getFunc(wName),'inputs')
      const args: any = {}
      for (const i of wIn) {
        const n = g(i,'name').toString(); const t = tname(g(i,'type'))
        args[n] = t.includes('Address') ? pk('buyer') : t.includes('Map') ? new Map([[pk('buyer'), 20000000000n]]) : [{ address: pk('buyer'), amount: 20000000000n }]
      }
      try { out.push(await intento('buyer', wName, args, 'El comprador intenta retirar el dinero por su cuenta')) }
      catch (e: any) { out.push({ label: 'El comprador intenta retirar', error: e.message.slice(0, 200) }) }
    }
    out.push(await intento('buyer', relName, relArgs('buyer', 0), 'El comprador intenta ejecutar el cobro en lugar del desarrollador'))
    record('S9_intentos_en_red', out)
  },

  async s10() {
    const id = st.escrow2
    const neg: any = {}
    const t = async (k: string, p: string, body: any, method = 'POST') => {
      const r = await build(p, body, method)
      neg[k] = { status: r.status, construyo: !!r.xdr, message: r.message ?? (r.xdr ? undefined : JSON.stringify(r.body).slice(0, 160)) }
      return r
    }
    await t('compradorCobraTramoAprobado', '/escrow/multi-release/release-milestone-funds', { contractId: id, releaseSigner: pk('buyer'), milestoneIndex: '0' })
    await t('desarrolladorConfirmaTramo1', '/escrow/multi-release/approve-milestone', { contractId: id, milestoneIndex: '1', approver: pk('seller') })
    await t('desarrolladorCobraTramo1SinConfirmar', '/escrow/multi-release/release-milestone-funds', { contractId: id, releaseSigner: pk('seller'), milestoneIndex: '1' })
    await t('ajenoResuelve', '/escrow/multi-release/resolve-milestone-dispute', { contractId: id, disputeResolver: pk('outsider'), milestoneIndex: '1', distributions: [{ address: pk('outsider'), amount: 1000 }] })
    await t('resolucionSinDesacuerdo', '/escrow/multi-release/resolve-milestone-dispute', { contractId: id, disputeResolver: pk('resolver'), milestoneIndex: '1', distributions: [{ address: pk('buyer'), amount: 1000 }] })
    await t('ajenoAbreDesacuerdo', '/escrow/multi-release/dispute-milestone', { contractId: id, milestoneIndex: '1', signer: pk('outsider') })
    await t('tercerAbreDesacuerdo', '/escrow/multi-release/dispute-milestone', { contractId: id, milestoneIndex: '1', signer: pk('resolver') })
    await t('retiroSinTramosCerrados', '/escrow/multi-release/withdraw-remaining-funds', { contractId: id, disputeResolver: pk('resolver'), distributions: [{ address: pk('buyer'), amount: 1000 }] })

    const e = await readEscrow(id)
    const escrow = { ...e }
    for (const k of ['contractId', 'balance', 'createdAt', 'updatedAt', 'isActive', 'type', 'signer', 'user', 'id']) delete escrow[k]
    escrow.milestones = (e.milestones ?? []).map((m: any) => ({ ...m, receiver: pk('platform') }))
    const up = await t('plataformaRedirigeFondos', '/escrow/multi-release/update-escrow', { signer: pk('platform'), contractId: id, escrow }, 'PUT')
    if (up.xdr) {
      const s = await send(up.xdr, [kp('platform')], 'plataforma intenta redirigir')
      neg.plataformaRedirigeFondos.enviada = { ok: s.ok, explorer: s.explorer, body: s.ok ? undefined : s.body }
      const after = await readEscrow(id)
      neg.plataformaRedirigeFondos.receptoresDespues = after?.milestones?.map((m: any) => who(m.receiver))
    }
    record('S10_parte2', neg)
  },

  // ¿La API exige USDC de Circle? Líneas de confianza sin fondos para el desarrollador.
  async probe2() {
    const circle = new Asset('USDC', CIRCLE_USDC_ISSUER)
    const nuestroUSDC = new Asset('USDC', pk('issuer'))
    await classic(kp('seller'), [Operation.changeTrust({ asset: circle })], [kp('seller')])
    const r1 = await build('/deployer/multi-release', probeBody({ address: CIRCLE_USDC_ISSUER, symbol: 'USDC' }))
    const r2 = await build('/deployer/multi-release', probeBody({ address: pk('issuer'), symbol: CODE }))
    await classic(kp('seller'), [Operation.changeTrust({ asset: nuestroUSDC })], [kp('seller')])
    const r3 = await build('/deployer/multi-release', probeBody({ address: pk('issuer'), symbol: 'USDC' }))
    const f = (r: any) => ({ status: r.status, construyo: !!r.xdr, message: r.message })
    record('S1_activo_requerido', {
      circleConLineaDelDesarrollador: f(r1),
      tramousdConLineaDelDesarrollador: f(r2),
      codigoUSDCDeEmisorPropio: f(r3),
    })
  },

  // Paso 3: la plataforma con USDC de emisor propio; si no basta, con USDC de Circle.
  async probe3() {
    const f = (r: any) => ({ status: r.status, construyo: !!r.xdr, message: r.message })
    const out: any = {}
    await classic(kp('platform'), [Operation.changeTrust({ asset: new Asset('USDC', pk('issuer')) })], [kp('platform')])
    out.plataformaConUSDCPropio_activoTRAMOUSD = f(await build('/deployer/multi-release', probeBody({ address: pk('issuer'), symbol: CODE })))
    await classic(kp('platform'), [Operation.changeTrust({ asset: new Asset('USDC', CIRCLE_USDC_ISSUER) })], [kp('platform')])
    out.plataformaConUSDCCircle_activoTRAMOUSD = f(await build('/deployer/multi-release', probeBody({ address: pk('issuer'), symbol: CODE })))
    out.plataformaConUSDCCircle_activoCircle = f(await build('/deployer/multi-release', probeBody({ address: CIRCLE_USDC_ISSUER, symbol: 'USDC' })))
    record('S1_activo_requerido_2', out)
  },

  // ¿Acepta la API una comisión con decimales (0,9 %)? Se despliega y se lee lo guardado en el contrato.
  async feeprobe() {
    const body = { ...probeBody({ address: pk('issuer'), symbol: CODE }), platformFee: 0.9, engagementId: 'ESQ-FEE-' + Date.now().toString(36) }
    const b = await build('/deployer/multi-release', body)
    if (!b.xdr) { record('S2_comision_decimal', { construyo: false, status: b.status, message: b.message }); return }
    const s = await send(b.xdr, [kp('platform')], 'desplegar con 0,9 %')
    const id = s.body?.contractId
    await sleep(4000)
    const acc = await soroban.getAccount(pk('platform'))
    const sim: any = await soroban.simulateTransaction(new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASS })
      .addOperation(Operation.invokeContractFunction({ contract: id, function: 'get_escrow', args: [] })).setTimeout(60).build())
    const e: any = scValToNative(sim.result.retval)
    record('S2_comision_decimal', { construyo: true, enviada: s.ok, platformFeeEnContrato: String(e.platform_fee ?? e.platformFee), lectura: 'puntos básicos: 90 = 0,9 %' })
  },

  // Qué forma de "trustline" acepta la API (solo arma, no envía nada).
  async probe() {
    const variants: Record<string, any> = {
      emisorG: { address: pk('issuer'), symbol: CODE },
      contratoSAC: { address: st.sac, symbol: CODE },
      circleUSDC: { address: CIRCLE_USDC_ISSUER, symbol: 'USDC' },
      emisorG_nombre: { address: pk('issuer'), name: CODE },
      emisorG_simboloCorto: { address: pk('issuer'), symbol: 'USDC' },
    }
    const out: any = {}
    for (const [k, trustline] of Object.entries(variants)) {
      const r = await build('/deployer/multi-release', {
        signer: pk('platform'), engagementId: 'ESQ-PROBE', title: 'probe', description: 'probe',
        roles: { approver: pk('buyer'), serviceProvider: pk('seller'), platformAddress: pk('platform'), releaseSigner: pk('seller'), disputeResolver: pk('resolver') },
        platformFee: 1, milestones: [{ description: 'x', amount: 10, receiver: pk('seller') }], trustline,
      })
      out[k] = { status: r.status, construyo: !!r.xdr, message: r.message ?? (r.xdr ? undefined : JSON.stringify(r.body).slice(0, 200)) }
    }
    record('S1_formas_de_activo', out)
  },

  // ── Camino completo por la API con USDC de Circle (cierra S4 y S5 de 2.1) ──

  // Vuelve a comprobar la cuenta 2 de 3 con la regla corregida.
  async resolvercheck() {
    const racc = await horizon.loadAccount(pk('resolver'))
    record('resolverVerificada', { ok: checkResolver(racc), signers: racc.signers.map((s: any) => [who(s.key), s.weight]),
      thresholds: racc.thresholds, nota: 'Horizon lista la llave maestra con peso 0; se cuentan solo firmantes con peso' })
  },

  // USDC de prueba de Circle para el proveedor simulado: XLM del friendbot cambiado en el pool de Testnet.
  async c0() {
    for (const n of ['anchor', 'buyer', 'seller', 'platform']) {
      const a = await horizon.loadAccount(pk(n))
      if (!a.balances.some((b: any) => b.asset_code === 'USDC' && b.asset_issuer === CIRCLE_USDC_ISSUER))
        await classic(kp(n), [Operation.changeTrust({ asset: CIRCLE })], [kp(n)])
    }
    const circleOf = async (n: string) => Number((await horizon.loadAccount(pk(n))).balances
      .find((b: any) => b.asset_code === 'USDC' && b.asset_issuer === CIRCLE_USDC_ISSUER)?.balance ?? 0)
    const need = 12000
    const have = await circleOf('anchor')
    let hash: string | undefined, xlmUsado: string | undefined
    if (have < need) {
      const falta = (need - have).toFixed(7)
      for (let i = 0; i < 2; i++) {
        const t = Keypair.random()
        const fb = await fetch(`https://friendbot.stellar.org/?addr=${t.publicKey()}`)
        if (!fb.ok) throw new Error('friendbot ' + fb.status)
        await classic(t, [Operation.accountMerge({ destination: pk('anchor') })], [t])
      }
      const q = await horizon.strictReceivePaths([Asset.native()], CIRCLE, falta).call()
      const best = q.records[0]
      xlmUsado = best.source_amount
      const sendMax = (parseFloat(best.source_amount) * 1.02).toFixed(7)
      hash = await classic(kp('anchor'), [Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(), sendMax, destination: pk('anchor'), destAsset: CIRCLE, destAmount: falta,
        path: best.path.map((p: any) => p.asset_type === 'native' ? Asset.native() : new Asset(p.asset_code, p.asset_issuer)),
      })], [kp('anchor')])
    }
    record('C0_usdc_circle', { proveedorUSDC: await circleOf('anchor'), xlmUsado, explorer: hash ? `${EXPLORER}/tx/${hash}` : undefined,
      via: 'XLM de friendbot cambiado por USDC de Circle en el pool de liquidez de Testnet' })
  },

  // S1 y S3 con USDC de Circle: plantilla de preventa (6.000 + 6.000), comisión 0,9 %.
  async c1() {
    const contratoSha = 'a3f1'.repeat(16), acuerdoSha = '9c2e'.repeat(16)
    const d = await build('/deployer/multi-release', {
      signer: pk('platform'), engagementId: 'ESQ-P0-C-' + Date.now().toString(36), title: 'ESQUORA fase 0 USDC Circle',
      description: `contrato:sha256:${contratoSha} acuerdo:sha256:${acuerdoSha}`,
      roles: { approver: pk('buyer'), serviceProvider: pk('seller'), platformAddress: pk('platform'), releaseSigner: pk('seller'), disputeResolver: pk('resolver') },
      platformFee: 0.9,
      milestones: [
        { description: 'Documentacion del proyecto', amount: 6000, receiver: pk('seller') },
        { description: 'Inicio de obra', amount: 6000, receiver: pk('seller') },
      ],
      trustline: { address: CIRCLE_USDC_ISSUER, symbol: 'USDC' },
    })
    if (!d.xdr) { record('S1_circle_plantilla', { ok: false, status: d.status, body: d.body }); return }
    const s = await send(d.xdr, [kp('platform')], 'desplegar escrow USDC Circle')
    st.escrow3 = s.body?.contractId; save()
    record('S1_circle_plantilla', { ok: s.ok && !!st.escrow3, contractId: st.escrow3, explorer: s.explorer,
      contrato: `${EXPLORER}/contract/${st.escrow3}` })
    if (!s.ok) return
    await sleep(3000)
    const f = await build('/escrow/multi-release/fund-escrow', { contractId: st.escrow3, signer: pk('anchor'), amount: 12000 })
    if (!f.xdr) { record('S3_circle_deposito', { ok: false, status: f.status, body: f.body }); return }
    const sf = await send(f.xdr, [kp('anchor')], 'depositar 12.000 USDC de Circle')
    await sleep(4000)
    record('S3_circle_deposito', { ok: sf.ok, explorer: sf.explorer, saldoRed: await sacBalance(st.escrow3, CIRCLE_SAC) })
  },

  // S4 por la API: evidencia, confirmación y liberación del tramo 1.
  async c2() {
    const id = st.escrow3
    const pasos: any[] = []
    const paso = async (label: string, path: string, body: any, signer: string) => {
      const b = await build(path, body)
      if (!b.xdr) { pasos.push({ paso: label, construyo: false, status: b.status, message: b.message }); return null }
      const s = await send(b.xdr, [kp(signer)], label)
      pasos.push({ paso: label, ok: s.ok, explorer: s.explorer })
      await sleep(3000)
      return s
    }
    await paso('evidencia', '/escrow/multi-release/change-milestone-status',
      { contractId: id, milestoneIndex: '0', newStatus: 'Completed', newEvidence: 'sha256:' + 'd0c5'.repeat(16), serviceProvider: pk('seller') }, 'seller')
    await paso('confirmación del comprador', '/escrow/multi-release/approve-milestone', { contractId: id, milestoneIndex: '0', approver: pk('buyer') }, 'buyer')
    const antes = await sacBalance(id, CIRCLE_SAC)
    const s = await paso('liberación por la API', '/escrow/multi-release/release-milestone-funds', { contractId: id, releaseSigner: pk('seller'), milestoneIndex: '0' }, 'seller')
    await sleep(4000)
    const mov = s?.ok ? named(await balanceChanges(s.hash)) : []
    const feeTW = mov.find((c) => c.from === id && !['seller', 'platform'].includes(c.to))?.to
    record('S4_circle_liberacion_API', { ok: !!s?.ok, pasos, saldoEscrowAntes: antes, saldoEscrowDespues: await sacBalance(id, CIRCLE_SAC),
      movimientos: mov.map((c) => ({ ...c, from: c.from === id ? 'escrow3' : c.from, pct: ((c.amount / 6000) * 100).toFixed(2) + ' %' })),
      cuentaComisionTW: feeTW ?? null })
  },

  // S5 por la API: desacuerdo del tramo 2 y devolución con la cuenta 2 de 3 (comprador + desarrollador).
  async c3() {
    const id = st.escrow3
    const d = await build('/escrow/multi-release/dispute-milestone', { contractId: id, milestoneIndex: '1', signer: pk('buyer') })
    const sd = d.xdr ? await send(d.xdr, [kp('buyer')], 'desacuerdo tramo 2') : null
    await sleep(4000)
    const antes = await sacBalance(pk('buyer'), CIRCLE_SAC)
    const b = await build('/escrow/multi-release/resolve-milestone-dispute',
      { contractId: id, disputeResolver: pk('resolver'), milestoneIndex: '1', distributions: [{ address: pk('buyer'), amount: 6000 }] })
    if (!b.xdr) {
      record('S5_circle_devolucion_API', { ok: false, desacuerdo: sd ? { ok: sd.ok, explorer: sd.explorer } : { status: d.status, message: d.message },
        construyo: false, status: b.status, message: b.message })
      return
    }
    const insp = inspect(b.xdr)
    const s = await send(b.xdr, [kp('buyer'), kp('seller')], 'devolución 2 de 3 por la API')
    await sleep(5000)
    const mov = s.ok ? named(await balanceChanges(s.hash)) : []
    record('S5_circle_devolucion_API', { ok: s.ok, desacuerdo: sd ? { ok: sd.ok, explorer: sd.explorer } : null, explorer: s.explorer,
      origen: who(insp.source), compradorRecibe: +((await sacBalance(pk('buyer'), CIRCLE_SAC)) - antes).toFixed(7),
      movimientos: mov.map((c) => ({ ...c, from: c.from === id ? 'escrow3' : c.from })),
      saldoEscrowDespues: await sacBalance(id, CIRCLE_SAC), error: s.ok ? undefined : s.body })
  },

  async report() {
    for (const [k, v] of Object.entries(st.results)) log(`\n### ${k}\n${JSON.stringify(v, null, 2)}`)
  },
}

const stage = process.argv[2]
if (!stages[stage]) { console.error('Etapas:', Object.keys(stages).join(' | ')); process.exit(1) }
await stages[stage]()
