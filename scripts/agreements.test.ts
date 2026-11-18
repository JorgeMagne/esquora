import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
import { Keypair } from '@stellar/stellar-sdk'

const dataDir = await mkdtemp(join(tmpdir(), 'esquora-agreement-test-'))
const fixtureToken = 'esquora-agreement-tests-only-local-access'
const teamEmail = 'team-reviewer@example.test'
const noNetwork = 'https://127.0.0.1:1'
process.env.DATA_DIR = dataDir
process.env.NODE_ENV = 'test'
process.env.ESQUORA_TEST_AUTH_TOKEN = fixtureToken
process.env.ESQUORA_RESOLVER_EMAIL = teamEmail
process.env.APP_URL = 'http://127.0.0.1:8787'
process.env.HORIZON_URL = noNetwork
process.env.SOROBAN_RPC_URL = noNetwork
process.env.SOROBAN_RPC_FALLBACK_URL = noNetwork
process.env.TRUSTLESS_WORK_API_URL = noNetwork
process.env.TRUSTLESS_WORK_API_KEY = fixtureToken

const { app } = await import('../server/app.ts')
const { db } = await import('../server/db.ts')

after(async () => {
  db.close()
  await rm(dataDir, { recursive: true, force: true, maxRetries: 3 })
})

type AccountKind = 'developer' | 'buyer' | 'arbiter'
type Operation = {
  id: string
  status: string
  terms: string
  termsDigest: string
  sellerSig: string | null
  buyerSig: string | null
  resolutionMode: string
  resolutionTerms: { version: string; title: string; clauses: string[] } | null
  resolverReady: boolean
  arbiter: { id: string; publicKey: string } | null
  arbiterEmail: string | null
  arbiterInviteToken: string | null
  inviteToken: string | null
  contract: unknown
  contractSha256: string | null
  tranches: { title: string; condition: string; amount: number; requirements: { key: string; label: string }[] }[]
}

