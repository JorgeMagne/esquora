import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import {
  CIRCLE_USDC_ISSUER,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_FALLBACK_URL,
  SOROBAN_RPC_URL,
  TRUSTLESS_WORK_API_KEY,
  TRUSTLESS_WORK_URL,
} from './config.ts'
import {
  ADDRESSES,
  ChainError,
  USDC_CONTRACT,
  centsToAmount,
  circleTransfers,
  ensureAnchorFunds,
  horizon,
  parseTx,
  signService,
  stroopsToCents,
  submit,
  type AssetTransfer,
} from './stellar.ts'

export { signService }
export type { AssetTransfer }

const rpcServers = [...new Set([SOROBAN_RPC_URL, SOROBAN_RPC_FALLBACK_URL].filter((url): url is string => Boolean(url)))]
  .map((url) => new rpc.Server(url, { timeout: 6_000 }))
const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
const TW_DEPLOYER_CONTRACT = process.env.TW_DEPLOYER_CONTRACT || 'CAZZOSFFNQQSDOLPPGN5BDITMNSLZITXW4S7V5ISM5EAB2THBD7F2AHR'
const TW_FEE_ACCOUNT = process.env.TW_FEE_ACCOUNT || 'GA6KH5VWPCHBOEF63X57SPX6T4H366YFFKKGCVDBTXT2N7JVL6PJCK7G'

async function fromRpc<T>(call: (server: rpc.Server) => Promise<T>): Promise<T> {
  for (const server of rpcServers) {
    try { return await call(server) } catch { /* Fall back to the next Testnet RPC. */ }
  }
  throw new ChainError('La conexión con Stellar se interrumpió. Vuelve a intentarlo.', {}, 503)
}

let apiQueue: Promise<void> = Promise.resolve()
let nextRequest = 0

function reserveRequest(): Promise<void> {
  const turn = apiQueue.then(async () => {
    while (Date.now() < nextRequest) await sleep(nextRequest - Date.now())
    nextRequest = Date.now() + 1_250
  })
  apiQueue = turn.catch(() => {})
  return turn
}

async function trustlessRequest(path: string, body: Record<string, unknown>) {
  if (!TRUSTLESS_WORK_API_KEY) throw new ChainError('Falta configurar el servicio de operaciones.', {}, 503)
  for (let attempt = 0; attempt < 2; attempt++) {
    await reserveRequest()
    const response = await fetch(TRUSTLESS_WORK_URL + path, {
      method: 'POST',
      headers: { 'x-api-key': TRUSTLESS_WORK_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(18_000),
    })
    if (response.status === 429 && attempt === 0) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '60')
      nextRequest = Math.max(nextRequest, Date.now() + (retryAfter > 0 ? Math.min(retryAfter, 65) : 60) * 1_000)
      await response.body?.cancel()
      continue
    }
    const data = await response.json().catch(() => null) as {
      unsignedTransaction?: unknown
      message?: unknown
    } | null
    return { response, data }
  }
  throw new ChainError('Hay demasiadas operaciones en curso. Inténtalo de nuevo en un momento.', {}, 429)
}

function apiError(status: number, message: unknown): ChainError {
  if (status === 429) return new ChainError('Hay demasiadas operaciones en curso. Inténtalo de nuevo en un momento.', {}, 429)
  if (typeof message === 'string' && /required asset|trustline/i.test(message))
    return new ChainError('Una de las cuentas todavía debe habilitar el saldo en dólares de prueba.', {}, 409)
  return new ChainError('Stellar no pudo preparar esta acción. Verifica el estado de la operación e inténtalo de nuevo.', {}, 502)
}

type ExpectedInvocation = {
  contractId: string
  functionName: string
  args: (values: unknown[]) => boolean
  subInvocation?: (invocation: xdr.SorobanAuthorizedInvocation) => boolean
}

