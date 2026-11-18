import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
import { Account, Keypair, Networks, Operation, StrKey, TransactionBuilder, rpc } from '@stellar/stellar-sdk'

const dataDir = await mkdtemp(join(tmpdir(), 'esquora-api-test-'))
const testToken = 'esquora-local-fixture-token-never-use-online'
process.env.DATA_DIR = dataDir
process.env.NODE_ENV = 'test'
process.env.ESQUORA_TEST_AUTH_TOKEN = testToken
process.env.HORIZON_URL = 'https://127.0.0.1:1'
process.env.APP_URL = 'http://127.0.0.1:8787'

const { app } = await import('../server/app.ts')
const { prepareAction, syncOperation } = await import('../server/chain.ts')
const { db } = await import('../server/db.ts')
const { logEvent, notifyExpiredRefunds, opById, subscribe } = await import('../server/domain.ts')

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

test('una solicitud que ya venció se puede renovar sin pedir una firma sobre ella', () => {
  const source = Keypair.random().publicKey()
  const xdr = new TransactionBuilder(new Account(source, '1'), {
    fee: '100', networkPassphrase: Networks.TESTNET, timebounds: { minTime: 0, maxTime: 1 },
  }).addOperation(Operation.manageData({ name: 'evidencia', value: 'prueba' })).build().toXDR()
  assert.throws(() => prepareAction({ kind: 'evidence', xdr, source }), {
    status: 409, extra: { rearm: true },
  })
  assert.equal(db.prepare('SELECT 1 FROM chain_txs WHERE source = ?').get(source), undefined)
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

test('protege el cobro confirmado, las órdenes de pago y los avisos de vencimiento', async (t) => {
  const seller = await login('review-seller')
  const buyer = await login('review-buyer')
  const arbiter = await login('review-arbiter')
  const headers = (account: typeof buyer) => ({ Cookie: account.cookie })
  async function user(account: typeof buyer, kind: string) {
    const res = await request('/api/me', 'PATCH', {
      kind, name: account.profile.name, orgName: 'Proyecto de prueba', orgNit: '123456',
    }, headers(account))
    assert.equal(res.status, 200)
    db.prepare("UPDATE users SET wallet_status = 'active' WHERE public_key = ?").run(account.profile.publicKey)
    return (await res.json()).user.id as string
  }
  const sellerId = await user(seller, 'developer')
  const buyerId = await user(buyer, 'buyer')
  const arbiterId = await user(arbiter, 'arbiter')
  const timestamp = new Date().toISOString()
  const past = '2000-01-01T00:00:00.000Z'
  db.prepare("INSERT INTO projects (id,owner_id,name,city,address,created_at) VALUES ('review-project',?,'Proyecto','Ciudad','Dirección',?)")
    .run(sellerId, timestamp)
  db.prepare("INSERT INTO files (id,sha256,name,size,mime,uploaded_by,created_at) VALUES ('review-file',?,'Acuerdo',1,'text/plain',?,?)")
    .run('a'.repeat(64), sellerId, timestamp)
  db.prepare(`INSERT INTO operations (id,code,project_id,seller_id,buyer_id,buyer_email,buyer_name,arbiter_id,
    unit,price,deposit,fee_bps,refund_response_hours,contract_file_id,contract_sha256,terms_json,terms_digest,
    invite_token,status,escrow_contract_id,created_at)
    VALUES ('review-op','REVIEW','review-project',?,?,?,'Comprador',?,'A-10',30000,15000,90,72,'review-file',?,
      '{}',?,'review-invite','funded','review-stub-contract',?)`)
    .run(sellerId, buyerId, buyer.profile.email, arbiterId, 'a'.repeat(64), 'b'.repeat(64), timestamp)
  const addCondition = db.prepare(`INSERT INTO tranches
    (id,op_id,idx,title,condition,requirements_json,amount,due_at,status,refund_requested_at,refund_response)
    VALUES (?,'review-op',?,'Condición','Presentar documentos','[]',5000,?,?,?,?)`)
  addCondition.run('review-approved', 0, past, 'approved', null, null)
  addCondition.run('review-expired', 1, past, 'refund_requested', past, null)
  addCondition.run('review-future', 2, past, 'refund_requested', timestamp, null)
  addCondition.run('review-responded', 3, past, 'refund_requested', past, 'rejected')
  db.prepare(`INSERT INTO deposits (id,op_id,user_id,amount,rate,amount_bob,reference,status,expires_at,created_at)
    VALUES ('review-order','review-op',?,15000,11.7,175500,'REF','settled',?,?)`).run(buyerId, timestamp, timestamp)

  await t.test('una condición confirmada no admite un desacuerdo, ni uno preparado antes', async () => {
    const creation = await request('/api/acciones', 'POST', {
      kind: 'dispute', trancheId: 'review-approved', reason: 'Motivo de prueba',
    }, headers(buyer))
    assert.equal(creation.status, 409, await creation.text())
    db.prepare(`INSERT INTO chain_txs (id,op_id,tranche_id,kind,xdr,source,status,hash,created_by,created_at)
      VALUES ('review-action','review-op','review-approved','dispute','stub',?,'armed',?,?,?)`)
      .run(buyer.profile.publicKey, 'c'.repeat(64), buyerId, timestamp)
    const stale = await request('/api/acciones/review-action/enviar', 'POST', { signedXdr: 'stub' }, headers(buyer))
    assert.equal(stale.status, 409, await stale.text())
  })

  await t.test('solo el dueño de la orden autenticado puede consultar o pagar', async () => {
    for (const [method, path] of [['GET', '/api/anchor/orders/review-order'], ['POST', '/api/anchor/orders/review-order/pay']]) {
      assert.equal((await request(path, method)).status, 401)
      assert.equal((await request(path, method, undefined, headers(seller))).status, 404)
      assert.equal((await request(path, method, undefined, headers(buyer))).status, 200)
    }
  })

  await t.test('el resumen de compras distingue una cuota pendiente de un depósito en confirmación', async () => {
    const updateOperation = db.prepare("UPDATE operations SET status = ? WHERE id = 'review-op'")
    const updateOrder = db.prepare("UPDATE deposits SET status = ? WHERE id = 'review-order'")
    const nextStep = async () => {
      const response = await request('/api/ops', 'GET', undefined, headers(buyer))
      assert.equal(response.status, 200)
      const operations = await response.json() as { id: string; todo: string }[]
      return operations.find((operation) => operation.id === 'review-op')?.todo
    }

    updateOperation.run('awaiting_deposit')
    try {
      updateOrder.run('pending')
      assert.equal(await nextStep(), 'Deposita la cuota inicial')
      updateOrder.run('paid')
      assert.equal(await nextStep(), 'Confirmando el depósito')
    } finally {
      updateOrder.run('settled')
      updateOperation.run('funded')
    }
  })

  await t.test('el banco acepta una sola vez y permite consultar la orden mientras Stellar tarda', async (context) => {
    let releaseNetwork!: () => void
    const network = new Promise<void>((resolve) => { releaseNetwork = resolve })
    context.mock.method(rpc.Server.prototype, 'getAccount', async () => {
      await network
      throw new Error('Red fuera de servicio en esta prueba')
    })
    db.prepare("UPDATE operations SET status = 'awaiting_deposit', escrow_contract_id = ? WHERE id = 'review-op'")
      .run(StrKey.encodeContract(Buffer.alloc(32, 1)))
    db.prepare("UPDATE deposits SET status = 'pending', expires_at = ? WHERE id = 'review-order'")
      .run(new Date(Date.now() + 60_000).toISOString())
    const url = '/api/anchor/orders/review-order'
    const payment = Promise.resolve(request(url + '/pay', 'POST', {}, headers(buyer)))
    try {
      const quick = (response: Response | Promise<Response>) => new Promise<Response>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('El banco quedó esperando a Stellar')), 1000)
        void Promise.resolve(response).then(resolve, reject).finally(() => clearTimeout(timeout))
      })
      const accepted = await quick(payment)
      assert.equal(accepted.status, 202)
      assert.equal((await accepted.json()).status, 'queued')
      const repeated = await quick(request(url + '/pay', 'POST', {}, headers(buyer)))
      assert.equal(repeated.status, 202)
      assert.equal((await repeated.json()).id, 'review-order')
      const order = await quick(request(url, 'GET', undefined, headers(buyer)))
      assert.equal((await order.json()).status, 'queued')
      const operation = await quick(request('/api/ops/review-op', 'GET', undefined, headers(buyer)))
      assert.equal((await operation.json()).depositOrder.status, 'queued')
    } finally {
      releaseNetwork()
      await payment.catch(() => undefined)
      await syncOperation('review-op')
      db.prepare("UPDATE operations SET status = 'funded', escrow_contract_id = 'review-stub-contract' WHERE id = 'review-op'").run()
      db.prepare("UPDATE deposits SET status = 'settled', expires_at = ?, error = NULL WHERE id = 'review-order'").run(timestamp)
    }
  })

  await t.test('el tercero recibe un solo aviso por un plazo vencido sin respuesta', async () => {
    const messages: unknown[] = []
    const unsubscribe = subscribe(arbiterId, (message) => messages.push(message))
    try {
      notifyExpiredRefunds()
      notifyExpiredRefunds()
      const arbiterNotices = await request('/api/notifications', 'GET', undefined, headers(arbiter))
      const { items, unread } = await arbiterNotices.json()
      assert.equal(unread, 1)
      assert.equal(items[0].type, 'refund_response_expired')
      assert.equal(items[0].data.trancheId, 'review-expired')
      assert.deepEqual(messages, [{ type: 'op', id: 'review-op' }])
      const buyerNotices = await request('/api/notifications', 'GET', undefined, headers(buyer))
      assert.equal((await buyerNotices.json()).unread, 0)
    } finally {
      unsubscribe()
    }
  })

  await t.test('el comprador recibe la presentación, y el tercero recibe el caso cuando se abre', async (context) => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 2))
    db.prepare(`INSERT INTO operations
      (id,code,project_id,seller_id,buyer_id,buyer_email,buyer_name,arbiter_id,unit,price,deposit,fee_bps,
       refund_response_hours,terms_json,terms_digest,invite_token,status,escrow_contract_id,created_at)
      VALUES ('live-op','LIVE','review-project',?,?,?,'Comprador',?,'B-20',30000,15000,90,72,'{}',?,
        'live-invite','funded',?,?)`)
      .run(sellerId, buyerId, buyer.profile.email, arbiterId, 'a'.repeat(64), contractId, timestamp)
    db.prepare(`INSERT INTO tranches (id,op_id,idx,title,condition,requirements_json,amount,due_at,status)
      VALUES ('live-tranche','live-op',0,'Inicio de obra','Presentar el acta','[]',15000,?,'pending')`).run(past)

    let resumeNetwork!: () => void
    const network = new Promise<void>((resolve) => { resumeNetwork = resolve })
    context.mock.method(rpc.Server.prototype, 'getAccount', async () => {
      await network
      throw new Error('Stellar no responde en esta prueba')
    })
    const buyerStream = (await request('/api/stream', 'GET', undefined, headers(buyer))).body!.getReader()
    const arbiterStream = (await request('/api/stream', 'GET', undefined, headers(arbiter))).body!.getReader()
    const withDeadline = <T>(response: T | Promise<T>) => new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No llegó la actualización a tiempo')), 1500)
      void Promise.resolve(response).then(resolve, reject).finally(() => clearTimeout(timeout))
    })
    const message = async (stream: typeof buyerStream) => new TextDecoder().decode((await withDeadline(stream.read())).value)
    try {
      assert.match(await message(buyerStream), /"type":"hello"/)
      assert.match(await message(arbiterStream), /"type":"hello"/)
      db.prepare("UPDATE tranches SET status = 'submitted' WHERE id = 'live-tranche'").run()
      logEvent(opById('live-op')!, sellerId, 'evidence_submitted')
      assert.match(await message(buyerStream), /"id":"live-op"/)
      const url = '/api/ops/live-op?snapshot=1'
      const detail = await withDeadline(request(url, 'GET', undefined, headers(buyer)))
      assert.equal((await detail.json()).tranches[0].status, 'submitted')
      assert.equal((await request(url, 'GET', undefined, headers(arbiter))).status, 404)
      const before = await request('/api/ops', 'GET', undefined, headers(arbiter))
      assert.ok(!(await before.json()).some((row: { id: string }) => row.id === 'live-op'))

      db.prepare("UPDATE tranches SET status = 'disputed' WHERE id = 'live-tranche'").run()
      logEvent(opById('live-op')!, buyerId, 'dispute_opened')
      assert.match(await message(arbiterStream), /"id":"live-op"/)
      const after = await request('/api/ops', 'GET', undefined, headers(arbiter))
      assert.ok((await after.json()).some((row: { id: string }) => row.id === 'live-op'))
    } finally {
      await Promise.all([buyerStream.cancel(), arbiterStream.cancel()])
      resumeNetwork()
      await syncOperation('live-op')
    }
  })
})
