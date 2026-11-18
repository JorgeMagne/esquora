import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono, type Context, type Next } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { StrKey } from '@stellar/stellar-sdk'
import { canOpenConditionDispute } from '../shared/conditions.ts'
import {
  changeResolutionInstruction, getResolutionInstruction, isResolutionReady, readResolutionCase, submitResolutionInstruction,
} from './resolutions.ts'
import {
  APP_URL, BOB_PER_USDC, ESQUORA_RESOLVER_EMAIL, EXPLORER_URL, HORIZON_URL, MAX_UPLOAD_BYTES, NETWORK_NAME,
  NETWORK_PASSPHRASE, PLATFORM_FEE_BPS, SECURE_COOKIES, SESSION_DAYS, TEST_AUTH_TOKEN, TW_FEE_BPS, UPLOAD_DIR,
} from './config.ts'
import { all, get, inTransaction, newId, now, run, shortCode, token } from './db.ts'
import { ADDRESSES, ChainError, USDC, accountInfo, buildWithdrawXdr, ensureUserAccount, recentPayments } from './stellar.ts'
import { buildMilestoneAction, buildProbe, readEscrow } from './tw.ts'
import { PollarError, type Identity, verifyAgreementSignature, verifyPollarToken } from './pollar.ts'
import {
  actionById, assertNoPending, deployOperation, invalidateArmed, payOrder, prepareAction, refreshAction,
  runExclusive, submitAction, syncOperation, type ActionData,
} from './chain.ts'
import {
  arbiterHasCase, buildTerms, fileMeta, HttpError, isOverdue, logEvent, opById, participants,
  push, refundWindowPassed, roleOf, serializeAction, serializeAgreementTerms, serializeOp, serializeOpSummary, serializeOrder,
  subscribe, totalsOf, trancheById, tranchesOf, userById, type ChainTxRow, type DepositRow,
  type OpRow, type ResolutionMode, type UserRow,
} from './domain.ts'

type Env = { Variables: { user: UserRow } }
export const app = new Hono<Env>()
const COOKIE = 'esquora_session'
const accountTypes = ['buyer', 'developer', 'arbiter'] as const
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, ...err.extra }, err.status as 400)
  if (err instanceof PollarError) return c.json({ error: err.message }, err.status)
  if (err instanceof ChainError) return c.json({ error: err.message }, 502)
  if (err instanceof SyntaxError) return c.json({ error: 'La solicitud tiene un formato inválido.' }, 400)
  console.error('Error de la API', err.name)
  return c.json({ error: 'Ocurrió un error inesperado. Inténtalo de nuevo.' }, 500)
})

app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin')
  if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      origin !== APP_URL && origin !== new URL(c.req.url).origin) {
    throw new HttpError(403, 'Abre ESQUORA para continuar.')
  }
  await next()
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'same-origin')
})

function currentUser(c: Context): UserRow | undefined {
  const value = getCookie(c, COOKIE)
  if (!value) return undefined
  const session = get<{ user_id: string; expires_at: string }>(
    'SELECT user_id, expires_at FROM sessions WHERE token = ?', digest(value),
  )
  if (!session || Date.parse(session.expires_at) <= Date.now()) return undefined
  return userById(session.user_id)
}

async function auth(c: Context<Env>, next: Next) {
  const user = currentUser(c)
  if (!user) throw new HttpError(401, 'Inicia sesión para continuar.')
  c.set('user', user)
  await next()
}

function startSession(c: Context, userId: string) {
  const existing = getCookie(c, COOKIE)
  if (existing) run('DELETE FROM sessions WHERE token = ?', digest(existing))
  const value = token(32)
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000)
  run('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)', digest(value), userId, now(), expires.toISOString())
  setCookie(c, COOKIE, value, { httpOnly: true, secure: SECURE_COOKIES, sameSite: 'Lax', path: '/', expires })
}

function privateUser(u: UserRow) {
  return {
    id: u.id, email: u.email, name: u.name, kind: u.kind, orgName: u.org_name, orgNit: u.org_nit,
    phone: u.phone, publicKey: u.public_key, walletStatus: u.wallet_status, createdAt: u.created_at,
    esquoraVerifier: !!u.email && u.email === ESQUORA_RESOLVER_EMAIL,
  }
}

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const requireStr = (v: unknown, label: string, max = 500) => {
  const s = str(v, max)
  if (!s) throw new HttpError(400, 'Falta completar: ' + label + '.')
  return s
}
const toCents = (v: unknown, label: string) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0 || v > 100_000_000_000) {
    throw new HttpError(400, 'Monto no válido: ' + label + '.')
  }
  return v
}
function emailAddress(value: unknown) {
  const email = requireStr(value, 'correo', 200).toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'El correo no tiene un formato válido.')
  return email
}
async function payload(c: Context) {
  const data = await c.req.json()
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'La solicitud tiene un formato inválido.')
  return data
}

const publicConfig = () => ({
  network: NETWORK_NAME, networkPassphrase: NETWORK_PASSPHRASE, horizonUrl: HORIZON_URL,
  explorerUrl: EXPLORER_URL, appUrl: APP_URL, feeBps: PLATFORM_FEE_BPS, trustlessFeeBps: TW_FEE_BPS,
  bobPerUsdc: BOB_PER_USDC, asset: { code: USDC.code, issuer: USDC.issuer },
  addresses: { fees: ADDRESSES.platform, anchor: ADDRESSES.anchor }, testMode: !!TEST_AUTH_TOKEN,
})
app.get('/api/health', (c) => c.json({ ready: true, network: NETWORK_NAME }))
app.get('/api/config', (c) => c.json(publicConfig()))

function upsertIdentity(identity: Identity) {
  return inTransaction(() => {
    const existing = get<UserRow>('SELECT * FROM users WHERE pollar_id = ?', identity.subject)
    const email = identity.email ?? existing?.email ?? null
    const conflict = get<{ id: string }>('SELECT id FROM users WHERE (public_key = ? OR email = ?) AND id != ?',
      identity.publicKey, email, existing?.id ?? '')
    if (conflict || (existing && existing.public_key !== identity.publicKey)) {
      throw new HttpError(409, 'La identidad o cuenta de acceso no coincide con la registrada.')
    }
    if (existing) {
      if (email !== existing.email) run('UPDATE users SET email = ? WHERE id = ?', email, existing.id)
      return userById(existing.id)!
    }
    const id = newId('usr')
    run('INSERT INTO users (id, pollar_id, email, name, public_key, created_at) VALUES (?,?,?,?,?,?)',
      id, identity.subject, email, identity.name, identity.publicKey, now())
    return userById(id)!
  })
}

app.post('/api/auth/pollar', async (c) => {
  const b = await payload(c)
  const u = upsertIdentity(await verifyPollarToken(requireStr(b.token, 'inicio de sesión', 8192)))
  startSession(c, u.id)
  return c.json({ user: privateUser(u), config: publicConfig() })
})