function invokesExpectedContract(
  operation: Operation.InvokeHostFunction,
  expected: ExpectedInvocation,
): boolean {
  if (operation.func.type !== 'hostFunctionTypeInvokeContract') return false
  const invocation = operation.func.value
  if (Address.fromScAddress(invocation.contractAddress).toString() !== expected.contractId ||
    invocation.functionName.toString() !== expected.functionName ||
    !expected.args(invocation.args.map(scValToNative))) return false
  const authorization = operation.auth?.[0]
  if (operation.auth?.length !== 1 || !authorization) return false
  const invoked = authorization.rootInvocation.function
  if (authorization.credentials.type !== 'sorobanCredentialsSourceAccount' ||
    invoked.type !== 'sorobanAuthorizedFunctionTypeContractFn' ||
    invoked.value.toXdr('base64') !== invocation.toXdr('base64')) return false
  const nested = authorization.rootInvocation.subInvocations
  return expected.subInvocation ? nested.length === 1 && expected.subInvocation(nested[0]) : nested.length === 0
}

async function build(
  path: string,
  body: Record<string, unknown>,
  expectedSource: string,
  expected: ExpectedInvocation,
): Promise<string> {
  let result: Awaited<ReturnType<typeof trustlessRequest>>
  try {
    result = await trustlessRequest(path, body)
  } catch (error) {
    if (error instanceof ChainError) throw error
    throw new ChainError('El servicio de operaciones tardó demasiado en responder. Inténtalo de nuevo.', {}, 503)
  }
  const unsigned = result.data?.unsignedTransaction
  if (!result.response.ok || typeof unsigned !== 'string')
    throw apiError(result.response.status, result.data?.message)
  let tx
  try {
    tx = parseTx(unsigned)
  } catch {
    throw new ChainError('Stellar devolvió una transacción que no se puede leer.', {}, 502)
  }
  const operation = tx.operations[0]
  if (tx.source !== expectedSource || tx.signatures.length !== 0 || tx.operations.length !== 1 ||
    operation.type !== 'invokeHostFunction' || (operation.source && operation.source !== expectedSource) ||
    !invokesExpectedContract(operation, expected))
    throw new ChainError('La transacción preparada no corresponde a esta cuenta.', {}, 502)
  return unsigned
}

type Deployment = {
  engagementId: string
  title: string
  description: string
  buyer: string
  seller: string
  arbiter: string
  feeBps: number
  tranches: { title: string; amount: number }[]
}

