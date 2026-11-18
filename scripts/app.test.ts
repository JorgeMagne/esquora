import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
import { Keypair } from '@stellar/stellar-sdk'

const dataDir = await mkdtemp(join(tmpdir(), 'esquora-api-test-'))
const testToken = 'esquora-local-fixture-token-never-use-online'
process.env.DATA_DIR = dataDir
process.env.NODE_ENV = 'test'
process.env.ESQUORA_TEST_AUTH_TOKEN = testToken
process.env.HORIZON_URL = 'https://127.0.0.1:1'
process.env.APP_URL = 'http://127.0.0.1:8787'

const { app } = await import('../server/app.ts')
const { db } = await import('../server/db.ts')

after(async () => {
  db.close()
  await rm(dataDir, { recursive: true, force: true, maxRetries: 3 })
})

function request(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
  return app.request(path, {
    method,
    headers: body instanceof FormData ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  })
}

function identity(alias: string) {
  return { email: `${alias}@example.test`, name: alias, publicKey: Keypair.random().publicKey() }
}

async function login(alias: string, key?: Keypair) {
  const profile = {
    ...identity(alias),
    ...(key ? { publicKey: key.publicKey() } : {}),
  }
  const res = await request('/api/auth/test', 'POST', profile, { Authorization: `Bearer ${testToken}` })
  assert.equal(res.status, 200, await res.text())
  const cookie = res.headers.get('Set-Cookie')?.split(';')[0]
  assert.ok(cookie, 'Expected a session cookie')
  return { cookie, profile }
}

test('authenticates test identities only with the configured authorization token', async () => {
  const body = identity('protected-login')
  const denied = await request('/api/auth/test', 'POST', body)
  assert.ok([401, 403, 404].includes(denied.status))
  assert.equal(denied.headers.get('Set-Cookie'), null)

  const { cookie, profile } = await login('protected-login')
  const me = await request('/api/me', 'GET', undefined, { Cookie: cookie })
  assert.equal(me.status, 200)
  assert.equal((await me.json()).user.publicKey, profile.publicKey)
})