if (TEST_AUTH_TOKEN) {
  app.post('/api/auth/test', async (c) => {
    const supplied = c.req.header('authorization') ?? ''
    const expected = 'Bearer ' + TEST_AUTH_TOKEN
    if (!timingSafeEqual(Buffer.from(digest(supplied), 'hex'), Buffer.from(digest(expected), 'hex'))) {
      throw new HttpError(401, 'Inicia sesión para continuar.')
    }
    const b = await payload(c)
    const email = emailAddress(b.email)
    const publicKey = requireStr(b.publicKey, 'cuenta', 80)
    if (!StrKey.isValidEd25519PublicKey(publicKey)) throw new HttpError(400, 'La cuenta no es válida.')
    const u = upsertIdentity({ subject: 'local-test:' + email, publicKey, email, name: requireStr(b.name, 'nombre', 120) })
    startSession(c, u.id)
    return c.json({ user: privateUser(u), config: publicConfig() })
  })
}

app.post('/api/auth/logout', (c) => {
  const value = getCookie(c, COOKIE)
  if (value) run('DELETE FROM sessions WHERE token = ?', digest(value))
  deleteCookie(c, COOKIE, { path: '/', secure: SECURE_COOKIES })
  return c.json({ ok: true })
})

app.get('/api/me', (c) => {
  const u = currentUser(c)
  return c.json({ user: u ? privateUser(u) : null, config: publicConfig() })
})

app.patch('/api/me', auth, async (c) => {
  const u = c.get('user')
  const b = await payload(c)
  const kind = b.kind ?? u.kind
  if (!accountTypes.includes(kind)) throw new HttpError(400, 'Elige un tipo de cuenta.')
  if (u.email && u.email === ESQUORA_RESOLVER_EMAIL && kind !== 'arbiter') {
    throw new HttpError(400, 'Esta dirección está reservada para la cuenta verificadora de ESQUORA.')
  }
  if (u.kind && u.kind !== kind) throw new HttpError(409, 'El tipo de cuenta ya está definido.')
  run('UPDATE users SET kind = ?, name = ?, phone = ?, org_name = ?, org_nit = ? WHERE id = ?',
    kind, requireStr(b.name, 'nombre', 120), str(b.phone, 40) || null,
    kind === 'buyer' ? null : requireStr(b.orgName, kind === 'developer' ? 'razón social' : 'institución', 160),
    kind === 'developer' ? requireStr(b.orgNit, 'NIT', 40) : null, u.id)
  return c.json({ user: privateUser(userById(u.id)!) })
})

app.post('/api/wallet/activate', auth, async (c) => {
  const u = c.get('user')
  if (!u.kind) throw new HttpError(409, 'Completa tu perfil para activar la cuenta.')
  return runExclusive('activate:' + u.id, async () => {
    await ensureUserAccount(u.public_key)
    const info = await accountInfo(u.public_key)
    const needsTrustline = u.kind !== 'arbiter' && !info.hasTrustline
    const status = info.exists && !needsTrustline ? 'active' : 'pending'
    run('UPDATE users SET wallet_status = ? WHERE id = ?', status, u.id)
    return c.json({ status, needsTrustline })
  })
})

app.get('/api/wallet', auth, async (c) => {
  const u = c.get('user')
  const pending = all<ChainTxRow>("SELECT * FROM chain_txs WHERE created_by = ? AND kind = 'withdraw' AND status = 'pending'", u.id)
  for (const action of pending) await refreshAction(action, true)
  const [info, payments] = await Promise.all([accountInfo(u.public_key), recentPayments(u.public_key)])
  const operations = all<{ escrow_contract_id: string; code: string; id: string }>(
    'SELECT escrow_contract_id, code, id FROM operations WHERE escrow_contract_id IS NOT NULL AND (seller_id = ? OR buyer_id = ?)', u.id, u.id)
  const escrows = new Map(operations.map((op) => [op.escrow_contract_id, op]))
  const movements = payments.map((p) => {
    const incoming = p.to === u.public_key
    const other = incoming ? p.from : p.to
    const op = escrows.get(other)
    return {
      id: p.id, incoming, cents: p.cents, at: p.at, txHash: p.txHash, opId: op?.id ?? null,
      label: op ? 'Operación ' + op.code : other === ADDRESSES.anchor ? 'Proveedor de pruebas' : 'Movimiento confirmado',
    }
  })
  const withdrawals = all<any>(
    "SELECT * FROM withdrawals WHERE user_id = ? AND status != 'draft' ORDER BY created_at DESC LIMIT 30", u.id,
  ).map((w) => ({
    id: w.id, amount: w.amount, amountBob: w.amount_bob, rate: w.rate, bank: w.bank, account: w.account,
    holder: w.holder, status: w.status, txHash: w.tx_hash, createdAt: w.created_at,
  }))
  return c.json({ publicKey: u.public_key, exists: info.exists, usdc: info.usdc, xlm: info.xlm, movements, withdrawals })
})

app.post('/api/files', auth, bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 65536, onError: (c) => c.json({ error: 'El archivo supera los 15 MB.' }, 413) }), async (c) => {
  const u = c.get('user')
  const body = await c.req.parseBody()
  const file = body.file
  if (!(file instanceof File)) throw new HttpError(400, 'Adjunta un archivo.')
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'El archivo supera los 15 MB.')
  const bytes = Buffer.from(await file.arrayBuffer())
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const path = join(UPLOAD_DIR, sha256)
  if (!existsSync(path)) writeFileSync(path, bytes)
  const id = newId('file')
  run(
    'INSERT INTO files (id, sha256, name, size, mime, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?)',
    id,
    sha256,
    str(file.name, 200) || 'documento',
    file.size,
    file.type || 'application/octet-stream',
    u.id,
    now(),
  )
  return c.json(fileMeta(id))
})

function canReadFile(u: UserRow, fileId: string) {
  const f = get<any>('SELECT uploaded_by FROM files WHERE id = ?', fileId)
  if (!f) return false
  if (f.uploaded_by === u.id) return true
  const linked = all<OpRow>(
    `SELECT o.* FROM operations o
     WHERE (o.seller_id = ?1 OR o.buyer_id = ?1 OR o.arbiter_id = ?1)
       AND (o.contract_file_id = ?2
         OR EXISTS (SELECT 1 FROM tranches t JOIN evidence e ON e.tranche_id = t.id WHERE t.op_id = o.id AND e.file_id = ?2)
         OR EXISTS (SELECT 1 FROM tranches t JOIN resolution_instructions r ON r.tranche_id = t.id WHERE t.op_id = o.id AND r.file_id = ?2)
         OR EXISTS (SELECT 1 FROM project_docs d WHERE d.project_id = o.project_id AND d.file_id = ?2))`,
    u.id,
    fileId,
  )
  return linked.some((o) =>
    o.seller_id === u.id || (o.buyer_id === u.id && o.status !== 'draft') ||
    (o.arbiter_id === u.id && arbiterHasCase(tranchesOf(o.id))),
  )
}

app.get('/api/files/:id', auth, (c) => {
  const u = c.get('user')
  const id = c.req.param('id') ?? ''
  if (!canReadFile(u, id)) throw new HttpError(404, 'No encontramos ese documento.')
  const f = get<any>('SELECT * FROM files WHERE id = ?', id)
  const bytes = readFileSync(join(UPLOAD_DIR, f.sha256))
  const mime = f.mime === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf'
    : f.mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg'
    : f.mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
    : 'application/octet-stream'
  const download = c.req.query('descargar') === '1' || mime === 'application/octet-stream'
  return new Response(bytes, {
    headers: {
      'Content-Type': mime,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Length': String(bytes.length),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'Cache-Control': 'no-store',
    },
  })
})