function wholeAmount(cents: number) {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new RangeError('El importe debe ser mayor que cero y estar en centavos.')
  return Number(centsToAmount(cents))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function matchesRecord(value: unknown, fields: Record<string, unknown>): boolean {
  return isRecord(value) && Object.entries(fields).every(([key, expected]) => value[key] === expected)
}

function matchesArray(value: unknown[], expected: unknown[]): boolean {
  return value.length === expected.length && expected.every((item, index) => value[index] === item)
}

function circleAmount(cents: number): bigint {
  return BigInt(cents) * 100_000n
}

function deploymentArgs(input: Deployment, args: unknown[]) {
  const [signer, , , initializer, argumentsList, extra] = args
  if (args.length !== 6 || signer !== ADDRESSES.platform || initializer !== 'initialize_escrow' ||
    !Array.isArray(argumentsList) || argumentsList.length !== 1 || !isRecord(argumentsList[0]) ||
    !Array.isArray(extra) || extra.length !== 0) return false
  const escrow = argumentsList[0]
  return matchesRecord(escrow, {
    engagement_id: input.engagementId, platform_fee: input.feeBps, receiver_memo: 0,
    title: input.title, description: input.description,
  }) && matchesRecord(escrow.roles, {
    approver: input.buyer, dispute_resolver: input.arbiter, platform: ADDRESSES.platform,
    release_signer: input.seller, service_provider: input.seller,
  }) && matchesRecord(escrow.trustline, { address: USDC_CONTRACT }) &&
    Array.isArray(escrow.milestones) && escrow.milestones.length === input.tranches.length &&
    escrow.milestones.every((milestone, index) => isRecord(milestone) &&
      matchesRecord(milestone, {
        amount: circleAmount(input.tranches[index].amount), description: input.tranches[index].title,
        receiver: input.seller, status: 'pending', evidence: '',
      }) && matchesRecord(milestone.flags, { approved: false, disputed: false, released: false, resolved: false }))
}

export function buildDeploy(input: Deployment): Promise<string> {
  return build('/deployer/multi-release', {
    signer: ADDRESSES.platform,
    engagementId: input.engagementId,
    title: input.title,
    description: input.description,
    roles: {
      approver: input.buyer,
      serviceProvider: input.seller,
      platformAddress: ADDRESSES.platform,
      releaseSigner: input.seller,
      disputeResolver: input.arbiter,
    },
    platformFee: input.feeBps / 100,
    milestones: input.tranches.map((tranche) => ({
      description: tranche.title,
      amount: wholeAmount(tranche.amount),
      receiver: input.seller,
    })),
    trustline: { address: CIRCLE_USDC_ISSUER, symbol: 'USDC' },
  }, ADDRESSES.platform, {
    contractId: TW_DEPLOYER_CONTRACT, functionName: 'tw_new_multi_release_escrow',
    args: (values) => deploymentArgs(input, values),
  })
}

const escrowPath = '/escrow/multi-release'

export async function buildFund(contractId: string, cents: number): Promise<string> {
  const amount = wholeAmount(cents)
  await ensureAnchorFunds(cents)
  return build(escrowPath + '/fund-escrow', { contractId, signer: ADDRESSES.anchor, amount }, ADDRESSES.anchor, {
    contractId, functionName: 'fund_escrow',
    args: ([signer, properties, deposit]) => signer === ADDRESSES.anchor && deposit === circleAmount(cents) &&
      isRecord(properties) && matchesRecord(properties.trustline, { address: USDC_CONTRACT }),
    subInvocation: (nested) => {
      const transfer = nested.function
      return transfer.type === 'sorobanAuthorizedFunctionTypeContractFn' && nested.subInvocations.length === 0 &&
        Address.fromScAddress(transfer.value.contractAddress).toString() === USDC_CONTRACT &&
        transfer.value.functionName.toString() === 'transfer' &&
        matchesArray(transfer.value.args.map(scValToNative), [ADDRESSES.anchor, contractId, circleAmount(cents)])
    },
  })
}

export type MilestoneAction = {
  kind: 'evidence' | 'approve' | 'release' | 'dispute' | 'resolve'
  contractId: string
  index: number
  actor: string
  buyer: string
  seller: string
  amount: number
  evidenceDigest?: string
  toBuyer?: number
  toSeller?: number
}

export function buildMilestoneAction(input: MilestoneAction): Promise<string> {
  const { contractId, index, actor } = input
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('La condición indicada no existe.')
  const milestone = { contractId, milestoneIndex: String(index) }
  const request = (endpoint: string, details: Record<string, unknown>, expected: ExpectedInvocation['args']) =>
    build(escrowPath + '/' + endpoint, { ...milestone, ...details }, actor, {
      contractId, functionName: endpoint.replaceAll('-', '_'), args: expected,
    })
  const expect = (...args: unknown[]): ExpectedInvocation['args'] => (values) => matchesArray(values, args)

  switch (input.kind) {
    case 'evidence':
      if (!input.evidenceDigest || !/^[a-f0-9]{64}$/.test(input.evidenceDigest))
        throw new RangeError('La evidencia debe tener una huella SHA-256 válida.')
      const evidence = 'sha256:' + input.evidenceDigest
      return request('change-milestone-status', {
        serviceProvider: actor, newStatus: 'Completed', newEvidence: evidence,
      }, ([entries, provider]) => provider === actor && Array.isArray(entries) && entries.length === 1 &&
        matchesRecord(entries[0], { index, status: 'Completed', evidence }))
    case 'approve':
      return request('approve-milestone', { approver: actor }, expect(index, actor))
    case 'release':
      return request('release-milestone-funds', { releaseSigner: actor }, expect(actor, TW_FEE_ACCOUNT, index))
    case 'dispute':
      return request('dispute-milestone', { signer: actor }, expect(index, actor))
    case 'resolve': {
      const toBuyer = input.toBuyer ?? 0
      const toSeller = input.toSeller ?? 0
      if (!Number.isSafeInteger(toBuyer) || !Number.isSafeInteger(toSeller) || toBuyer < 0 || toSeller < 0 ||
        !Number.isSafeInteger(input.amount) || input.amount <= 0 || toBuyer + toSeller !== input.amount)
        throw new RangeError('El reparto debe cubrir exactamente el importe de la condición.')
      const shares = [
        { address: input.buyer, cents: toBuyer },
        { address: input.seller, cents: toSeller },
      ].filter((share) => share.cents > 0)
      const distributions = shares.map((share) => ({ address: share.address, amount: wholeAmount(share.cents) }))
      const gross = Object.fromEntries(shares.map((share) => [share.address, circleAmount(share.cents)]))
      return request('resolve-milestone-dispute', { disputeResolver: actor, distributions },
        ([resolver, condition, feeAccount, split]) =>
          resolver === actor && condition === index && feeAccount === TW_FEE_ACCOUNT &&
          isRecord(split) && Object.keys(split).length === distributions.length && matchesRecord(split, gross))
    }
  }
}

export function inspectEnvelope(envelope: string, signer?: string) {
  const tx = parseTx(envelope)
  const digest = tx.hash()
  const key = signer ? Keypair.fromPublicKey(signer) : null
  const hint = key ? Buffer.from(key.rawPublicKey()).subarray(28) : null
  const hasSignature = key && hint ? tx.signatures.some((signature) =>
    Buffer.from(signature.hint.toXdrObject()).equals(hint) && key.verify(digest, signature.signature.value)) : false
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0)
  return {
    hash: Buffer.from(digest).toString('hex'),
    source: tx.source,
    signatureCount: tx.signatures.length,
    hasSignature,
    expiresAt: maxTime > 0 ? maxTime * 1_000 : null,
  }
}