test('the test login never creates a session on a production deployment', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { app } = await import('./server/app.ts')
    const { db } = await import('./server/db.ts')
    try {
      const response = await app.request('/api/auth/test', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + process.env.ESQUORA_TEST_AUTH_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(${JSON.stringify(identity('production-denied'))}),
      })
      console.log(JSON.stringify({ status: response.status, cookie: response.headers.get('Set-Cookie') }))
    } finally {
      db.close()
    }
  `], {
    env: { ...process.env, NODE_ENV: 'production', DATA_DIR: join(dataDir, 'production') },
    timeout: 15_000,
  })
  const result = JSON.parse(stdout.trim()) as { status: number; cookie: string | null }
  assert.ok([401, 403, 404].includes(result.status))
  assert.equal(result.cookie, null)
})

test('requires a session to create and inspect chain actions', async () => {
  for (const [path, method, body] of [
    ['/api/acciones', 'POST', { kind: 'approve', trancheId: 'condition' }],
    ['/api/acciones/action', 'GET'],
    ['/api/acciones/action/enviar', 'POST', { signedXdr: 'fixture' }],
  ] as const) {
    const response = await request(path, method, body)
    assert.equal(response.status, 401, `${method} ${path}`)
  }
})

test('requires a valid action type before asking Stellar or Trustless Work for a transaction', async () => {
  const { cookie } = await login('invalid-action')
  const response = await request('/api/acciones', 'POST', { kind: 'unknown' }, { Cookie: cookie })
  assert.equal(response.status, 400)
})

test('allows project creation and file association only within the developer account', async () => {
  const developer = await login('project-owner')
  const buyer = await login('unrelated-buyer')
  const developerHeaders = { Cookie: developer.cookie }
  const buyerHeaders = { Cookie: buyer.cookie }
  const developerProfile = await request('/api/me', 'PATCH', {
    kind: 'developer', name: 'Desarrollador', orgName: 'Proyecto Santa Cruz', orgNit: '123456',
  }, developerHeaders)
  assert.equal(developerProfile.status, 200, await developerProfile.text())
  const buyerProfile = await request('/api/me', 'PATCH', {
    kind: 'buyer', name: 'Compradora',
  }, buyerHeaders)
  assert.equal(buyerProfile.status, 200, await buyerProfile.text())

  const projectInput = { name: 'Curupaú', city: 'Santa Cruz', address: 'Av. de pruebas' }
  const forbiddenProject = await request('/api/projects', 'POST', projectInput, buyerHeaders)
  assert.equal(forbiddenProject.status, 403)

  const created = await request('/api/projects', 'POST', projectInput, developerHeaders)
  assert.equal(created.status, 200)
  const project: { id: string } = await created.json()
  assert.equal((await request(`/api/projects/${project.id}`, 'GET', undefined, buyerHeaders)).status, 404)

  const upload = new FormData()
  upload.set('file', new File(['Contrato de prueba'], 'contrato.txt', { type: 'text/plain' }))
  const stored = await request('/api/files', 'POST', upload, developerHeaders)
  assert.equal(stored.status, 200)
  const file: { id: string; sha256: string } = await stored.json()
  assert.match(file.sha256, /^[a-f0-9]{64}$/)
  assert.equal((await request(`/api/files/${file.id}`, 'GET', undefined, buyerHeaders)).status, 404)

  const doc = { reqKey: 'contrato', fileId: file.id }
  const docPath = `/api/projects/${project.id}/docs`
  assert.equal((await request(docPath, 'POST', doc, buyerHeaders)).status, 404)
  assert.equal((await request(docPath, 'POST', doc, developerHeaders)).status, 200)
})

test('an invitation can be accepted only by the buyer identity named in the agreement', async () => {
  const ownerKey = Keypair.random()
  const owner = await login('invitation-owner', ownerKey)
  const arbiter = await login('invitation-arbiter')
  const outsider = await login('invitation-outsider')
  const participants: { identity: typeof owner; kind: string; orgName?: string; orgNit?: string }[] = [
    { identity: owner, kind: 'developer', orgName: 'Curupaú', orgNit: '123456' },
    { identity: arbiter, kind: 'arbiter', orgName: 'Tercero designado' },
    { identity: outsider, kind: 'buyer' },
  ]
  for (const { identity, kind, orgName, orgNit } of participants) {
    const profile = await request('/api/me', 'PATCH', {
      name: identity.profile.name, kind, orgName, orgNit,
    }, { Cookie: identity.cookie })
    assert.equal(profile.status, 200, await profile.text())
    // Omitir la activación real en esta prueba de autorización sin red.
    db.prepare("UPDATE users SET wallet_status = 'active' WHERE public_key = ?").run(identity.profile.publicKey)
  }
  const ownerHeaders = { Cookie: owner.cookie }
  const arbiterInfo = await request('/api/me', 'GET', undefined, { Cookie: arbiter.cookie })
  const arbiterId: string = (await arbiterInfo.json()).user.id
  const createdProject = await request('/api/projects', 'POST', {
    name: 'Curupaú', city: 'Santa Cruz', address: 'Av. de pruebas',
  }, ownerHeaders)
  assert.equal(createdProject.status, 200)
  const project: { id: string } = await createdProject.json()
  const upload = new FormData()
  upload.set('file', new File(['Contrato de prueba'], 'acuerdo.txt', { type: 'text/plain' }))
  const createdFile = await request('/api/files', 'POST', upload, ownerHeaders)
  assert.equal(createdFile.status, 200)
  const file: { id: string } = await createdFile.json()

  const creates = await request('/api/ops', 'POST', {
    projectId: project.id, unit: 'A-302', unitDetail: 'Departamento, piso 3', price: 8_000_000, deposit: 20_000,
    buyerName: 'Compradora invitada', buyerEmail: 'invitation-recipient@example.test', arbiterId, contractFileId: file.id,
    tranches: ['Documentación', 'Inicio de obra'].map(title => ({
      title, condition: title, amount: 10_000, dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      requirements: [{ key: 'evidencia', label: 'Evidencia' }],
    })),
  }, ownerHeaders)
  assert.equal(creates.status, 200, creates.status === 200 ? 'Crear acuerdo' : await creates.text())
  const draft: { id: string; terms: string; unitDetail: string; termsDigest: string } = await creates.json()
  assert.equal(draft.unitDetail, 'Departamento, piso 3')
  assert.equal(JSON.parse(draft.terms).inmueble.detalleUnidad, draft.unitDetail)
  const digest = createHash('sha256').update(`Stellar Signed Message:\nesquora:acuerdo:sha256:${draft.termsDigest}`).digest()
  const signature = Buffer.from(ownerKey.sign(digest)).toString('base64')
  const sentResponse = await request(`/api/ops/${draft.id}/send`, 'POST', { signature }, ownerHeaders)
  assert.equal(sentResponse.status, 200, sentResponse.status === 200 ? 'Enviar acuerdo' : await sentResponse.text())
  const sent: { inviteToken: string } = await sentResponse.json()
  const invitePath = `/api/invitations/${sent.inviteToken}/claim`

  const rejection = await request(invitePath, 'POST', {}, { Cookie: outsider.cookie })
  assert.ok([403, 404].includes(rejection.status))
  assert.equal((await request(`/api/ops/${draft.id}`, 'GET', undefined, { Cookie: outsider.cookie })).status, 404)

  const buyer = await login('invitation-recipient')
  const buyerHeaders = { Cookie: buyer.cookie }
  const buyerProfile = await request('/api/me', 'PATCH', { name: buyer.profile.name, kind: 'buyer' }, buyerHeaders)
  assert.equal(buyerProfile.status, 200)
  assert.equal((await request(invitePath, 'POST', {}, buyerHeaders)).status, 200)
  assert.equal((await request(`/api/ops/${draft.id}`, 'GET', undefined, buyerHeaders)).status, 200)
})
