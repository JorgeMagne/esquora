import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Account, Address, Asset, Keypair, Networks, Operation, TransactionBuilder, nativeToScVal, xdr } from '@stellar/stellar-sdk'

const dataDir = await mkdtemp(join(tmpdir(), 'esquora-resolution-test-'))
const fixtureToken = 'esquora-resolution-tests-only-local-access'
const noNetwork = 'https://127.0.0.1:1'
const feeAccount = Keypair.random().publicKey()
process.env.DATA_DIR = dataDir
process.env.NODE_ENV = 'test'
process.env.ESQUORA_TEST_AUTH_TOKEN = fixtureToken
process.env.APP_URL = 'http://127.0.0.1:8787'
process.env.HORIZON_URL = noNetwork
process.env.SOROBAN_RPC_URL = noNetwork
process.env.SOROBAN_RPC_FALLBACK_URL = noNetwork
process.env.TRUSTLESS_WORK_API_URL = noNetwork
process.env.TRUSTLESS_WORK_API_KEY = fixtureToken
process.env.TW_FEE_ACCOUNT = feeAccount

const { app } = await import('../server/app.ts')
const { db } = await import('../server/db.ts')

after(async () => {
  db.close()
  await rm(dataDir, { recursive: true, force: true, maxRetries: 3 })
})

type Participant = { id: string; cookie: string; key: Keypair; email: string }
type Instruction = {
  id: string; digest: string; kind: string; toBuyer: number; toSeller: number
  buyerSigned: boolean; sellerSigned: boolean; verifiedAt: string | null
  verificationNote: string | null; file: { id: string } | null
}

function request(path: string, actor?: Participant, body?: Record<string, unknown> | FormData) {
  return app.request(path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(actor ? { Cookie: actor.cookie } : { Authorization: `Bearer ${fixtureToken}` }),
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  })
}

async function expected(response: Response, status: number) {
  assert.equal(response.status, status, await response.clone().text())
}

async function account(alias: string, kind: 'buyer' | 'developer' | 'arbiter'): Promise<Participant> {
  const key = Keypair.random()
  const email = `${alias}@example.test`
  const response = await request('/api/auth/test', undefined, { name: alias, email, publicKey: key.publicKey() })
  await expected(response, 200)
  const cookie = response.headers.get('Set-Cookie')?.split(';')[0]
  assert.ok(cookie)
  const user = db.prepare("UPDATE users SET kind = ?, wallet_status = 'active' WHERE email = ? RETURNING id").get(kind, email)
  assert.ok(typeof user?.id === 'string')
  return { id: user.id, cookie, key, email }
}

async function disputed(alias: string) {
  const buyer = await account(`${alias}-buyer`, 'buyer')
  const seller = await account(`${alias}-seller`, 'developer')
  const reviewer = await account(`${alias}-reviewer`, 'arbiter')
  const opId = `${alias}-op`
  const trancheId = `${alias}-tranche`
  const contract = new Asset('USDC', seller.key.publicKey()).contractId(Networks.TESTNET)
  const timestamp = new Date().toISOString()
  db.prepare('INSERT INTO projects (id,owner_id,name,city,address,created_at) VALUES (?,?,?,?,?,?)')
    .run(alias, seller.id, 'Proyecto de prueba', 'Santa Cruz', 'Av. de prueba', timestamp)
  db.prepare(`INSERT INTO operations (id,code,project_id,seller_id,buyer_id,buyer_email,buyer_name,arbiter_id,
    resolution_mode,unit,price,deposit,fee_bps,refund_response_hours,terms_json,terms_digest,
    invite_token,status,escrow_contract_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,'esquora','A-1',50000,10000,90,72,'{}',?,?,'funded',?,?)`)
    .run(opId, `ESQ-${alias}`, alias, seller.id, buyer.id, buyer.email, alias, reviewer.id, 'a'.repeat(64), `${alias}-invite`, contract, timestamp)
  db.prepare(`INSERT INTO tranches (id,op_id,idx,title,condition,requirements_json,amount,due_at,status)
    VALUES (?,?,0,'Cimentación','Acta de obra','[]',10000,?,'disputed')`).run(trancheId, opId, timestamp)
  return {
    buyer, seller, reviewer, contract, trancheId,
    instructionPath: `/api/tranches/${trancheId}/resolution-instruction`,
    arm: (instructionId?: string) => request('/api/acciones', reviewer, {
      kind: 'resolve', trancheId, instructionId, toBuyer: 10_000, toSeller: 0,
    }),
  }
}