export interface ChainReceipt {
  status: 'confirmed' | 'pending' | 'failed'
  contractId?: string
  transfers?: AssetTransfer[]
  error?: string
  ledger?: number
}

const notConfirmed = (): ChainReceipt => ({ status: 'pending' })
const rejected = (ledger?: number): ChainReceipt => ({ status: 'failed', ledger, error: 'Stellar rechazó la transacción.' })

function contractAddress(address: unknown): string | undefined {
  return typeof address === 'string' && StrKey.isValidContract(address) ? address : undefined
}

function decodeContract(returnValue: xdr.ScVal | undefined, events: xdr.ContractEvent[]) {
  const hasInit = events.find((event) => event.body.value.topics.some((topic) => scValToNative(topic) === 'tw_init'))
  if (hasInit?.contractId) return Address.contract(hasInit.contractId.value).toString()

  const value: unknown = returnValue ? scValToNative(returnValue) : undefined
  return contractAddress(Array.isArray(value) ? value[0] : value)
}

function decodeTransfers(events: xdr.ContractEvent[]): AssetTransfer[] {
  return events.flatMap((event) => {
    if (!event.contractId || Address.contract(event.contractId.value).toString() !== USDC_CONTRACT) return []
    const [kind, from, to] = event.body.value.topics.map(scValToNative) as unknown[]
    const amount: unknown = scValToNative(event.body.value.data)
    return kind === 'transfer' && typeof from === 'string' && typeof to === 'string' && typeof amount === 'bigint'
      ? [{ from, to, cents: stroopsToCents(amount), stroops: amount.toString() }]
      : []
  })
}

function eventsFromMeta(meta: xdr.TransactionMeta): xdr.ContractEvent[] {
  if (meta.type === 'v3') return meta.value.sorobanMeta?.events ?? []
  if (meta.type === 'v4') return meta.value.operations.flatMap((operation) => operation.events)
  return []
}

export async function findTransactionInHorizon(hash: string): Promise<ChainReceipt> {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new RangeError('Comprobante de Stellar inválido.')
  try {
    const tx = await horizon.transactions().transaction(hash).call()
    if (!tx.successful) return rejected(tx.ledger_attr)
    const resultMeta = 'result_meta_xdr' in tx && typeof tx.result_meta_xdr === 'string'
      ? xdr.TransactionMeta.fromXdr(tx.result_meta_xdr, 'base64')
      : undefined
    const events = resultMeta ? eventsFromMeta(resultMeta) : []
    const contractId = decodeContract(undefined, events)
    const transfers = decodeTransfers(events)
    if (transfers.length === 0) {
      const page = await horizon.operations().forTransaction(hash).call()
      transfers.push(...page.records.flatMap((record) =>
        record.type === 'invoke_host_function'
          ? circleTransfers(record.asset_balance_changes ?? [])
          : circleTransfers([record])))
    }
    return { status: 'confirmed', ledger: tx.ledger_attr, contractId, transfers }
  } catch {
    return notConfirmed()
  }
}

