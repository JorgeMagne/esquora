// Fase 0, pruebas S7 y S8 de PLAN.md: Pollar con una persona real que inicia sesión.
// Servidor desechable (no es la aplicación). Usa las cuentas de prueba de data/fase0-state.json.
// Uso: npx tsx scripts/spikes/pollar-server.ts   (escucha en :8788; Vite lo expone en /spike)
//
// S7: verificación del token en el backend, línea de confianza, signMessage (SEP-53) y signTx
//     de una transacción de Trustless Work cuyo origen es la propia billetera.
// S8: ¿firma Pollar la resolución de la cuenta 2 de 3?
//     Ruta A: signTx de la transacción de resolución (origen = cuenta 2 de 3).
//     Ruta B: signAuthEntry de la entrada de autorización de la cuenta 2 de 3 (origen = plataforma).

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import {
  Address, Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, StrKey, Transaction, TransactionBuilder,
  contract, hash, rpc, scValToNative, xdr,
} from '@stellar/stellar-sdk'

const ROOT = process.cwd()
const PASS = Networks.TESTNET
const API = 'https://dev.api.trustlesswork.com'
const EXPLORER = 'https://stellar.expert/explorer/testnet'
const POLLAR_SERVER = 'https://server.api.pollar.xyz'
const CIRCLE_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const CIRCLE = new Asset('USDC', CIRCLE_USDC_ISSUER)
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org')
const soroban = new rpc.Server('https://soroban-testnet.stellar.org')

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
    .map((m) => [m![1], m![2].trim()]),
)
const TW_KEY = env.TRUSTLESS_WORK_API_KEY
const POLLAR_SECRET = env.POLLAR_SECRET_KEY
if (!TW_KEY || !POLLAR_SECRET) throw new Error('Faltan TRUSTLESS_WORK_API_KEY o POLLAR_SECRET_KEY en .env')

const STATE = join(ROOT, 'data', 'fase0-state.json')
const load = () => JSON.parse(readFileSync(STATE, 'utf8'))
const st: any = existsSync(STATE) ? load() : (() => { throw new Error('Falta data/fase0-state.json: corre la fase 0 primero') })()
const save = () => writeFileSync(STATE, JSON.stringify(st, null, 2))
const kp = (n: string) => Keypair.fromSecret(st.keys[n])
const pk = (n: string) => kp(n).publicKey()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const record = (k: string, v: unknown) => {
  st.results[k] = { ...(v as object), at: new Date().toISOString() }
  save()
  console.log(`\n[${k}]`, JSON.stringify(v, null, 2))
}