async function instruction(response: Response): Promise<Instruction> {
  await expected(response, 200)
  const result = await response.json() as { instruction: Instruction | null }
  assert.ok(result.instruction)
  return result.instruction
}

function sign(actor: Participant, digest: string) {
  return Buffer.from(actor.key.sign(createHash('sha256').update(`Stellar Signed Message:\nesquora:acuerdo:sha256:${digest}`).digest()))
    .toString('base64')
}

function fixtureEnvelope(fixture: Awaited<ReturnType<typeof disputed>>) {
  const resolver = fixture.reviewer.key.publicKey()
  const splits = [{ actor: fixture.buyer, amount: 300_000_000n }, { actor: fixture.seller, amount: 700_000_000n }]
  const args = [
    Address.fromString(resolver).toScVal(),
    xdr.ScVal.scvU32(0),
    Address.fromString(feeAccount).toScVal(),
    xdr.ScVal.scvMap(splits.map(({ actor, amount }) => new xdr.ScMapEntry({
      key: Address.fromString(actor.key.publicKey()).toScVal(), val: nativeToScVal(amount, { type: 'i128' }),
    }))),
  ]
  const operation = {
    contract: fixture.contract, function: 'resolve_milestone_dispute', args,
  }
  const invoked = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(operation.contract).toScAddress(), functionName: operation.function, args,
  })
  const authorization = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invoked), subInvocations: [],
    }),
  })
  return new TransactionBuilder(new Account(resolver, '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ ...operation, auth: [authorization] })).setTimeout(60).build()
}

test('ESQUORA ejecuta el reparto exacto firmado por ambas partes, verificado y vigente', async (t) => {
  const fixture = await disputed('mutual')
  const { buyer, seller, reviewer, instructionPath, arm } = fixture
  await expected(await arm(), 409)
  const proposed = await instruction(await request(instructionPath, buyer, {
    action: 'submit', kind: 'mutual', toBuyer: 3000, explanation: 'Acuerdo parcial para el tramo.',
  }))
  assert.deepEqual([proposed.toBuyer, proposed.toSeller, proposed.buyerSigned, proposed.sellerSigned], [3000, 7000, false, false])
  const verify = { action: 'verify', instructionId: proposed.id, attested: true, note: 'Se verificaron partes, tramo y reparto.' }
  await expected(await request(instructionPath, reviewer, verify), 409)
  const buyerSignature = sign(buyer, proposed.digest)
  const signedByBuyer = await instruction(await request(instructionPath, buyer, {
    action: 'sign', instructionId: proposed.id, signature: buyerSignature,
  }))
  assert.equal(signedByBuyer.buyerSigned, true)
  assert.equal(signedByBuyer.sellerSigned, false)
  await expected(await request(instructionPath, seller, {
    action: 'sign', instructionId: proposed.id, signature: buyerSignature,
  }), 400)
  await expected(await request(instructionPath, reviewer, verify), 409)
  const signedByBoth = await instruction(await request(instructionPath, seller, {
    action: 'sign', instructionId: proposed.id, signature: sign(seller, proposed.digest),
  }))
  assert.equal(signedByBoth.sellerSigned, true)
  await expected(await request(instructionPath, buyer, verify), 409)
  await expected(await request(instructionPath, reviewer, { ...verify, attested: false }), 409)
  const verified = await instruction(await request(instructionPath, reviewer, verify))
  assert.ok(verified.verifiedAt)
  assert.equal(verified.verificationNote, verify.note)
  await expected(await arm('instruccion-distinta'), 409)

  const transaction = fixtureEnvelope(fixture)
  const prepared = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).pathname.endsWith('/resolve-milestone-dispute'), true)
    assert.deepEqual(JSON.parse(String(init.body)).distributions, [
      { address: buyer.key.publicKey(), amount: 30 }, { address: seller.key.publicKey(), amount: 70 },
    ])
    return Response.json({ unsignedTransaction: transaction.toXDR() })
  })
  const armResponse = await arm(verified.id)
  await expected(armResponse, 200)
  const armed = await armResponse.json() as { id: string; status: string }
  assert.equal(armed.status, 'armed')
  assert.equal(prepared.mock.callCount(), 1)
  const objection = await request(instructionPath, seller, {
    action: 'object', instructionId: verified.id, note: 'El acuerdo ya no refleja la corrección solicitada.',
  })
  await expected(objection, 200)
  const objected = await objection.json()
  assert.equal(objected.instruction, null)
  assert.equal(objected.objection.reason, 'El acuerdo ya no refleja la corrección solicitada.')
  await expected(await arm(verified.id), 409)
  transaction.sign(reviewer.key)
  const rejected = await request(`/api/acciones/${armed.id}/enviar`, reviewer, { signedXdr: transaction.toXDR() })
  await expected(rejected, 200)
  assert.equal((await rejected.json()).status, 'failed')
  assert.equal(prepared.mock.callCount(), 1)
})