export async function findTransaction(hash: string): Promise<ChainReceipt> {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new RangeError('Comprobante de Stellar inválido.')
  try {
    const response = await fromRpc((server) => server.getTransaction(hash))
    if (response.status === rpc.Api.GetTransactionStatus.FAILED) return rejected(response.ledger)
    if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const parsedEvents = response.events.contractEventsXdr.flat()
      const events = parsedEvents.length > 0 ? parsedEvents : eventsFromMeta(response.resultMetaXdr)
      const contractId = decodeContract(response.returnValue, events)
      const transfers = decodeTransfers(events)
      return { status: 'confirmed', ledger: response.ledger, contractId, transfers }
    }
  } catch {
    // Horizon conserva transacciones más allá de la retención del RPC.
  }
  return findTransactionInHorizon(hash)
}

export async function submitEnvelope(signedXdr: string): Promise<ChainReceipt> {
  const tx = parseTx(signedXdr)
  const hash = Buffer.from(tx.hash()).toString('hex')
  const soroban = tx.operations.some((operation) => operation.type === 'invokeHostFunction')
  let definiteRejection = false
  try {
    if (soroban) await trustlessRequest('/helper/send-transaction', { signedXdr })
    else await submit(tx)
  } catch (error) {
    if (error instanceof ChainError && error.codes.transaction !== undefined)
      definiteRejection = !['tx_bad_seq', 'tx_duplicate'].includes(error.codes.transaction)
  }

  // A timeout or provider error can arrive after ledger submission.
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await findTransaction(hash)
    if (state.status !== 'pending') return state
    if (definiteRejection) return rejected()
    if (attempt < 4) await sleep(1_100)
  }
  return notConfirmed()
}

async function simulate(
  contractId: string,
  fn: string,
  args: xdr.ScVal[] = [],
  source: string = ADDRESSES.platform,
) {
  return fromRpc(async (server) => {
    // View calls require an existing source, but simulation never consumes its sequence.
    const account = await server.getAccount(source)
    const tx = new TransactionBuilder(new Account(source, account.sequenceNumber()), {
      fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE,
    }).addOperation(Operation.invokeContractFunction({ contract: contractId, function: fn, args }))
      .setTimeout(45).build()
    return server.simulateTransaction(tx)
  })
}

type NativeMilestone = {
  amount: bigint
  description: string
  evidence: string
  receiver: string
  status: string
  flags: { approved: boolean; disputed: boolean; released: boolean; resolved: boolean }
}

type NativeEscrow = {
  title: string
  description: string
  engagement_id: string
  platform_fee: number
  roles: Record<string, string>
  trustline: { address: string }
  milestones: NativeMilestone[]
}

export async function readEscrow(contractId: string) {
  if (!StrKey.isValidContract(contractId)) throw new RangeError('Contrato de Stellar inválido.')
  const [escrowResponse, balanceResponse] = await Promise.all([
    simulate(contractId, 'get_escrow'),
    simulate(USDC_CONTRACT, 'balance', [Address.fromString(contractId).toScVal()]),
  ])
  if (!rpc.Api.isSimulationSuccess(escrowResponse) || !escrowResponse.result ||
    !rpc.Api.isSimulationSuccess(balanceResponse) || !balanceResponse.result)
    throw new ChainError('Todavía no se pudo verificar el saldo del contrato en Stellar.', {}, 503)
  const escrow = scValToNative(escrowResponse.result.retval) as NativeEscrow
  const balance: unknown = scValToNative(balanceResponse.result.retval)
  if (typeof balance !== 'bigint' || !Array.isArray(escrow.milestones) || escrow.trustline?.address !== USDC_CONTRACT)
    throw new ChainError('Este contrato no contiene el activo esperado.', {}, 502)

  return {
    held: stroopsToCents(balance),
    heldStroops: balance.toString(),
    ledger: Math.min(escrowResponse.latestLedger, balanceResponse.latestLedger),
    title: escrow.title,
    description: escrow.description,
    engagementId: escrow.engagement_id,
    platformFeeBps: escrow.platform_fee,
    assetContractId: escrow.trustline.address,
    roles: escrow.roles,
    milestones: escrow.milestones.map((milestone) => ({
      ...milestone.flags,
      status: milestone.status,
      amount: stroopsToCents(milestone.amount),
      evidence: milestone.evidence,
      receiver: milestone.receiver,
    })),
  }
}