// ───────────── Trustless Work ─────────────
let last = 0
async function tw(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const wait = last + 1400 - Date.now()
  if (wait > 0) await sleep(wait)
  last = Date.now()
  const res = await fetch(API + path, {
    method,
    headers: { 'x-api-key': TW_KEY, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  if (res.status === 429) { await sleep(61_000); return tw(method, path, body) }
  return { status: res.status, json }
}
async function build(path: string, body: any) {
  const r = await tw('POST', path, body)
  return { status: r.status, xdr: r.json?.unsignedTransaction as string | undefined, message: r.json?.message as string | undefined }
}
async function sendSigned(signedXdr: string) {
  const r = await tw('POST', '/helper/send-transaction', { signedXdr })
  const ok = r.status < 300 && (r.json?.status ?? 'SUCCESS') !== 'FAILED'
  const tx = TransactionBuilder.fromXDR(signedXdr, PASS) as Transaction
  const h = Buffer.from(tx.hash()).toString('hex')
  return { ok, status: r.status, body: ok ? undefined : r.json, hash: h, explorer: `${EXPLORER}/tx/${h}` }
}
async function signLocalAndSend(unsigned: string, signers: string[]) {
  const tx = TransactionBuilder.fromXDR(unsigned, PASS) as Transaction
  for (const s of signers) tx.sign(kp(s))
  return sendSigned(tx.toXDR())
}

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
async function accountOrNull(addr: string) {
  try { return await horizon.loadAccount(addr) } catch { return null }
}
const hasCircle = (acc: any) => !!acc?.balances.some((b: any) => b.asset_code === 'USDC' && b.asset_issuer === CIRCLE_USDC_ISSUER)

// Firma que trae una transacción para una llave dada (por la pista de 4 bytes) y si es válida.
function signatureOf(tx: Transaction, publicKey: string) {
  const k = Keypair.fromPublicKey(publicKey)
  const hint = Buffer.from(k.rawPublicKey()).subarray(28)
  const bytes = (v: any) => Buffer.from(v?.toXdrObject?.() ?? v)
  const sig = (tx.signatures as any[]).find((s) => bytes(s.hint).equals(hint))
  return sig ? { presente: true, valida: k.verify(tx.hash(), bytes(sig.signature)) } : { presente: false, valida: false, firmas: tx.signatures.length }
}

// ───────────── Servidor ─────────────
const app = new Hono()
app.onError((err, c) => { console.error(err); return c.json({ error: err.message }, 500) })

// Resultados que solo ve el navegador (línea de confianza, ventana de confirmación, errores de Pollar).
app.post('/spike/record', async (c) => {
  const { key, value } = await c.req.json()
  if (!/^S[78]_[A-Za-z0-9_]+$/.test(key)) return c.json({ error: 'clave no válida' }, 400)
  record(key, value)
  return c.json({ ok: true })
})

// S7: el backend valida el token de Pollar. No se guarda el correo ni el nombre del usuario.
app.post('/spike/s7/verify', async (c) => {
  const { token } = await c.req.json()
  const res = await fetch(`${POLLAR_SERVER}/v3/tokens/verify`, {
    method: 'POST',
    headers: { 'x-pollar-api-key': POLLAR_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  const j: any = await res.json().catch(() => null)
  const content = j?.content ?? j?.data ?? j
  const out = {
    ok: res.ok, httpStatus: res.status, code: j?.code,
    wallet: content?.wallet ? { type: content.wallet.type, address: content.wallet.address } : null,
    authProvider: content?.authProvider, network: content?.network, expiresAt: content?.expiresAt,
    camposDevueltos: content ? Object.keys(content) : [],
  }
  record('S7_verificacion_backend', out)
  return c.json(out)
})

// S7: SEP-53. El backend comprueba la firma de la huella del acuerdo con la llave pública de la billetera.
app.post('/spike/s7/sep53', async (c) => {
  const { message, signature, signerAddress, expected } = await c.req.json()
  const digest = createHash('sha256').update(Buffer.concat([Buffer.from('Stellar Signed Message:\n'), Buffer.from(message)])).digest()
  const valida = StrKey.isValidEd25519PublicKey(signerAddress) && Keypair.fromPublicKey(signerAddress).verify(digest, Buffer.from(signature, 'base64'))
  const out = { ok: valida, firmanteEsLaBilletera: signerAddress === expected, mensaje: message, esquema: 'SEP-53: ed25519 sobre SHA-256("Stellar Signed Message:\\n" + mensaje)' }
  record('S7_signMessage', out)
  return c.json(out)
})

// Prepara todo lo que no necesita a la persona: XLM para comisiones, cuenta 2 de 3 con la billetera
// como firmante, escrow con la billetera como "approver", depósito y evidencia del tramo 1.
app.post('/spike/prepare', async (c) => {
  const { address } = await c.req.json()
  if (!StrKey.isValidEd25519PublicKey(address)) return c.json({ error: 'dirección no válida' }, 400)
  const pasos: any[] = []
  const f = kp('funder')

  const acc = await accountOrNull(address)
  if (!acc) {
    await classic(f, [Operation.createAccount({ destination: address, startingBalance: '20' })], [f])
    pasos.push('cuenta creada con 20 XLM')
  } else {
    const xlm = Number(acc.balances.find((b: any) => b.asset_type === 'native')?.balance ?? 0)
    if (xlm < 10) { await classic(f, [Operation.payment({ destination: address, asset: Asset.native(), amount: '20' })], [f]); pasos.push('20 XLM enviados') }
  }

  // Cuenta 2 de 3 propia de esta prueba: billetera Pollar + desarrollador + tercero.
  if (!st.keys.resolverPollar || st.pollar?.address !== address) {
    st.keys.resolverPollar = Keypair.random().secret(); save()
    const r = kp('resolverPollar')
    await classic(f, [
      Operation.createAccount({ destination: r.publicKey(), startingBalance: '20' }),
      Operation.setOptions({ source: r.publicKey(), signer: { ed25519PublicKey: address, weight: 1 } }),
      Operation.setOptions({ source: r.publicKey(), signer: { ed25519PublicKey: pk('seller'), weight: 1 } }),
      Operation.setOptions({ source: r.publicKey(), signer: { ed25519PublicKey: pk('arbiter'), weight: 1 },
        masterWeight: 0, lowThreshold: 2, medThreshold: 2, highThreshold: 2 }),
    ], [f, r])
    pasos.push('cuenta 2 de 3 creada: billetera Pollar, desarrollador y tercero')
  }

  const d = await build('/deployer/multi-release', {
    signer: pk('platform'), engagementId: 'ESQ-P0-POLLAR-' + Date.now().toString(36), title: 'ESQUORA fase 0 Pollar',
    description: 'prueba S7 y S8',
    roles: { approver: address, serviceProvider: pk('seller'), platformAddress: pk('platform'), releaseSigner: pk('seller'), disputeResolver: pk('resolverPollar') },
    platformFee: 0.9,
    milestones: [
      { description: 'Documentacion del proyecto', amount: 100, receiver: pk('seller') },
      { description: 'Inicio de obra (ruta A)', amount: 100, receiver: pk('seller') },
      { description: 'Inicio de obra (ruta B)', amount: 100, receiver: pk('seller') },
    ],
    trustline: { address: CIRCLE_USDC_ISSUER, symbol: 'USDC' },
  })
  if (!d.xdr) return c.json({ error: `despliegue: ${d.status} ${d.message}`, pasos }, 502)
  const sd = await signLocalAndSend(d.xdr, ['platform'])
  if (!sd.ok) return c.json({ error: 'despliegue rechazado', detalle: sd.body, pasos }, 502)
  // El id del contrato viene en la respuesta del envío.
  const contractId = await contractFromDeploy(sd.hash)
  st.pollar = { address, escrow: contractId, resolver: pk('resolverPollar') }; save()
  pasos.push(`escrow desplegado ${contractId}`)
  await sleep(3000)

  const fe = await build('/escrow/multi-release/fund-escrow', { contractId, signer: pk('buyer'), amount: 300 })
  const sf = fe.xdr ? await signLocalAndSend(fe.xdr, ['buyer']) : null
  pasos.push(`depósito de 300: ${sf?.ok ? 'ok' : fe.message}`)
  await sleep(3000)
  const ev = await build('/escrow/multi-release/change-milestone-status',
    { contractId, milestoneIndex: '0', newStatus: 'Completed', newEvidence: 'sha256:' + 'd0c5'.repeat(16), serviceProvider: pk('seller') })
  const se = ev.xdr ? await signLocalAndSend(ev.xdr, ['seller']) : null
  pasos.push(`evidencia del tramo 1: ${se?.ok ? 'ok' : ev.message}`)
  await sleep(3000)
  for (const i of ['1', '2']) {
    const dp = await build('/escrow/multi-release/dispute-milestone', { contractId, milestoneIndex: i, signer: pk('seller') })
    const sdp = dp.xdr ? await signLocalAndSend(dp.xdr, ['seller']) : null
    pasos.push(`desacuerdo del tramo ${Number(i) + 1}: ${sdp?.ok ? 'ok' : dp.message}`)
    await sleep(3000)
  }

  const out = { escrow: contractId, contrato: `${EXPLORER}/contract/${contractId}`, resolver: pk('resolverPollar'), pasos }
  record('S7_preparacion', out)
  return c.json(out)
})

async function contractFromDeploy(txHash: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const g: any = await soroban.getTransaction(txHash)
    if (g.status === 'SUCCESS') {
      // El despliegador devuelve un vector; el id del contrato es el elemento que empieza con C.
      const flat = JSON.stringify(scValToNative(g.returnValue), (_k, v) => (typeof v === 'bigint' ? String(v) : v))
      const id = flat.match(/C[A-Z2-7]{55}/)?.[0]
      if (id) return id
      throw new Error('sin id de contrato en la respuesta: ' + flat.slice(0, 200))
    }
    if (g.status === 'FAILED') throw new Error('el despliegue falló en la red')
    await sleep(1500)
  }
  throw new Error('sin confirmación del despliegue')
}

// S7 signTx: confirmación del tramo 1. Origen = la billetera Pollar (rol approver).
app.post('/spike/s7/approve-xdr', async (c) => {
  const b = await build('/escrow/multi-release/approve-milestone', { contractId: st.pollar.escrow, milestoneIndex: '0', approver: st.pollar.address })
  if (!b.xdr) return c.json({ error: `${b.status} ${b.message}` }, 502)
  st.pollar.approveXdr = b.xdr; save()
  return c.json({ xdr: b.xdr })
})
app.post('/spike/s7/approve-submit', async (c) => {
  const { signedXdr, ms } = await c.req.json()
  const tx = TransactionBuilder.fromXDR(signedXdr, PASS) as any
  const inner: Transaction = tx.innerTransaction ?? tx
  const orig = TransactionBuilder.fromXDR(st.pollar.approveXdr, PASS) as Transaction
  const out: any = {
    feeBump: !!tx.innerTransaction, mismaTransaccion: Buffer.from(inner.hash()).equals(Buffer.from(orig.hash())),
    firma: signatureOf(inner, st.pollar.address), msHastaFirmar: ms,
  }
  const s = await sendSigned(signedXdr)
  record('S7_signTx_TrustlessWork', { ok: s.ok, ...out, explorer: s.explorer, error: s.body })
  return c.json({ ok: s.ok, ...out, explorer: s.explorer, error: s.body })
})

// S8 ruta A: la API arma la resolución; su origen es la cuenta 2 de 3. Pollar firma con signTx;
// el desarrollador agrega la segunda firma aquí.
app.post('/spike/s8a/xdr', async (c) => {
  const acc = await accountOrNull(st.pollar.address)
  const to = hasCircle(acc) ? st.pollar.address : pk('buyer')
  const b = await build('/escrow/multi-release/resolve-milestone-dispute', {
    contractId: st.pollar.escrow, disputeResolver: st.pollar.resolver, milestoneIndex: '1', distributions: [{ address: to, amount: 100 }],
  })
  if (!b.xdr) return c.json({ error: `${b.status} ${b.message}` }, 502)
  const tx = TransactionBuilder.fromXDR(b.xdr, PASS) as Transaction
  st.pollar.resolveXdr = b.xdr; st.pollar.resolveTo = to; save()
  return c.json({ xdr: b.xdr, origen: tx.source, destino: to === st.pollar.address ? 'billetera Pollar' : 'comprador local' })
})
app.post('/spike/s8a/submit', async (c) => {
  const { signedXdr, ms } = await c.req.json()
  const tx = TransactionBuilder.fromXDR(signedXdr, PASS) as any
  if (tx.innerTransaction) {
    const out = { ok: false, motivo: 'Pollar devolvió un fee-bump; con skipSponsorship no debería', feeBump: true }
    record('S8_rutaA_signTx', out)
    return c.json(out)
  }
  const inner = tx as Transaction
  const orig = TransactionBuilder.fromXDR(st.pollar.resolveXdr, PASS) as Transaction
  const firma = signatureOf(inner, st.pollar.address)
  const misma = Buffer.from(inner.hash()).equals(Buffer.from(orig.hash()))
  inner.sign(kp('seller'))
  const s = await sendSigned(inner.toXDR())
  await sleep(4000)
  const out = { ok: s.ok, firmaPollar: firma, mismaTransaccion: misma, segundaFirma: 'desarrollador (local)', explorer: s.explorer, error: s.body, msHastaFirmar: ms }
  record('S8_rutaA_signTx', out)
  return c.json(out)
})

// S8 ruta B: la plataforma es el origen y paga; la cuenta 2 de 3 autoriza con una entrada firmada.
const clients = new Map<string, any>()
async function getClient(id: string) {
  if (!clients.has(id)) clients.set(id, await contract.Client.from({ contractId: id, networkPassphrase: PASS, rpcUrl: 'https://soroban-testnet.stellar.org' }))
  return clients.get(id)
}
const TW_FEE = 'GA6KH5VWPCHBOEF63X57SPX6T4H366YFFKKGCVDBTXT2N7JVL6PJCK7G' // la que puso la API en S4 (USDC de Circle)

async function resolveOp(to: string) {
  const client = await getClient(st.pollar.escrow)
  const args = client.spec.funcArgsToScVals('resolve_milestone_dispute', {
    dispute_resolver: st.pollar.resolver, milestone_index: 2, trustless_work_address: TW_FEE,
    distributions: new Map([[to, 1_000_000_000n]]), // 100 USDC, 7 decimales
  })
  return { args }
}

// Lectura tolerante de la forma XDR de stellar-sdk 17 (propiedades, uniones con `type`).
const X: any = xdr
// Testnet emite ya `sorobanCredentialsAddressV2` (CAP-71: la dirección entra en lo que se firma).
const addrCreds = (e: any) => (e.credentials.type === 'sorobanCredentialsAddress' ? e.credentials.address
  : e.credentials.type === 'sorobanCredentialsAddressV2' ? e.credentials.addressV2 : null)
const rawBytes = (v: any): Uint8Array => (v instanceof Uint8Array ? v : v?.toXdrObject?.() ?? v?.value ?? v?.bytes ?? new Uint8Array())
const symOf = (v: any) => Buffer.from(rawBytes(v.sym)).toString()
function readSigs(sigVal: any): { pub: Buffer; sig: Buffer; raw: any }[] {
  if (sigVal?.type !== 'scvVec') return []
  return (sigVal.vec ?? []).map((m: any) => {
    const get = (k: string) => Buffer.from(rawBytes((m.map ?? []).find((e: any) => symOf(e.key) === k)?.val.bytes))
    return { pub: get('public_key'), sig: get('signature'), raw: m }
  })
}
function authPayload(entry: any, creds: any) {
  const base = { networkId: hash(Buffer.from(PASS)), nonce: creds.nonce, signatureExpirationLedger: creds.signatureExpirationLedger, invocation: entry.rootInvocation }
  const pre = entry.credentials.type === 'sorobanCredentialsAddressV2'
    ? X.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(new X.HashIdPreimageSorobanAuthorizationWithAddress({ ...base, address: creds.address }))
    : X.HashIdPreimage.envelopeTypeSorobanAuthorization(new X.HashIdPreimageSorobanAuthorization(base))
  return hash(Buffer.from(pre.toXdr()))
}

app.post('/spike/s8b/entry', async (c) => {
  const acc = await accountOrNull(st.pollar.address)
  const to = hasCircle(acc) ? st.pollar.address : pk('buyer')
  const { args } = await resolveOp(to)
  const src = await soroban.getAccount(pk('platform'))
  const raw = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(Operation.invokeContractFunction({ contract: st.pollar.escrow, function: 'resolve_milestone_dispute', args }))
    .setTimeout(300).build()
  const sim = await soroban.simulateTransaction(raw)
  if (rpc.Api.isSimulationError(sim)) return c.json({ error: 'simulación: ' + String(sim.error).slice(0, 400) }, 502)
  const entries: any[] = (sim.result?.auth ?? []) as any[]
  const idx = entries.findIndex((e) => { const a = addrCreds(e); return a && Address.fromScAddress(a.address).toString() === st.pollar.resolver })
  if (idx < 0) return c.json({ error: 'la simulación no pidió la autorización de la cuenta 2 de 3' }, 502)
  // Pollar solo firma entradas `sorobanCredentialsAddress` (V1): con V2 responde SOROBAN_AUTH_ENTRY_INVALID.
  // La red sigue aceptando V1 (simulación estricta: 2 firmas pasan, 1 se rechaza), así que se convierte.
  const c0 = addrCreds(entries[idx])
  entries[idx] = new X.SorobanAuthorizationEntry({
    credentials: X.SorobanCredentials.sorobanCredentialsAddress(new X.SorobanAddressCredentials({
      address: c0.address, nonce: c0.nonce, signatureExpirationLedger: 0, signature: X.ScVal.scvVoid(),
    })),
    rootInvocation: entries[idx].rootInvocation,
  })
  const validUntilLedger = sim.latestLedger + 60 // ~5 minutos
  st.pollar.s8b = { to, entries: entries.map((e) => e.toXdr('base64')), idx, validUntilLedger }; save()
  return c.json({ entryXdr: entries[idx].toXdr('base64'), validUntilLedger, destino: to === st.pollar.address ? 'billetera Pollar' : 'comprador local' })
})

app.post('/spike/s8b/submit', async (c) => {
  const { signedAuthEntry, ms } = await c.req.json()
  const s8 = st.pollar.s8b
  const entry: any = X.SorobanAuthorizationEntry.fromXdr(signedAuthEntry, 'base64')
  const creds = addrCreds(entry)
  if (!creds) {
    const out = { ok: false, motivo: 'la entrada firmada no trae credenciales de dirección', tipo: entry.credentials.type }
    record('S8_rutaB_signAuthEntry', out)
    return c.json(out)
  }
  const payload = authPayload(entry, creds)
  const existing = readSigs(creds.signature)
  const pollarSig = existing.find((s) => s.pub.length === 32 && StrKey.encodeEd25519PublicKey(s.pub) === st.pollar.address)
  const firmaPollar = pollarSig ? { presente: true, valida: Keypair.fromPublicKey(st.pollar.address).verify(payload, pollarSig.sig) }
    : { presente: false, valida: false, firmantesQueTrae: existing.map((s) => s.pub.length === 32 ? StrKey.encodeEd25519PublicKey(s.pub) : s.pub.toString('hex')) }

  // Segunda firma (desarrollador) sobre la misma entrada y el mismo vencimiento.
  const bySeller: any = await (await import('@stellar/stellar-sdk') as any).authorizeEntry(entry, kp('seller'), creds.signatureExpirationLedger, PASS)
  const sellerSigs = readSigs(addrCreds(bySeller).signature)
  const all = [...existing, ...sellerSigs].sort((a, b) => Buffer.compare(a.pub, b.pub)).map((s) => s.raw)
  const merged = new X.SorobanAuthorizationEntry({
    credentials: X.SorobanCredentials[entry.credentials.type](new X.SorobanAddressCredentials({
      address: creds.address, nonce: creds.nonce, signatureExpirationLedger: creds.signatureExpirationLedger, signature: X.ScVal.scvVec(all),
    })),
    rootInvocation: entry.rootInvocation,
  })

  const entries = s8.entries.map((e: string) => X.SorobanAuthorizationEntry.fromXdr(e, 'base64'))
  entries[s8.idx] = merged
  const { args } = await resolveOp(s8.to)
  const src = await soroban.getAccount(pk('platform'))
  const raw = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(Operation.invokeContractFunction({ contract: st.pollar.escrow, function: 'resolve_milestone_dispute', args, auth: entries }))
    .setTimeout(120).build()
  const sim = await soroban.simulateTransaction(raw)
  if (rpc.Api.isSimulationError(sim)) {
    const out = { ok: false, firmaPollar, expiraEnLedger: creds.signatureExpirationLedger, etapa: 'simulación con firmas', error: String(sim.error).slice(0, 500), msHastaFirmar: ms }
    record('S8_rutaB_signAuthEntry', out)
    return c.json(out)
  }
  const tx = rpc.assembleTransaction(raw, sim).build()
  tx.sign(kp('platform'))
  const sent = await soroban.sendTransaction(tx)
  let estado: string = sent.status
  if (sent.status !== 'ERROR') {
    for (let i = 0; i < 30; i++) { const g = await soroban.getTransaction(sent.hash); if (g.status !== 'NOT_FOUND') { estado = g.status; break } await sleep(1500) }
  }
  const out = { ok: estado === 'SUCCESS', estado, firmaPollar, credenciales: entry.credentials.type, expiraEnLedger: creds.signatureExpirationLedger,
    segundaFirma: 'desarrollador (local)', origenYComision: 'plataforma', explorer: `${EXPLORER}/tx/${sent.hash}`, msHastaFirmar: ms }
  record('S8_rutaB_signAuthEntry', out)
  return c.json(out)
})

app.get('/spike/state', (c) => {
  const r = load().results
  return c.json(Object.fromEntries(Object.entries(r).filter(([k]) => /^S[78]_/.test(k))))
})

serve({ fetch: app.fetch, port: 8788 }, () => console.log('Servidor de prueba de Pollar en http://localhost:8788'))