function request(path: string, { method = 'GET', body, cookie, authorize = false }: {
  method?: string; body?: unknown; cookie?: string; authorize?: boolean
} = {}) {
  return app.request(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(authorize ? { Authorization: `Bearer ${fixtureToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function json<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status, await response.clone().text())
  return response.json() as Promise<T>
}

async function account(email: string, kind: AccountKind, active = true) {
  const key = Keypair.random()
  const name = email.split('@')[0]
  const authenticated = await request('/api/auth/test', {
    method: 'POST', body: { email, name, publicKey: key.publicKey() }, authorize: true,
  })
  assert.equal(authenticated.status, 200, await authenticated.clone().text())
  const cookie = authenticated.headers.get('Set-Cookie')?.split(';')[0]
  assert.ok(cookie)
  const profile = await request('/api/me', {
    method: 'PATCH', cookie, body: { kind, name, orgName: 'Institución de prueba', orgNit: '123456' },
  })
  const { user } = await json<{ user: { id: string } }>(profile)
  if (active) {
    db.prepare("UPDATE users SET wallet_status = 'active' WHERE id = ?").run(user.id)
  }
  return { key, cookie, email, id: user.id }
}

async function project(alias: string) {
  const seller = await account(`${alias}-seller@example.test`, 'developer')
  const response = await request('/api/projects', {
    method: 'POST', cookie: seller.cookie, body: { name: 'Proyecto prueba', city: 'Santa Cruz', address: 'Av. de prueba' },
  })
  const { id } = await json<{ id: string }>(response)
  return { seller, id }
}

function draftPayload(projectId: string, buyerEmail: string, count = 1) {
  const dueAt = new Date(Date.now() + 86_400_000).toISOString()
  const tranches = Array.from({ length: count }, (_, index) => {
    const number = index + 1
    return {
      title: `Inspección ${number}`,
      condition: `Adjuntar informe de la inspección ${number}`,
      amount: number * 1000,
      dueAt,
      requirements: [{ key: `informe_${number}`, label: `Informe ${number}` }],
    }
  })
  return {
    projectId, buyerEmail, buyerName: 'Compradora de prueba', unit: 'A-4',
    price: 200_000, deposit: tranches.reduce((sum, tranche) => sum + tranche.amount, 0), tranches,
  }
}

function sign(key: Keypair, termsDigest: string) {
  const digest = createHash('sha256').update(`Stellar Signed Message:\nesquora:acuerdo:sha256:${termsDigest}`).digest()
  return Buffer.from(key.sign(digest)).toString('base64')
}

test('guarda siete tramos personalizados sin adjunto ni tercero y reserva la firma hasta que haya resolutor', async () => {
  const { seller, id } = await project('pending')
  const body = { ...draftPayload(id, 'pending-buyer@example.test', 7), resolutionMode: 'pending' }
  const draft = await json<Operation>(await request('/api/ops', { method: 'POST', cookie: seller.cookie, body }))

  assert.equal(draft.status, 'draft')
  assert.equal(draft.resolutionMode, 'pending')
  assert.equal(draft.contract, null)
  assert.equal(draft.contractSha256, null)
  assert.equal(draft.arbiter, null)
  assert.equal(draft.resolverReady, false)
  assert.deepEqual(draft.tranches.map(({ amount }) => amount), [1000, 2000, 3000, 4000, 5000, 6000, 7000])
  assert.equal(draft.tranches[6].title, 'Inspección 7')
  assert.equal(draft.tranches[6].condition, 'Adjuntar informe de la inspección 7')
  assert.deepEqual(draft.tranches[6].requirements, [{ key: 'informe_7', label: 'Informe 7' }])

  const blockedSend = await request(`/api/ops/${draft.id}/send`, {
    method: 'POST', cookie: seller.cookie, body: { signature: sign(seller.key, draft.termsDigest) },
  })
  assert.equal(blockedSend.status, 409, await blockedSend.clone().text())
  const current = await json<Operation>(await request(`/api/ops/${draft.id}`, { cookie: seller.cookie }))
  assert.equal(current.status, 'draft')
  assert.equal(current.sellerSig, null)
})

test('rechaza un octavo tramo y un reparto que no suma la cuota', async () => {
  const { seller, id } = await project('boundaries')
  const buyerEmail = 'boundaries-buyer@example.test'
  const seven = draftPayload(id, buyerEmail, 7)
  for (const draft of [{ ...seven, deposit: 27_999 }, draftPayload(id, buyerEmail, 8)]) {
    const response = await request('/api/ops', {
      method: 'POST', cookie: seller.cookie, body: { ...draft, resolutionMode: 'pending' },
    })
    assert.equal(response.status, 400, await response.clone().text())
  }
})

test('la invitación se reclama con el correo exacto y una cuenta activa y actualiza el acuerdo que se firma', async () => {
  const { seller, id } = await project('external')
  const buyer = await account('external-buyer@example.test', 'buyer')
  const target = 'external-resolver@example.test'
  const draft = await json<Operation>(await request('/api/ops', {
    method: 'POST', cookie: seller.cookie, body: { ...draftPayload(id, buyer.email), resolutionMode: 'pending' },
  }))
  const op = `/api/ops/${draft.id}`
  const nominate = { method: 'PATCH', body: { resolutionMode: 'external', arbiterEmail: target } }
  const deniedChange = await request(`${op}/resolver`, { ...nominate, cookie: buyer.cookie })
  assert.ok([403, 404].includes(deniedChange.status), await deniedChange.clone().text())
  const nominated = await json<Operation>(await request(`${op}/resolver`, { ...nominate, cookie: seller.cookie }))
  assert.equal(nominated.resolutionMode, 'external')
  assert.equal(nominated.resolverReady, false)
  assert.equal(nominated.arbiterEmail, target)
  assert.ok(nominated.arbiterInviteToken)
  const previousSignature = sign(seller.key, nominated.termsDigest)
  const waitingForThird = await request(`${op}/send`, { method: 'POST', cookie: seller.cookie, body: { signature: previousSignature } })
  assert.equal(waitingForThird.status, 409)
  const invite = `/api/resolver-invitations/${nominated.arbiterInviteToken}`
  const invitation = await json<{ status: string; mine: boolean }>(await request(invite))
  assert.deepEqual(invitation, { mine: false })

  const unrelated = await account('external-unrelated@example.test', 'arbiter')
  assert.deepEqual(await json(await request(invite, { cookie: unrelated.cookie })), { mine: false })
  const outsider = await request(`${invite}/claim`, { method: 'POST', cookie: unrelated.cookie, body: {} })
  assert.ok([403, 404].includes(outsider.status), await outsider.clone().text())
  const arbiter = await account(target, 'arbiter', false)
  const matched = await json<{ status: string; mine: boolean }>(await request(invite, { cookie: arbiter.cookie }))
  assert.equal(matched.status, 'pending')
  assert.equal(matched.mine, true)
  const claim = { method: 'POST', cookie: arbiter.cookie, body: {} }
  const inactive = await request(`${invite}/claim`, claim)
  assert.equal(inactive.status, 409, await inactive.clone().text())
  db.prepare("UPDATE users SET wallet_status = 'active' WHERE id = ?").run(arbiter.id)
  await json(await request(`${invite}/claim`, claim))

  const ready = await json<Operation>(await request(op, { cookie: seller.cookie }))
  assert.equal(ready.resolverReady, true)
  assert.equal(ready.arbiter?.id, arbiter.id)
  assert.equal(ready.arbiter?.publicKey, arbiter.key.publicKey())
  assert.notEqual(ready.termsDigest, nominated.termsDigest)
  assert.equal(JSON.parse(ready.terms).terceroDesignado.cuenta, arbiter.key.publicKey())
  const stale = await request(`${op}/send`, { method: 'POST', cookie: seller.cookie, body: { signature: previousSignature } })
  assert.equal(stale.status, 400, await stale.clone().text())
  const signature = sign(seller.key, ready.termsDigest)
  const sent = await json<Operation>(await request(`${op}/send`, { method: 'POST', cookie: seller.cookie, body: { signature } }))
  assert.equal(sent.status, 'invited')
  assert.equal(sent.sellerSig, signature)
  const amendment = await request(`${op}/resolver`, {
    method: 'PATCH', cookie: seller.cookie, body: { resolutionMode: 'pending' },
  })
  assert.equal(amendment.status, 409, await amendment.clone().text())
  const intact = await json<Operation>(await request(op, { cookie: seller.cookie }))
  assert.equal(intact.termsDigest, ready.termsDigest)
  assert.equal(intact.sellerSig, signature)
})

test('la firma de cada parte en modalidad ESQUORA requiere una cuenta operativa y consentimiento explícito', async () => {
  const { seller, id } = await project('mandate')
  const buyer = await account('mandate-buyer@example.test', 'buyer')
  const pending = await json<Operation>(await request('/api/ops', {
    method: 'POST', cookie: seller.cookie, body: { ...draftPayload(id, buyer.email), resolutionMode: 'esquora' },
  }))
  const op = `/api/ops/${pending.id}`
  assert.equal(pending.resolverReady, false)
  const noReviewer = await request(`${op}/send`, {
    method: 'POST', cookie: seller.cookie, body: { signature: sign(seller.key, pending.termsDigest), resolutionConsent: true },
  })
  assert.equal(noReviewer.status, 409, await noReviewer.clone().text())
  const team = await account(teamEmail, 'arbiter')
  const draft = await json<Operation>(await request(`${op}/resolver`, {
    method: 'PATCH', cookie: seller.cookie, body: { resolutionMode: 'esquora' },
  }))

  assert.equal(draft.resolverReady, true)
  assert.equal(draft.arbiter?.id, team.id)
  assert.ok(draft.resolutionTerms?.version)
  assert.ok(draft.resolutionTerms.clauses.length > 0)
  assert.deepEqual(JSON.parse(draft.terms).resolucionEsquora, draft.resolutionTerms)
  assert.equal(createHash('sha256').update(draft.terms).digest('hex'), draft.termsDigest)

  const sellerSignature = sign(seller.key, draft.termsDigest)
  const withoutSellerConsent = await request(`${op}/send`, {
    method: 'POST', cookie: seller.cookie, body: { signature: sellerSignature },
  })
  assert.equal(withoutSellerConsent.status, 400, await withoutSellerConsent.clone().text())
  const sent = await json<Operation>(await request(`${op}/send`, {
    method: 'POST', cookie: seller.cookie, body: { signature: sellerSignature, resolutionConsent: true },
  }))
  assert.ok(sent.inviteToken)
  await json(await request(`/api/invitations/${sent.inviteToken}/claim`, { method: 'POST', cookie: buyer.cookie, body: {} }))
  const buyerSignature = sign(buyer.key, sent.termsDigest)
  for (const body of [{ signature: buyerSignature }, { signature: buyerSignature, resolutionConsent: 'true' }]) {
    const withoutBuyerConsent = await request(`${op}/accept`, { method: 'POST', cookie: buyer.cookie, body })
    assert.equal(withoutBuyerConsent.status, 400, await withoutBuyerConsent.clone().text())
  }
  const stillInvited = await json<Operation>(await request(op, { cookie: buyer.cookie }))
  assert.equal(stillInvited.status, 'invited')
  assert.equal(stillInvited.buyerSig, null)
  assert.deepEqual(stillInvited.resolutionTerms, draft.resolutionTerms)
})

test('migra acuerdos ya firmados con sus tramos y conserva el documento, las firmas y la huella', async () => {
  const legacyDir = join(dataDir, 'legacy')
  await mkdir(legacyDir)
  const legacyDbPath = join(legacyDir, 'esquora.db')
  const legacy = new DatabaseSync(legacyDbPath)
  const terms = '{"version":1,"operacion":"ESQ-HISTORICO","tramos":[{"monto":"25.00"}]}'
  const termsDigest = createHash('sha256').update(terms).digest('hex')
  const sellerSig = sign(Keypair.random(), termsDigest)
  const buyerSig = sign(Keypair.random(), termsDigest)
  try {
    legacy.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE files (id TEXT PRIMARY KEY);
      CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        seller_id TEXT NOT NULL REFERENCES users(id),
        buyer_id TEXT REFERENCES users(id),
        buyer_email TEXT NOT NULL,
        buyer_name TEXT NOT NULL,
        arbiter_id TEXT NOT NULL REFERENCES users(id),
        unit TEXT NOT NULL,
        price INTEGER NOT NULL,
        deposit INTEGER NOT NULL,
        fee_bps INTEGER NOT NULL,
        refund_response_hours REAL NOT NULL,
        contract_file_id TEXT NOT NULL REFERENCES files(id),
        contract_sha256 TEXT NOT NULL,
        terms_json TEXT NOT NULL,
        terms_digest TEXT NOT NULL,
        seller_sig TEXT,
        buyer_sig TEXT,
        invite_token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        escrow_contract_id TEXT UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX legacy_terms_digest ON operations(terms_digest);
      CREATE TABLE tranches (id TEXT PRIMARY KEY, op_id TEXT NOT NULL REFERENCES operations(id), amount INTEGER NOT NULL);
      INSERT INTO users (id) VALUES ('old-seller'), ('old-buyer'), ('old-arbiter');
      INSERT INTO projects (id) VALUES ('old-project');
      INSERT INTO files (id) VALUES ('old-contract');
    `)
    legacy.prepare(`INSERT INTO operations (id,code,project_id,seller_id,buyer_id,buyer_email,buyer_name,arbiter_id,
      unit,price,deposit,fee_bps,refund_response_hours,contract_file_id,contract_sha256,terms_json,terms_digest,
      seller_sig,buyer_sig,invite_token,status,escrow_contract_id,created_at)
      VALUES ('old-op','ESQ-HISTORICO','old-project','old-seller','old-buyer','old@example.test','Anterior','old-arbiter',
        '1',50000,2500,90,72,'old-contract',?,?,?,?,?,'old-invite','funded','old-escrow','2026-01-01T00:00:00Z')`)
      .run('a'.repeat(64), terms, termsDigest, sellerSig, buyerSig)
    legacy.exec("INSERT INTO tranches (id,op_id,amount) VALUES ('old-first','old-op',2500)")
  } finally {
    legacy.close()
  }

  // Un proceso nuevo simula abrir durante el despliegue un volumen con el esquema previo.
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { db } = await import('./server/db.ts')
    db.close()
  `], { env: { ...process.env, DATA_DIR: legacyDir }, timeout: 15_000 })

  const snapshotName = (await readdir(legacyDir)).find((file) => /^esquora-antes-de-acuerdos-\d+\.db$/.test(file))
  assert.ok(snapshotName)
  const snapshot = new DatabaseSync(join(legacyDir, snapshotName), { readOnly: true })
  try {
    assert.equal(snapshot.prepare("SELECT terms_digest FROM operations WHERE id = 'old-op'").get()?.terms_digest, termsDigest)
    assert.equal(snapshot.prepare("SELECT 1 FROM pragma_table_info('operations') WHERE name = 'resolution_mode'").get(), undefined)
    assert.deepEqual(snapshot.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    snapshot.close()
  }

  const migrated = new DatabaseSync(legacyDbPath, { readOnly: true })
  try {
    const agreement = migrated.prepare(`SELECT resolution_mode, contract_file_id, contract_sha256, arbiter_id,
      terms_json, terms_digest, seller_sig, buyer_sig, escrow_contract_id, status FROM operations WHERE id = 'old-op'`).get()
    assert.deepEqual({ ...agreement }, {
      resolution_mode: 'external', contract_file_id: 'old-contract', contract_sha256: 'a'.repeat(64),
      arbiter_id: 'old-arbiter', terms_json: terms, terms_digest: termsDigest, seller_sig: sellerSig, buyer_sig: buyerSig,
      escrow_contract_id: 'old-escrow', status: 'funded',
    })
    assert.deepEqual({ ...migrated.prepare("SELECT op_id, amount FROM tranches WHERE id = 'old-first'").get() }, {
      op_id: 'old-op', amount: 2500,
    })
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), [])
    assert.ok(migrated.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'legacy_terms_digest'").get())
    const fields = migrated.prepare("SELECT * FROM pragma_table_info('operations')").all()
    for (const name of ['arbiter_id', 'contract_file_id', 'contract_sha256']) {
      assert.equal(fields.find((field) => field.name === name)?.notnull, 0)
    }
  } finally {
    migrated.close()
  }
})