export interface EscrowSettlement {
  kind: 'release' | 'resolve'
  index: number
  hash: string
  ledger: number
  transfers: AssetTransfer[]
}

// A protection proof never authorizes a ledger write, even if its business state changes.
const proofMaxFee = 900_000n

function isReadOnlyProof(tx: ReturnType<typeof parseTx>): boolean {
  const envelope = tx.toEnvelope()
  const op = tx.operations[0]
  if (envelope.type !== 'envelopeTypeTx' || tx.operations.length !== 1 ||
    op.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract' ||
    !['release_milestone_funds', 'withdraw_remaining_funds'].includes(op.func.value.functionName.toString())) return false
  const ext = envelope.value.tx.ext
  return ext.type === 'sorobanData' && ext.value.resources.footprint.readWrite.length === 0 &&
    ext.value.resources.writeBytes === 0 && BigInt(tx.fee) <= proofMaxFee
}

async function prepareReadOnlyProof(contractId: string, actor: string, fn: string, args: xdr.ScVal[]) {
  const views = [simulate(contractId, 'get_escrow')]
  if (fn === 'withdraw_remaining_funds')
    views.push(simulate(USDC_CONTRACT, 'balance', [Address.fromString(contractId).toScVal()]))
  const readable = new Map<string, xdr.LedgerKey>()
  let instructions = 0
  let diskReadBytes = 0
  for (const view of await Promise.all(views)) {
    if (!rpc.Api.isSimulationSuccess(view) || rpc.Api.isSimulationRestore(view)) return undefined
    const { transactionData } = view
    for (const entry of [...transactionData.getReadOnly(), ...transactionData.getReadWrite()])
      readable.set(entry.toXdr('base64'), entry)
    const resources = transactionData.build().resources
    instructions += resources.instructions
    diskReadBytes += resources.diskReadBytes
  }
  const data = new SorobanDataBuilder()
    .setFootprint([...readable.values()], [])
    .setResources(Math.min(instructions * 3 + 100_000, 30_000_000), diskReadBytes, 0)
    .setResourceFee(proofMaxFee - 1_000n)
    .build()
  const account = await fromRpc((server) => server.getAccount(actor))
  const invocation = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(contractId).toScAddress(), functionName: fn, args,
  })
  const authorization = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invocation),
      subInvocations: [],
    }),
  })
  const tx = new TransactionBuilder(account, { fee: '1000', networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({ contract: contractId, function: fn, args, auth: [authorization] }))
    .setSorobanData(data)
    .setTimeout(100)
    .build()
  return isReadOnlyProof(tx) ? tx.toXDR() : undefined
}

export async function submitProbeEnvelope(signedXdr: string): Promise<ChainReceipt> {
  const tx = parseTx(signedXdr)
  if (!isReadOnlyProof(tx) || !inspectEnvelope(signedXdr, tx.source).hasSignature)
    throw new ChainError('La prueba requiere una transacción de solo lectura firmada por tu cuenta.', {}, 400)
  const hash = Buffer.from(tx.hash()).toString('hex')
  try {
    const sent = await fromRpc((server) => server.sendTransaction(tx))
    if (sent.status === 'ERROR') {
      const recorded = await findTransaction(hash)
      return recorded.status === 'pending' ? rejected() : recorded
    }
  } catch {
    // A timeout can arrive after the proof was accepted for submission.
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await findTransaction(hash)
    if (state.status !== 'pending') return state
    if (attempt < 4) await sleep(1_100)
  }
  return notConfirmed()
}