// ───────────────────────── Directorio de terceros ─────────────────────────

// ───────────────────────── Proyectos ─────────────────────────

function ownProject(u: UserRow, id: string) {
  const p = get<any>('SELECT * FROM projects WHERE id = ? AND owner_id = ?', id, u.id)
  if (!p) throw new HttpError(404, 'No encontramos ese proyecto.')
  return p
}

function projectStats(projectId: string) {
  const ops = all<OpRow>("SELECT * FROM operations WHERE project_id = ? AND status NOT IN ('cancelled','declined')", projectId)
  const totals = { held: 0, released: 0, refunded: 0, fees: 0 }
  for (const op of ops) {
    const t = totalsOf(op, tranchesOf(op.id))
    totals.held += t.held
    totals.released += t.released
    totals.refunded += t.refunded
    totals.fees += t.fees
  }
  return { operations: ops.length, ...totals }
}

const serializeProject = (p: any) => ({
  id: p.id,
  name: p.name,
  city: p.city,
  address: p.address,
  description: p.description,
  unitsTotal: p.units_total,
  deliveryDate: p.delivery_date,
  createdAt: p.created_at,
  stats: projectStats(p.id),
})

app.get('/api/projects', auth, (c) => {
  const u = c.get('user')
  return c.json(all<any>('SELECT * FROM projects WHERE owner_id = ? ORDER BY created_at DESC', u.id).map(serializeProject))
})

app.post('/api/projects', auth, async (c) => {
  const u = c.get('user')
  if (u.kind !== 'developer') throw new HttpError(403, 'Solo una cuenta de desarrollador puede crear proyectos.')
  const b = await payload(c)
  const id = newId('prj')
  run(
    'INSERT INTO projects (id, owner_id, name, city, address, description, units_total, delivery_date, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id,
    u.id,
    requireStr(b.name, 'nombre del proyecto', 120),
    requireStr(b.city, 'ciudad', 80),
    requireStr(b.address, 'dirección', 200),
    str(b.description, 1000) || null,
    Number.isInteger(b.unitsTotal) && b.unitsTotal > 0 ? b.unitsTotal : null,
    str(b.deliveryDate, 30) || null,
    now(),
  )
  return c.json(serializeProject(ownProject(u, id)))
})

app.get('/api/projects/:id', auth, (c) => {
  const u = c.get('user')
  const p = ownProject(u, c.req.param('id') ?? '')
  const docs = all<any>('SELECT * FROM project_docs WHERE project_id = ? ORDER BY created_at', p.id).map((d) => ({
    id: d.id,
    reqKey: d.req_key,
    file: fileMeta(d.file_id),
  }))
  const ops = all<OpRow>('SELECT * FROM operations WHERE project_id = ? ORDER BY created_at DESC', p.id).map((o) =>
    serializeOpSummary(o, 'seller'),
  )
  return c.json({ ...serializeProject(p), docs, operations: ops })
})

app.post('/api/projects/:id/docs', auth, async (c) => {
  const u = c.get('user')
  const p = ownProject(u, c.req.param('id') ?? '')
  const b = await payload(c)
  const reqKey = requireStr(b.reqKey, 'tipo de documento', 60)
  const file = get<any>('SELECT id FROM files WHERE id = ? AND uploaded_by = ?', str(b.fileId, 80), u.id)
  if (!file) throw new HttpError(400, 'Vuelve a subir el documento.')
  inTransaction(() => {
    run('DELETE FROM project_docs WHERE project_id = ? AND req_key = ?', p.id, reqKey)
    run('INSERT INTO project_docs (id, project_id, req_key, file_id, created_at) VALUES (?,?,?,?,?)',
      newId('doc'), p.id, reqKey, file.id, now())
  })
  return c.json({ ok: true })
})

app.delete('/api/projects/:id/docs/:docId', auth, (c) => {
  const u = c.get('user')
  const p = ownProject(u, c.req.param('id') ?? '')
  run('DELETE FROM project_docs WHERE id = ? AND project_id = ?', c.req.param('docId') ?? '', p.id)
  return c.json({ ok: true })
})

// ───────────────────────── Operaciones ─────────────────────────

function loadOp(u: UserRow, id: string) {
  const op = opById(id)
  const role = op ? roleOf(op, u.id) : null
  if (!op || !role || (role === 'buyer' && op.status === 'draft')) throw new HttpError(404, 'No encontramos esa operación.')
  if (role === 'arbiter' && !arbiterHasCase(tranchesOf(op.id))) throw new HttpError(404, 'No encontramos esa operación.')
  return { op, role }
}

function loadTranche(u: UserRow, id: string) {
  const t = trancheById(id)
  if (!t) throw new HttpError(404, 'No encontramos ese tramo.')
  const { op, role } = loadOp(u, t.op_id)
  return { t, op, role }
}

app.get('/api/ops', auth, (c) => {
  const u = c.get('user')
  const rows = all<OpRow>(
    'SELECT * FROM operations WHERE seller_id = ?1 OR buyer_id = ?1 OR arbiter_id = ?1 ORDER BY created_at DESC',
    u.id,
  )
  const list = []
  for (const op of rows) {
    const role = roleOf(op, u.id)!
    if ((role === 'buyer' && op.status === 'draft') || (role === 'arbiter' && !arbiterHasCase(tranchesOf(op.id)))) continue
    list.push(serializeOpSummary(op, role))
  }
  return c.json(list)
})

type ResolverSelection = {
  mode: ResolutionMode
  arbiter: UserRow | null
  email: string | null
  inviteToken: string | null
}

function selectResolver(input: Record<string, unknown>, seller: UserRow, buyerEmail: string, previous?: OpRow): ResolverSelection {
  const legacyId = !previous && TEST_AUTH_TOKEN && input.resolutionMode === undefined ? str(input.arbiterId, 80) : ''
  if (legacyId) {
    const arbiter = userById(legacyId)
    if (!arbiter || arbiter.kind !== 'arbiter' || arbiter.wallet_status !== 'active') throw new HttpError(400, 'El tercero necesita una cuenta activa.')
    if (arbiter.id === seller.id || arbiter.email === buyerEmail) throw new HttpError(400, 'El tercero debe ser distinto del comprador y el desarrollador.')
    return { mode: 'external', arbiter, email: arbiter.email, inviteToken: null }
  }
  const mode = input.resolutionMode ?? 'pending'
  if (mode === 'pending') return { mode, arbiter: null, email: null, inviteToken: null }
  if (mode === 'esquora') {
    const operator = ESQUORA_RESOLVER_EMAIL && get<UserRow>(
      "SELECT * FROM users WHERE email = ? AND kind = 'arbiter' AND wallet_status = 'active'", ESQUORA_RESOLVER_EMAIL,
    )
    const arbiter = operator && operator.id !== seller.id && operator.email !== buyerEmail &&
      !Object.values(ADDRESSES).includes(operator.public_key) ? operator : null
    return { mode, arbiter, email: null, inviteToken: null }
  }
  if (mode !== 'external') throw new HttpError(400, 'Elige una modalidad de resolución válida.')
  const email = emailAddress(input.arbiterEmail)
  if (email === seller.email || email === buyerEmail || email === ESQUORA_RESOLVER_EMAIL) {
    throw new HttpError(400, 'Invita a un tercero externo distinto de las partes y del equipo de ESQUORA.')
  }
  const sameInvitation = previous?.resolution_mode === 'external' && previous.arbiter_email === email ? previous : null
  const arbiter = sameInvitation?.arbiter_id ? userById(sameInvitation.arbiter_id) ?? null : null
  return { mode, arbiter, email, inviteToken: sameInvitation?.arbiter_invite_token ?? token(24) }
}