test('una resolución externa exige el archivo propio y una revisión verificable antes de preparar la firma', async () => {
  const { buyer, seller, reviewer, instructionPath, arm } = await disputed('external')
  const outsider = await account('external-outsider', 'arbiter')
  const body = { action: 'submit', kind: 'external', toBuyer: 8000, explanation: 'Acta de conciliación 13.',
    authorityReference: 'Designación suscrita por ambas partes en la página 2.' }
  await expected(await request(instructionPath, buyer, body), 400)
  const attachment = new FormData()
  attachment.append('file', new File(['%PDF-1.7\nActa de prueba'], 'acta.pdf', { type: 'application/pdf' }))
  const uploaded = await request('/api/files', seller, attachment)
  await expected(uploaded, 200)
  const { id: fileId } = await uploaded.json() as { id: string }
  await expected(await request(instructionPath, buyer, { ...body, fileId }), 400)
  await expected(await request(instructionPath, seller, { ...body, fileId, authorityReference: '' }), 400)
  const proposed = await instruction(await request(instructionPath, seller, { ...body, fileId }))
  assert.equal(proposed.file?.id, fileId)
  await expected(await request(`/api/files/${fileId}`, outsider), 404)
  await expected(await request(`/api/files/${fileId}`, buyer), 200)
  await expected(await request(`/api/files/${fileId}`, reviewer), 200)
  await expected(await arm(proposed.id), 409)
  const verify = { action: 'verify', instructionId: proposed.id, attested: true, note: 'Verificado con el emisor del acta.' }
  await expected(await request(instructionPath, outsider, verify), 404)
  const verified = await instruction(await request(instructionPath, reviewer, verify))
  assert.equal(verified.buyerSigned, false)
  assert.equal(verified.sellerSigned, false)
  assert.ok(verified.verifiedAt)
  const objection = await request(instructionPath, buyer, {
    action: 'object', instructionId: proposed.id, note: 'El centro notificó una revisión del acta.',
  })
  await expected(objection, 200)
  const rejectedCase = await objection.json()
  assert.equal(rejectedCase.instruction, null)
  assert.equal(rejectedCase.objection.reason, 'El centro notificó una revisión del acta.')
  await expected(await arm(proposed.id), 409)
  const replacement = await instruction(await request(instructionPath, seller, { ...body, fileId, explanation: 'Acta corregida.' }))
  const replacementReview = { ...verify, instructionId: replacement.id }
  await expected(await request(instructionPath, reviewer, replacementReview), 409)
  const cleared = await instruction(await request(instructionPath, reviewer, {
    ...replacementReview, objectionId: rejectedCase.objection.id, objectionClarification: 'La revisión posterior confirmó el reparto.',
  }))
  assert.match(cleared.verificationNote ?? '', /La revisión posterior confirmó el reparto/)
})