export async function readEscrowHistory(contractId: string, sinceLedger?: number): Promise<EscrowSettlement[]> {
  if (!StrKey.isValidContract(contractId)) throw new RangeError('Contrato de Stellar inválido.')
  if (sinceLedger !== undefined && (!Number.isSafeInteger(sinceLedger) || sinceLedger < 1))
    throw new RangeError('Versión del registro inválida.')
  return fromRpc(async (server) => {
    const health = await server.getHealth()
    const startLedger = Math.max(health.oldestLedger, sinceLedger ?? health.oldestLedger)
    if (startLedger > health.latestLedger) return []

    const filters = ['tw_release', 'tw_disp_resolve'].map((name): rpc.Api.EventFilter => ({
      type: 'contract',
      contractIds: [contractId],
      topics: [[nativeToScVal(name, { type: 'symbol' }).toXdr('base64')]],
    }))
    const page = await server.getEvents({ filters, startLedger, limit: 100 })
    const settlements = await Promise.all(page.events.map(async (event): Promise<EscrowSettlement | null> => {
      const receipt = await server.getTransaction(event.txHash)
      if (receipt.status !== rpc.Api.GetTransactionStatus.SUCCESS) return null
      const topic = scValToNative(event.topic[0])
      const release = topic === 'tw_release'
      const tx = TransactionBuilder.fromXDR(receipt.envelopeXdr, NETWORK_PASSPHRASE)
      const instructions = 'innerTransaction' in tx ? tx.innerTransaction.operations : tx.operations
      const invoke = instructions.find((op) => {
        if (op.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract') return false
        const name = op.func.value.functionName.toString()
        return name === (release ? 'release_milestone_funds' : 'resolve_milestone_dispute') &&
          Address.fromScAddress(op.func.value.contractAddress).toString() === contractId
      })
      if (invoke?.type !== 'invokeHostFunction' || invoke.func.type !== 'hostFunctionTypeInvokeContract') return null
      const index: unknown = scValToNative(invoke.func.value.args[release ? 2 : 1])
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return null
      return {
        kind: release ? 'release' : 'resolve',
        index,
        hash: event.txHash,
        ledger: event.ledger,
        transfers: decodeTransfers(receipt.events.contractEventsXdr.flat()).filter((transfer) => transfer.from === contractId),
      }
    }))
    return settlements.filter((settlement): settlement is EscrowSettlement => settlement !== null)
  })
}

export async function buildProbe(input: {
  contractId: string
  actor: string
  role: 'buyer' | 'seller'
  index: number
  ledger?: boolean
}): Promise<{ xdr?: string; rejected?: boolean; reason?: string }> {
  const { contractId, actor, role, index } = input
  const escrow = await readEscrow(contractId)
  const milestone = escrow.milestones[index]
  if (!milestone || escrow.held <= 0 || milestone.released || milestone.resolved ||
    actor !== escrow.roles[role === 'seller' ? 'release_signer' : 'approver'] ||
    (role === 'seller' && (milestone.approved || milestone.disputed)))
    return { reason: 'La prueba requiere una condición con dinero protegido que aún no se pueda cobrar.' }

  const requester = Address.fromString(actor).toScVal()
  const fee = Address.fromString(TW_FEE_ACCOUNT).toScVal()
  const fn = role === 'seller' ? 'release_milestone_funds' : 'withdraw_remaining_funds'
  const args = role === 'seller'
    ? [requester, fee, xdr.ScVal.scvU32(index)]
    : [
      requester, fee, xdr.ScVal.scvMap([new xdr.ScMapEntry({
        key: requester, val: nativeToScVal(BigInt(escrow.heldStroops), { type: 'i128' }),
      })]),
    ]
  const result = await simulate(contractId, fn, args, actor)
  if (rpc.Api.isSimulationError(result)) {
    const expected = role === 'seller' ? '#29' : '#37'
    if (result.error.includes('Error(Contract, ' + expected + ')')) {
      const prepared = input.ledger ? await prepareReadOnlyProof(contractId, actor, fn, args).catch(() => undefined) : undefined
      return {
        xdr: prepared,
        rejected: true,
        reason: role === 'seller'
          ? 'Stellar rechazó la simulación: la condición todavía requiere confirmación del comprador.'
          : 'Stellar rechazó la simulación: la cuenta del comprador no puede retirar el dinero protegido por su cuenta.',
      }
    }
  }
  return { reason: 'No se pudo verificar el rechazo esperado en Stellar. El dinero protegido no se movió.' }
}