function updateDraftResolver(op: OpRow, choice: ResolverSelection) {
  const terms = serializeAgreementTerms(JSON.parse(op.terms_json), choice.mode, choice.arbiter, choice.email)
  run(`UPDATE operations SET resolution_mode = ?, arbiter_id = ?, arbiter_email = ?, arbiter_invite_token = ?,
    terms_json = ?, terms_digest = ? WHERE id = ? AND status = 'draft'`,
  choice.mode, choice.arbiter?.id ?? null, choice.email, choice.inviteToken, terms.json, terms.digest, op.id)
  return opById(op.id)!
}

function requireResolverConsent(op: OpRow, consent: unknown) {
  const resolver = op.arbiter_id ? userById(op.arbiter_id) : null
  if (op.resolution_mode === 'pending' || !resolver || resolver.kind !== 'arbiter' || resolver.wallet_status !== 'active') {
    throw new HttpError(409, 'El acuerdo necesita un tercero confirmado antes de firmarse.')
  }
  if (op.resolution_mode === 'esquora' && consent !== true) {
    throw new HttpError(400, 'Acepta expresamente los términos de verificación y ejecución de ESQUORA antes de firmar.')
  }
}

app.post('/api/ops', auth, async (c) => {
  const u = c.get('user')
  if (u.kind !== 'developer') throw new HttpError(403, 'Solo una cuenta de desarrollador puede crear operaciones.')
  if (u.wallet_status !== 'active') throw new HttpError(409, 'Tu cuenta todavía se está activando en la red.')
  const b = await payload(c)
  const project = ownProject(u, str(b.projectId, 80))
  const unit = requireStr(b.unit, 'unidad', 80)
  const unitDetail = str(b.unitDetail, 120)
  const price = toCents(b.price, 'precio del inmueble')
  const deposit = toCents(b.deposit, 'cuota inicial')
  if (deposit > price) throw new HttpError(400, 'La cuota inicial no puede superar el precio del inmueble.')
  const buyerName = requireStr(b.buyerName, 'nombre del comprador', 120)
  const buyerEmail = emailAddress(b.buyerEmail)
  if (buyerEmail === u.email) throw new HttpError(400, 'El comprador no puede ser tu propia cuenta.')
  const resolver = selectResolver(b, u, buyerEmail)
  const contractId = str(b.contractFileId, 80)
  const contract = contractId ? get<{ id: string; sha256: string }>(
    'SELECT id, sha256 FROM files WHERE id = ? AND uploaded_by = ?', contractId, u.id,
  ) : null
  if (contractId && !contract) throw new HttpError(400, 'Vuelve a adjuntar el contrato.')
  const requestedHours = b.refundResponseHours
  const hours = typeof requestedHours === 'number' && Number.isFinite(requestedHours) && requestedHours >= 1 / 60
    ? Math.min(Math.round(requestedHours * 60) / 60, 24 * 60)
    : 72

  if (!Array.isArray(b.tranches) || b.tranches.length < 1 || b.tranches.length > 7)
    throw new HttpError(400, 'Define entre uno y siete tramos.')
  const tranches = b.tranches.map((t: any, i: number) => {
    if (!t || typeof t !== 'object') throw new HttpError(400, 'Los datos de la condición no son válidos.')
    const dueAt = new Date(str(t.dueAt, 40))
    if (Number.isNaN(dueAt.getTime())) throw new HttpError(400, `Falta la fecha límite del tramo ${i + 1}.`)
    if (dueAt.getTime() < Date.now()) throw new HttpError(400, `La fecha límite del tramo ${i + 1} ya pasó.`)
    const requirements = Array.isArray(t.requirements)
      ? t.requirements
          .filter((r: any) => r && typeof r === 'object')
          .map((r: any) => ({ key: str(r.key, 60), label: str(r.label, 200) }))
          .filter((r: any) => r.key && r.label)
      : []
    if (requirements.length === 0 || requirements.length > 16 || new Set(requirements.map((r: { key: string }) => r.key)).size !== requirements.length) throw new HttpError(400, `Indica qué evidencia exige el tramo ${i + 1}.`)
    return {
      title: requireStr(t.title, `título del tramo ${i + 1}`, 120),
      condition: requireStr(t.condition, `condición del tramo ${i + 1}`, 600),
      requirements,
      amount: toCents(t.amount, `tramo ${i + 1}`),
      dueAt: dueAt.toISOString(),
    }
  })
  const sum = tranches.reduce((s: number, t: { amount: number }) => s + t.amount, 0)
  if (sum !== deposit) throw new HttpError(400, 'La suma de los tramos debe ser igual a la cuota inicial.')

  const code = `ESQ-${shortCode(6)}`
  const terms = buildTerms({
    code,
    project,
    unit,
    unitDetail,
    price,
    deposit,
    feeBps: PLATFORM_FEE_BPS,
    refundResponseHours: hours,
    seller: u,
    buyer: { name: buyerName, email: buyerEmail },
    arbiter: resolver.arbiter,
    arbiterEmail: resolver.email,
    resolutionMode: resolver.mode,
    contractSha256: contract?.sha256 ?? null,
    tranches,
  })
  const id = newId('op')
  inTransaction(() => {
    const existingBuyer = get<UserRow>("SELECT * FROM users WHERE email = ? AND kind = 'buyer'", buyerEmail)
    run(
      `INSERT INTO operations (id, code, project_id, seller_id, buyer_id, buyer_email, buyer_name, arbiter_id,
         resolution_mode, arbiter_email, arbiter_invite_token, unit, unit_detail, price, deposit, fee_bps,
         refund_response_hours, contract_file_id, contract_sha256, terms_json, terms_digest, invite_token, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
      id, code, project.id, u.id, existingBuyer?.id ?? null, buyerEmail, buyerName, resolver.arbiter?.id ?? null,
      resolver.mode, resolver.email, resolver.inviteToken, unit, unitDetail || null,
      price, deposit, PLATFORM_FEE_BPS, hours, contract?.id ?? null, contract?.sha256 ?? null, terms.json, terms.digest, token(18), now(),
    )
    for (const [index, tranche] of tranches.entries()) {
      run(
        "INSERT INTO tranches (id, op_id, idx, title, condition, requirements_json, amount, due_at, status) VALUES (?,?,?,?,?,?,?,?,'locked')",
        newId('trn'), id, index, tranche.title, tranche.condition, JSON.stringify(tranche.requirements), tranche.amount, tranche.dueAt,
      )
    }
    logEvent(opById(id)!, u.id, 'created')
  })
  const op = opById(id)!
  return c.json(serializeOp(op, u))
})


app.get('/api/ops/:id', auth, async (c) => {
  const u = c.get('user')
  const id = c.req.param('id') ?? ''
  loadOp(u, id)
  await syncOperation(id)
  return c.json(serializeOp(loadOp(u, id).op, u))
})

app.patch('/api/ops/:id/resolver', auth, async (c) => {
  const u = c.get('user')
  const id = c.req.param('id') ?? ''
  const input = await payload(c)
  return runExclusive('op:' + id, async () => {
    const { op, role } = loadOp(u, id)
    if (role !== 'seller' || op.status !== 'draft') throw new HttpError(409, 'La modalidad solo se puede cambiar mientras el acuerdo está en borrador.')
    if (input.resolutionMode === undefined) throw new HttpError(400, 'Indica la modalidad de resolución.')
    const choice = selectResolver(input, u, op.buyer_email, op)
    const updated = updateDraftResolver(op, choice)
    logEvent(updated, u.id, 'resolver_updated')
    return c.json(serializeOp(updated, u))
  })
})

function resolverInvitation(value: string) {
  const op = get<OpRow>("SELECT * FROM operations WHERE arbiter_invite_token = ? AND resolution_mode = 'external' AND status != 'cancelled'", value)
  if (!op) throw new HttpError(404, 'Esta invitación ya no está disponible.')
  return op
}

app.get('/api/resolver-invitations/:token', (c) => {
  const op = resolverInvitation(c.req.param('token'))
  const u = currentUser(c)
  if (!u?.email || u.email !== op.arbiter_email) return c.json({ mine: false })
  const project = get<{ name: string; city: string }>('SELECT name, city FROM projects WHERE id = ?', op.project_id)
  const seller = userById(op.seller_id)!
  return c.json({
    opId: op.id, code: op.code, unit: op.unit, project, sellerName: seller.org_name ?? seller.name,
    status: op.arbiter_id ? 'accepted' : 'pending', mine: true,
  })
})

app.post('/api/resolver-invitations/:token/claim', auth, async (c) => {
  const u = c.get('user')
  const invite = c.req.param('token') ?? ''
  const initial = resolverInvitation(invite)
  return runExclusive('op:' + initial.id, async () => {
    const op = resolverInvitation(invite)
    if (u.kind !== 'arbiter' || !u.email || u.email !== op.arbiter_email || u.email === ESQUORA_RESOLVER_EMAIL) {
      throw new HttpError(403, 'Abre la invitación con la cuenta de tercero y el correo al que se envió.')
    }
    if (u.wallet_status !== 'active') throw new HttpError(409, 'Activa tu cuenta antes de aceptar la invitación.')
    if (op.arbiter_id === u.id) return c.json({ opId: op.id, status: 'accepted' })
    if (op.status !== 'draft' || op.arbiter_id) throw new HttpError(409, 'Esta invitación ya no se puede aceptar.')
    const updated = inTransaction(() => {
      const next = updateDraftResolver(op, { mode: 'external', arbiter: u, email: op.arbiter_email, inviteToken: invite })
      logEvent(next, u.id, 'resolver_accepted')
      return next
    })
    return c.json({ opId: updated.id, status: 'accepted' })
  })
})

app.post('/api/ops/:id/send', auth, async (c) => {
  const u = c.get('user')
  const id = c.req.param('id') ?? ''
  const { signature, resolutionConsent } = await payload(c)
  return runExclusive('op:' + id, async () => {
    const { op, role } = loadOp(u, id)
    if (role !== 'seller' || op.status !== 'draft') throw new HttpError(409, 'Este acuerdo ya fue enviado.')
    requireResolverConsent(op, resolutionConsent)
    const value = requireStr(signature, 'firma del acuerdo', 200)
    if (!verifyAgreementSignature(op.terms_digest, u.public_key, value)) throw new HttpError(400, 'La firma no corresponde a este acuerdo.')
    run("UPDATE operations SET seller_sig = ?, seller_signed_at = ?, status = 'invited' WHERE id = ?", value, now(), op.id)
    logEvent(opById(op.id)!, u.id, 'invited')
    return c.json(serializeOp(opById(op.id)!, u))
  })
})

app.post('/api/ops/:id/cancel', auth, async (c) => {
  const u = c.get('user')
  const id = c.req.param('id') ?? ''
  return runExclusive('op:' + id, async () => {
    const { op, role } = loadOp(u, id)
    if (role !== 'seller' || !['draft', 'invited'].includes(op.status)) {
      throw new HttpError(409, 'El acuerdo ya está siendo procesado o aceptado.')
    }
    run("UPDATE operations SET status = 'cancelled' WHERE id = ?", op.id)
    logEvent(op, u.id, 'cancelled')
    return c.json(serializeOp(opById(op.id)!, u))
  })
})

function invitation(value: string) {
  const op = get<OpRow>('SELECT * FROM operations WHERE invite_token = ?', value)
  if (!op || ['draft', 'cancelled'].includes(op.status)) throw new HttpError(404, 'Esta invitación ya no está disponible.')
  return op
}

app.get('/api/invitations/:token', (c) => {
  const op = invitation(c.req.param('token'))
  const project = get<{ name: string; city: string }>('SELECT name, city FROM projects WHERE id = ?', op.project_id)
  const seller = userById(op.seller_id)!
  const viewer = currentUser(c)
  return c.json({
    opId: op.id, code: op.code, status: op.status, project, unit: op.unit, unitDetail: op.unit_detail, deposit: op.deposit, price: op.price,
    sellerName: seller.org_name ?? seller.name, buyerName: op.buyer_name,
    buyerEmail: viewer?.id === op.seller_id || viewer?.email === op.buyer_email ? op.buyer_email : null,
    claimed: !!op.buyer_id, mine: !!viewer && op.buyer_id === viewer.id,
  })
})

app.post('/api/invitations/:token/claim', auth, (c) => {
  const u = c.get('user')
  const op = invitation(c.req.param('token') ?? '')
  if (u.kind !== 'buyer' || u.email !== op.buyer_email) {
    throw new HttpError(403, 'Abre la invitación con el correo de comprador indicado en el acuerdo.')
  }
  if (op.buyer_id && op.buyer_id !== u.id) throw new HttpError(409, 'La invitación ya está vinculada a otra cuenta.')
  if (!op.buyer_id) {
    run('UPDATE operations SET buyer_id = ? WHERE id = ? AND buyer_id IS NULL', u.id, op.id)
    push([op.seller_id], { type: 'op', id: op.id })
  }
  return c.json({ opId: op.id })
})

app.post('/api/ops/:id/accept', auth, async (c) => {
  const u = c.get('user')
  const id = c.req.param('id') ?? ''
  const { signature, resolutionConsent } = await payload(c)
  return runExclusive('op:' + id, async () => {
    const { op, role } = loadOp(u, id)
    if (role !== 'buyer') throw new HttpError(403, 'Solo el comprador puede aceptar este acuerdo.')
    if (op.status === 'deploying' || op.escrow_contract_id) return c.json(serializeOp(op, u))
    if (op.status !== 'invited') throw new HttpError(409, 'El acuerdo ya no espera tu aceptación.')
    if (u.wallet_status !== 'active') throw new HttpError(409, 'Activa tu cuenta antes de aceptar el acuerdo.')
    requireResolverConsent(op, resolutionConsent)
    const value = requireStr(signature, 'firma del acuerdo', 200)
    if (!verifyAgreementSignature(op.terms_digest, u.public_key, value)) throw new HttpError(400, 'La firma no corresponde a este acuerdo.')
    await deployOperation(op, u.id, value)
    return c.json(serializeOp(opById(op.id)!, u))
  })
})

app.post('/api/ops/:id/decline', auth, async (c) => {
  const u = c.get('user')
  const id = c.req.param('id') ?? ''
  const { reason } = await payload(c)
  return runExclusive('op:' + id, async () => {
    const { op, role } = loadOp(u, id)
    if (role !== 'buyer' || op.status !== 'invited') throw new HttpError(409, 'Este acuerdo no está esperando tu respuesta.')
    const note = requireStr(reason, 'motivo', 600)
    run("UPDATE operations SET status = 'declined', decline_reason = ? WHERE id = ?", note, op.id)
    logEvent(op, u.id, 'declined', { reason: note })
    return c.json(serializeOp(opById(op.id)!, u))
  })
})

app.post('/api/ops/:id/deposit', auth, (c) => {
  const u = c.get('user')
  const { op, role } = loadOp(u, c.req.param('id') ?? '')
  if (role !== 'buyer' || op.status !== 'awaiting_deposit') throw new HttpError(409, 'Esta operación no espera un depósito.')
  const existing = get<DepositRow>("SELECT * FROM deposits WHERE op_id = ? AND status IN ('pending','paid','failed') ORDER BY created_at DESC LIMIT 1", op.id)
  if (existing && (existing.status === 'paid' || Date.parse(existing.expires_at) > Date.now())) return c.json(serializeOrder(existing))
  const id = newId('dep')
  run(
    "INSERT INTO deposits (id, op_id, user_id, amount, rate, amount_bob, reference, status, expires_at, created_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)",
    id, op.id, u.id, op.deposit, BOB_PER_USDC, Math.round(op.deposit * BOB_PER_USDC),
    op.code + '-' + shortCode(4), new Date(Date.now() + 20 * 60_000).toISOString(), now(),
  )
  return c.json(serializeOrder(get<DepositRow>('SELECT * FROM deposits WHERE id = ?', id)!))
})

function loadOrder(id: string, buyerId: string) {
  const order = get<DepositRow>('SELECT * FROM deposits WHERE id = ?', id)
  if (!order || order.user_id !== buyerId) throw new HttpError(404, 'No encontramos esa orden de pago.')
  return order
}

app.get('/api/anchor/orders/:id', auth, async (c) => {
  const buyerId = c.get('user').id
  let order = loadOrder(c.req.param('id') ?? '', buyerId)
  if (order.status === 'paid') {
    await syncOperation(order.op_id)
    order = loadOrder(order.id, buyerId)
  }
  const op = opById(order.op_id)!
  const project = get<{ name: string }>('SELECT name FROM projects WHERE id = ?', op.project_id)!
  const seller = userById(op.seller_id)!
  return c.json({
    ...serializeOrder(order), expired: ['pending', 'failed'].includes(order.status) && Date.parse(order.expires_at) < Date.now(),
    concept: 'Cuota inicial · ' + project.name + ', ' + op.unit, beneficiary: seller.org_name ?? seller.name,
  })
})

app.post('/api/anchor/orders/:id/pay', auth, async (c) => {
  const buyerId = c.get('user').id
  const order = loadOrder(c.req.param('id') ?? '', buyerId)
  if (order.status !== 'settled') await syncOperation(order.op_id)
  return runExclusive('op:' + order.op_id, async () => {
    const current = loadOrder(order.id, buyerId)
    if (current.status === 'settled' || current.status === 'paid') return c.json(serializeOrder(current))
    if (Date.parse(current.expires_at) < Date.now()) throw new HttpError(410, 'La cotización venció. Vuelve a ESQUORA para generar un nuevo pago.')
    const op = opById(order.op_id)!
    if (op.status !== 'awaiting_deposit' || !op.escrow_contract_id) throw new HttpError(409, 'Esta operación ya no espera un depósito.')
    if ((op.held_on_chain ?? 0) > 0) throw new HttpError(409, 'Ya hay un depósito parcial en la red. Revisa la operación antes de continuar.')
    const processing = get<DepositRow>("SELECT * FROM deposits WHERE op_id = ? AND status IN ('paid','settled') LIMIT 1", op.id)
    if (processing) throw new HttpError(409, 'Ya hay un pago para esta operación.')
    await payOrder(op, current)
    return c.json(serializeOrder(loadOrder(order.id, buyerId)))
  })
})

app.post('/api/tranches/:id/object', auth, async (c) => {
  const u = c.get('user')
  const id = c.req.param('id') ?? ''
  const affected = loadTranche(u, id)
  const { reason } = await payload(c)
  return runExclusive('op:' + affected.op.id, async () => {
    const { t, op, role } = loadTranche(u, id)
    assertNoPending(id)
    if (op.status !== 'funded' || role !== 'buyer' || t.status !== 'submitted') {
      throw new HttpError(409, 'Esta condición ya no espera tu revisión.')
    }
    const text = requireStr(reason, 'motivo de la objeción', 1000)
    inTransaction(() => {
      invalidateArmed(id)
      run("UPDATE tranches SET status = 'objected', objection = ?, objected_at = ? WHERE id = ?", text, now(), id)
      logEvent(op, u.id, 'objected', { tranche: t.idx + 1, reason: text })
    })
    return c.json({ ok: true })
  })
})

app.post('/api/tranches/:id/refund-response', auth, async (c) => {
  const u = c.get('user')
  const id = c.req.param('id') ?? ''
  const affected = loadTranche(u, id)
  const { decision, reason } = await payload(c)
  if (decision !== 'accepted' && decision !== 'rejected') throw new HttpError(400, 'Indica tu respuesta.')
  const note = decision === 'rejected' ? requireStr(reason, 'motivo', 1000) : str(reason, 1000) || null
  return runExclusive('op:' + affected.op.id, async () => {
    const { t, op, role } = loadTranche(u, id)
    assertNoPending(id)
    if (op.status !== 'funded' || role !== 'seller' || t.status !== 'refund_requested' || t.refund_response || refundWindowPassed(op, t)) {
      throw new HttpError(409, 'La devolución ya está en manos del tercero designado.')
    }
    inTransaction(() => {
      run('UPDATE tranches SET refund_response = ?, refund_response_reason = ?, refund_responded_at = ? WHERE id = ?', decision, note, now(), id)
      logEvent(op, u.id, 'refund_responded', { tranche: t.idx + 1, decision, reason: note })
    })
    return c.json({ ok: true })
  })
})

app.get('/api/tranches/:id/resolution-instruction', auth, (c) => {
  const { op, t } = loadTranche(c.get('user'), c.req.param('id') ?? '')
  if (op.resolution_mode !== 'esquora') throw new HttpError(404, 'La modalidad de ESQUORA no aplica a esta operación.')
  return c.json(readResolutionCase(op, t))
})

app.post('/api/tranches/:id/resolution-instruction', auth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id') ?? ''
  const body = await payload(c)
  const { op: operation } = loadTranche(user, id)
  return runExclusive('op:' + operation.id, async () => {
    const { op, t } = loadTranche(user, id)
    if (op.resolution_mode !== 'esquora' || !isResolutionReady(op, t)) {
      throw new HttpError(409, 'El tramo todavía no admite una instrucción de resolución.')
    }
    assertNoPending(t.id)
    inTransaction(() => {
      if (body.action === 'submit') submitResolutionInstruction(op, t, user, body)
      else changeResolutionInstruction(op, t, user, body)
      if (body.action === 'object') invalidateArmed(t.id)
    })
    return c.json(readResolutionCase(op, t))
  })
})

function armingAllowed(user: UserRow) {
  if (user.wallet_status !== 'active') throw new HttpError(409, 'Activa tu cuenta para continuar.')
}

function documentEvidence(u: UserRow, requirements: { key: string; label: string }[], value: unknown) {
  if (!Array.isArray(value) || value.length > 32) throw new HttpError(400, 'Adjunta los documentos de la condición.')
  const documents = value.map((item) => {
    const reqKey = str(item?.reqKey, 60)
    const fileId = str(item?.fileId, 80)
    if ((!requirements.some((r) => r.key === reqKey) && reqKey !== 'otro') || !canReadFile(u, fileId)) {
      throw new HttpError(400, 'Vuelve a adjuntar los documentos de esta condición.')
    }
    return { reqKey, fileId, sha256: fileMeta(fileId)!.sha256 }
  })
  for (const r of requirements) {
    if (!documents.some((d) => d.reqKey === r.key)) throw new HttpError(400, 'Falta adjuntar: ' + r.label + '.')
  }
  return documents
}

const trancheActionKinds = ['evidence', 'approve', 'release', 'refund', 'dispute', 'resolve'] as const
type TrancheAction = typeof trancheActionKinds[number]

async function armTranche(u: UserRow, id: string, kind: TrancheAction, b: Record<string, unknown>) {
  const { op: operation } = loadTranche(u, id)
  return runExclusive('op:' + operation.id, async () => {
    const { t, op, role } = loadTranche(u, id)
    assertNoPending(id)
    if (op.status !== 'funded' || !op.escrow_contract_id || !op.buyer_id) {
      throw new HttpError(409, 'La operación todavía no tiene fondos protegidos.')
    }
    let data: ActionData = {}
    let evidenceDigest: string | undefined
    let toBuyer: number | undefined
    let toSeller: number | undefined
    if (kind === 'evidence') {
      if (role !== 'seller' || !['pending', 'objected'].includes(t.status) || isOverdue(t)) {
        throw new HttpError(409, 'Esta condición ya no admite documentos.')
      }
      const documents = documentEvidence(u, JSON.parse(t.requirements_json), b.items)
      evidenceDigest = digest(JSON.stringify(documents.map(({ reqKey, sha256 }) => ({ reqKey, sha256 })).sort((a, z) =>
        a.reqKey.localeCompare(z.reqKey) || a.sha256.localeCompare(z.sha256))))
      data = { items: documents.map(({ reqKey, fileId }) => ({ reqKey, fileId })), note: str(b.note, 1000) || undefined }
    } else if (kind === 'approve') {
      if (role !== 'buyer' || t.status !== 'submitted') throw new HttpError(409, 'Esta condición no espera tu confirmación.')
    } else if (kind === 'release') {
      if (role !== 'seller' || t.status !== 'approved') throw new HttpError(409, 'Para cobrar, el comprador debe confirmar esta condición.')
    } else if (kind === 'refund') {
      if (role !== 'buyer' || !['pending', 'objected'].includes(t.status) || !isOverdue(t)) {
        throw new HttpError(409, 'La devolución está disponible al vencer la condición sin documentos confirmados.')
      }
    } else if (kind === 'dispute') {
      if (role === 'arbiter' || !canOpenConditionDispute(t.status)) {
        throw new HttpError(409, 'Esta condición no admite un desacuerdo en este momento.')
      }
      data = { reason: requireStr(b.reason, 'motivo del desacuerdo', 1000) }
    } else {
      if (role !== 'arbiter' || !isResolutionReady(op, t)) {
        throw new HttpError(409, 'El caso todavía no está listo para resolver.')
      }
      if (op.resolution_mode === 'esquora') {
        const instruction = getResolutionInstruction(t.id)
        if (!instruction?.verified_at || instruction.id !== b.instructionId) {
          throw new HttpError(409, 'Primero verifica la instrucción documentada para este tramo.')
        }
        toBuyer = instruction.to_buyer
        toSeller = instruction.to_seller
        data = { instructionId: instruction.id, note: 'Instrucción ' + instruction.id + '. ' + instruction.verification_note }
      } else if (t.refund_response === 'accepted') {
        toBuyer = t.amount
        toSeller = 0
      } else {
        const buyerShare = b.toBuyer
        const sellerShare = b.toSeller
        if (typeof buyerShare !== 'number' || typeof sellerShare !== 'number' ||
            !Number.isSafeInteger(buyerShare) || !Number.isSafeInteger(sellerShare) ||
            buyerShare < 0 || sellerShare < 0 || buyerShare + sellerShare !== t.amount) {
          throw new HttpError(400, 'El reparto debe sumar el monto total de la condición.')
        }
        toBuyer = buyerShare
        toSeller = sellerShare
      }
      if (op.resolution_mode !== 'esquora') data = { note: str(b.note, 1000) || undefined }
    }
    const xdr = await buildMilestoneAction({
      kind: kind === 'refund' ? 'dispute' : kind, contractId: op.escrow_contract_id, index: t.idx,
      actor: u.public_key, buyer: userById(op.buyer_id)!.public_key, seller: userById(op.seller_id)!.public_key,
      amount: t.amount, evidenceDigest, toBuyer, toSeller,
    })
    return prepareAction({ kind, xdr, source: u.public_key, userId: u.id, opId: op.id, trancheId: id, data })
  })
}

async function armWithdrawal(u: UserRow, b: Record<string, unknown>) {
  if (u.kind === 'arbiter') throw new HttpError(403, 'Esta cuenta no recibe pagos de las operaciones.')
  const amount = toCents(b.amount, 'retiro')
  const bank = requireStr(b.bank, 'banco', 80)
  const account = requireStr(b.account, 'número de cuenta', 40)
  const holder = requireStr(b.holder, 'titular', 120)
  return runExclusive('wallet:' + u.id, async () => {
    const info = await accountInfo(u.public_key)
    if (amount > info.usdc) throw new HttpError(400, 'El monto supera tu saldo disponible.')
    const id = newId('wd')
    const xdr = await buildWithdrawXdr(u.public_key, amount, 'RET-' + shortCode(6))
    return inTransaction(() => {
      run(
        "INSERT INTO withdrawals (id,user_id,amount,rate,amount_bob,bank,account,holder,xdr,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,'draft',?)",
        id, u.id, amount, BOB_PER_USDC, Math.round(amount * BOB_PER_USDC), bank, account, holder, xdr, now(),
      )
      return prepareAction({ kind: 'withdraw', xdr, source: u.public_key, userId: u.id, withdrawalId: id })
    })
  })
}

app.post('/api/acciones', auth, async (c) => {
  const u = c.get('user')
  const b = await payload(c)
  const kind = b.kind
  if (kind !== 'withdraw' && kind !== 'probe' && !trancheActionKinds.includes(kind)) {
    throw new HttpError(400, 'La acción no está disponible.')
  }
  armingAllowed(u)
  if (kind === 'probe') {
    const { op, role } = loadOp(u, requireStr(b.opId, 'operación', 80))
    if (role === 'arbiter' || !op.escrow_contract_id || op.status !== 'funded') {
      throw new HttpError(409, 'La prueba está disponible para las partes con dinero protegido.')
    }
    const target = tranchesOf(op.id).find((t) => ['pending', 'submitted', 'objected'].includes(t.status))
    if (!target) throw new HttpError(409, 'La prueba requiere una condición pendiente de aprobación.')
    const proof = await buildProbe({ contractId: op.escrow_contract_id, actor: u.public_key, role, index: target.idx, ledger: b.ledger === true })
    if (proof.xdr) {
      const action = prepareAction({ kind: 'probe', xdr: proof.xdr, source: u.public_key, opId: op.id, userId: u.id })
      return c.json({ ...serializeAction(action), xdr: action.xdr })
    }
    if (!proof.rejected) throw new HttpError(409, 'La red no pudo comprobar la protección en esta condición.')
    const error = proof.reason ?? 'Stellar rechazó el intento simulado. El dinero sigue protegido.'
    logEvent(op, u.id, 'probe_rejected', { reason: error, simulated: true, tranche: target.idx + 1 })
    return c.json({ status: 'failed', rejected: true, error })
  }
  const tx = kind === 'withdraw'
    ? await armWithdrawal(u, b)
    : await armTranche(u, requireStr(b.trancheId, 'condición', 80), kind as TrancheAction, b)
  return c.json({ ...serializeAction(tx), xdr: tx.xdr })
})

function loadAction(u: UserRow, id: string) {
  const action = actionById(id)
  if (!action || action.created_by !== u.id || ['deploy', 'fund'].includes(action.kind)) {
    throw new HttpError(404, 'No encontramos esa acción.')
  }
  if (action.op_id) loadOp(u, action.op_id)
  return action
}

app.get('/api/acciones/:id', auth, async (c) => {
  const u = c.get('user')
  const action = loadAction(u, c.req.param('id') ?? '')
  const lock = action.op_id ? 'op:' + action.op_id : 'wallet:' + u.id
  return runExclusive(lock, async () => c.json(serializeAction(await refreshAction(action, true))))
})

app.post('/api/acciones/:id/enviar', auth, async (c) => {
  const u = c.get('user')
  const id = c.req.param('id') ?? ''
  const { signedXdr } = await payload(c)
  const before = loadAction(u, id)
  const lock = before.op_id ? 'op:' + before.op_id : 'wallet:' + u.id
  return runExclusive(lock, async () => {
    const action = loadAction(u, id)
    if (action.status === 'armed') {
      if (action.tranche_id) {
        assertNoPending(action.tranche_id)
        const tranche = trancheById(action.tranche_id)!
        if (action.kind === 'dispute' && !canOpenConditionDispute(tranche.status)) {
          throw new HttpError(409, 'Esta condición ya no admite un desacuerdo.')
        }
        if (action.kind === 'evidence' && isOverdue(tranche)) {
          invalidateArmed(action.tranche_id)
          throw new HttpError(409, 'Venció el plazo para presentar los documentos de esta condición.')
        }
      }
      if (get("SELECT 1 FROM chain_txs WHERE source = ? AND status = 'pending'", u.public_key)) {
        throw new HttpError(409, 'Otra acción está confirmándose en tu cuenta. Inténtalo en unos segundos.')
      }
    }
    const result = await submitAction(action, requireStr(signedXdr, 'transacción firmada', 200_000))
    if (action.tranche_id && action.status === 'armed' && result.status !== 'armed') invalidateArmed(action.tranche_id)
    return c.json(serializeAction(result))
  })
})

app.get('/api/ops/:id/verification', auth, async (c) => {
  const u = c.get('user')
  const { op } = loadOp(u, c.req.param('id') ?? '')
  if (!op.escrow_contract_id) throw new HttpError(409, 'La operación todavía está en preparación.')
  const chain = await syncOperation(op.id) ?? await readEscrow(op.escrow_contract_id)
  const rows = all<ChainTxRow>("SELECT * FROM chain_txs WHERE op_id = ? AND status != 'armed' AND (signed_xdr IS NOT NULL OR confirmed_at IS NOT NULL) ORDER BY created_at DESC", op.id)
  const recorded = new Set(rows.map((row) => row.hash))
  const external = all<{ tx_hash: string; type: string; created_at: string }>(`SELECT tx_hash, type, created_at FROM events
    WHERE op_id = ? AND tx_hash IS NOT NULL ORDER BY created_at DESC`, op.id)
    .filter((row) => !recorded.has(row.tx_hash))
    .map((row) => ({ hash: row.tx_hash, kind: row.type, status: 'confirmed', confirmedAt: row.created_at }))
  return c.json({
    contractId: op.escrow_contract_id, held: chain.held, roles: chain.roles, milestones: chain.milestones,
    asset: { code: USDC.code, issuer: USDC.issuer }, contractSha256: op.contract_sha256, termsDigest: op.terms_digest,
    transactions: [...rows.map(serializeAction), ...external], explorerUrl: EXPLORER_URL,
  })
})

app.get('/api/notifications', auth, (c) => {
  const u = c.get('user')
  const rows = all<any>(
    `SELECT e.id, e.type, e.data_json, e.created_at, e.actor_id, o.id AS op_id, o.code, o.unit, o.seller_id, o.buyer_id, o.arbiter_id
     FROM events e JOIN operations o ON o.id = e.op_id
     WHERE ((o.seller_id = ?1 AND e.type != 'refund_response_expired')
         OR (o.buyer_id = ?1 AND o.status != 'draft' AND e.type NOT IN ('created', 'refund_response_expired'))
         OR (o.arbiter_id = ?1 AND e.type IN (
           'dispute_opened', 'resolution_proposed', 'resolution_signed', 'resolution_verified', 'resolution_objected',
           'refund_requested', 'refund_responded', 'refund_response_expired', 'resolved', 'refunded'
         )))
       AND (e.actor_id IS NULL OR e.actor_id != ?1)
     ORDER BY e.id DESC LIMIT 30`,
    u.id,
  )
  const items = rows.map((r) => ({
    id: r.id,
    type: r.type,
    data: JSON.parse(r.data_json),
    at: r.created_at,
    opId: r.op_id,
    code: r.code,
    unit: r.unit,
    actorRole: r.actor_id ? (r.actor_id === r.seller_id ? 'seller' : r.actor_id === r.buyer_id ? 'buyer' : 'arbiter') : null,
    unread: r.id > u.notif_seen_id,
  }))
  return c.json({ items, unread: items.filter((i) => i.unread).length })
})

app.post('/api/notifications/seen', auth, (c) => {
  const u = c.get('user')
  const max = get<{ m: number }>('SELECT COALESCE(MAX(id), 0) AS m FROM events')!.m
  run('UPDATE users SET notif_seen_id = ? WHERE id = ?', max, u.id)
  return c.json({ ok: true })
})

app.get('/api/stream', auth, (c) =>
  streamSSE(c, async (stream) => {
    const u = c.get('user')
    let open = true
    const off = subscribe(u.id, (msg) => {
      stream.writeSSE({ data: JSON.stringify(msg) }).catch(() => {})
    })
    stream.onAbort(() => {
      open = false
      off()
    })
    await stream.writeSSE({ data: JSON.stringify({ type: 'hello' }) })
    while (open) {
      await stream.sleep(20_000)
      if (open) await stream.writeSSE({ event: 'ping', data: '' })
    }
  }),
)
