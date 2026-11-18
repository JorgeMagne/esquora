// Verificación en Testnet (desechable, no es parte de la aplicación).
//
// Preguntas que responde:
//   P1. ¿Una cuenta clásica con 3 firmantes y umbral 2 puede autorizar una llamada a un
//       contrato Soroban (require_auth) con dos firmas en el sobre?
//   P2. ¿Qué pasa con una sola firma? ¿Queda algo registrado en la red?
//   P3. ¿Se puede lograr que un intento inválido quede registrado como transacción
//       fallida, visible en el explorador?
//   P4. ¿Funciona también cuando la cuenta de 3 firmas NO es el origen de la transacción
//       (autoriza mediante una entrada de autorización firmada por dos firmantes)?
//
// Usa un activo de prueba propio ("USDC") y su contrato de activo (SAC), que es el mismo
// tipo de contrato de token con el que opera un escrow de Soroban.

import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'

const PASS = Networks.TESTNET
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org')
const soroban = new rpc.Server('https://soroban-testnet.stellar.org')
const EXPLORER = 'https://stellar.expert/explorer/testnet'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function friendbot(pk: string) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${pk}`)
  if (!res.ok) throw new Error(`friendbot ${res.status}`)
}

async function classic(source: Keypair, ops: xdr.Operation[], signers: Keypair[]) {
  const acc = await horizon.loadAccount(source.publicKey())
  const b = new TransactionBuilder(acc, { fee: '1000', networkPassphrase: PASS })
  ops.forEach((o) => b.addOperation(o))
  const tx = b.setTimeout(120).build()
  tx.sign(...signers)
  try {
    return (await horizon.submitTransaction(tx)).hash
  } catch (e: any) {
    throw new Error('classic tx failed: ' + JSON.stringify(e?.response?.data?.extras?.result_codes ?? e?.message))
  }
}

async function sendAndWait(tx: any) {
  const sent = await soroban.sendTransaction(tx)
  if (sent.status === 'ERROR') {
    const er: any = sent.errorResult
    let error = 'ERROR'
    try {
      error = er?.result?.().switch?.().name ?? er?._attributes?.result?._switch?.name ?? JSON.stringify(er).slice(0, 300)
    } catch {}
    return { accepted: false as const, hash: sent.hash, error }
  }
  for (let i = 0; i < 40; i++) {
    const got = await soroban.getTransaction(sent.hash)
    if (got.status !== 'NOT_FOUND') return { accepted: true as const, hash: sent.hash, status: got.status }
    await sleep(1500)
  }
  throw new Error('timeout waiting for ' + sent.hash)
}

const out: Record<string, unknown> = {}

// ───────────── Preparación ─────────────
const funder = Keypair.random()
const issuer = Keypair.random()
const M = Keypair.random() // cuenta de 3 firmas
const R = Keypair.random() // destinatario
const [A, B, C] = [Keypair.random(), Keypair.random(), Keypair.random()]
const usdc = new Asset('USDC', issuer.publicKey())

await Promise.all([friendbot(funder.publicKey()), friendbot(issuer.publicKey())])

await classic(
  funder,
  [
    Operation.createAccount({ destination: M.publicKey(), startingBalance: '30' }),
    Operation.createAccount({ destination: R.publicKey(), startingBalance: '5' }),
    Operation.changeTrust({ asset: usdc, source: M.publicKey() }),
    Operation.changeTrust({ asset: usdc, source: R.publicKey() }),
    Operation.setOptions({ signer: { ed25519PublicKey: A.publicKey(), weight: 1 }, source: M.publicKey() }),
    Operation.setOptions({ signer: { ed25519PublicKey: B.publicKey(), weight: 1 }, source: M.publicKey() }),
    Operation.setOptions({
      signer: { ed25519PublicKey: C.publicKey(), weight: 1 },
      masterWeight: 0,
      lowThreshold: 2,
      medThreshold: 2,
      highThreshold: 2,
      source: M.publicKey(),
    }),
  ],
  [funder, M, R],
)
await classic(issuer, [Operation.payment({ destination: M.publicKey(), asset: usdc, amount: '1000' })], [issuer])

// Contrato del activo (SAC)
{
  const acc = await soroban.getAccount(funder.publicKey())
  const raw = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(Operation.createStellarAssetContract({ asset: usdc }))
    .setTimeout(120)
    .build()
  const tx = await soroban.prepareTransaction(raw)
  tx.sign(funder)
  const r = await sendAndWait(tx)
  out.sacDeploy = r
}
const cid = usdc.contractId(PASS)
const contract = new Contract(cid)
const units = (n: number) => nativeToScVal(BigInt(n) * 10_000_000n, { type: 'i128' })
const transferArgs = (from: string, to: string, n: number) => [
  Address.fromString(from).toScVal(),
  Address.fromString(to).toScVal(),
  units(n),
]
const balanceOf = async (pk: string) => {
  const acc = await horizon.loadAccount(pk)
  return (acc.balances.find((b: any) => b.asset_code === 'USDC') as any)?.balance
}

out.setup = { multisig: M.publicKey(), recipient: R.publicKey(), contract: cid }

// ───────────── P1: dos firmas ─────────────
{
  const acc = await soroban.getAccount(M.publicKey())
  const raw = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(contract.call('transfer', ...transferArgs(M.publicKey(), R.publicKey(), 100)))
    .setTimeout(120)
    .build()
  const tx = await soroban.prepareTransaction(raw)
  tx.sign(A, B)
  out.P1_dos_firmas = { ...(await sendAndWait(tx)), saldoDestino: await balanceOf(R.publicKey()) }
}

// ───────────── P2: una sola firma ─────────────
{
  const acc = await soroban.getAccount(M.publicKey())
  const raw = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(contract.call('transfer', ...transferArgs(M.publicKey(), R.publicKey(), 50)))
    .setTimeout(120)
    .build()
  const tx = await soroban.prepareTransaction(raw)
  tx.sign(A)
  const r = await sendAndWait(tx)
  let enHorizon = false
  await sleep(6000)
  try {
    await horizon.transactions().transaction(r.hash).call()
    enHorizon = true
  } catch {}
  out.P2_una_firma = { ...r, registradaEnLaRed: enHorizon, saldoDestino: await balanceOf(R.publicKey()) }
}

// ───────────── P3: intento inválido que queda registrado ─────────────
// Se simula una llamada válida para obtener los recursos y se envía, con esos mismos
// recursos, una llamada que el contrato rechaza al ejecutarse (monto mayor al saldo).
{
  const acc = await soroban.getAccount(M.publicKey())
  const seq = acc.sequenceNumber()
  const okRaw = new TransactionBuilder(new Account(M.publicKey(), seq), { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(contract.call('transfer', ...transferArgs(M.publicKey(), R.publicKey(), 10)))
    .setTimeout(120)
    .build()
  const sim = await soroban.simulateTransaction(okRaw)
  if (rpc.Api.isSimulationError(sim)) throw new Error('sim: ' + sim.error)

  const args = transferArgs(M.publicKey(), R.publicKey(), 5_000_000)
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(cid).toScAddress(),
          functionName: 'transfer',
          args,
        }),
      ),
      subInvocations: [],
    }),
  })
  const badRaw = new TransactionBuilder(new Account(M.publicKey(), seq), { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(Operation.invokeContractFunction({ contract: cid, function: 'transfer', args, auth: [auth] }))
    .setTimeout(120)
    .build()
  const tx = rpc.assembleTransaction(badRaw, sim).build()
  tx.sign(A, B)
  const r = await sendAndWait(tx)
  let horizonView: unknown = null
  await sleep(6000)
  try {
    const t: any = await horizon.transactions().transaction(r.hash).call()
    horizonView = { successful: t.successful, ledger: t.ledger }
  } catch {
    horizonView = 'no encontrada'
  }
  out.P3_fallo_registrado = { ...r, horizon: horizonView, explorador: `${EXPLORER}/tx/${r.hash}` }
}

// ───────────── P4: la cuenta de 3 firmas no es el origen ─────────────
try {
  const latest = await soroban.getLatestLedger()
  const validUntil = latest.sequence + 200
  const build = async (auth?: xdr.SorobanAuthorizationEntry[]) => {
    const acc = await soroban.getAccount(funder.publicKey())
    const args = transferArgs(M.publicKey(), R.publicKey(), 25)
    return new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASS })
      .addOperation(Operation.invokeContractFunction({ contract: cid, function: 'transfer', args, auth: auth ?? [] }))
      .setTimeout(120)
      .build()
  }
  const sim1 = await soroban.simulateTransaction(await build())
  if (rpc.Api.isSimulationError(sim1)) throw new Error('sim1: ' + sim1.error)
  const entry = sim1.result!.auth[0]
  // Los dos firmantes firman la misma entrada; las firmas van juntas, ordenadas por llave pública.
  const byA = await authorizeEntry(
    entry,
    async (_preimage: unknown, payload: Uint8Array) => {
      const sigs = [A, B]
        .sort((x, y) => Buffer.compare(x.rawPublicKey(), y.rawPublicKey()))
        .map((k) =>
          nativeToScVal(
            { public_key: k.rawPublicKey(), signature: k.sign(Buffer.from(payload)) },
            { type: { public_key: ['symbol', null], signature: ['symbol', null] } },
          ),
        )
      return { signatureScVal: xdr.ScVal.scvVec(sigs), address: M.publicKey() }
    },
    validUntil,
    PASS,
  )
  const raw = await build([byA])
  const tx = await soroban.prepareTransaction(raw)
  tx.sign(funder)
  out.P4_autorizacion_delegada = { ...(await sendAndWait(tx)), saldoDestino: await balanceOf(R.publicKey()) }
} catch (e: any) {
  out.P4_autorizacion_delegada = { error: String(e?.message ?? e).slice(0, 400) }
}

out.enlaces = { cuenta3firmas: `${EXPLORER}/account/${M.publicKey()}`, contrato: `${EXPLORER}/contract/${cid}` }
console.log(JSON.stringify(out, null, 2))
