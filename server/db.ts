import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DATA_DIR } from './config.ts'

export const db = new DatabaseSync(join(DATA_DIR, 'esquora.db'))
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

const operationSchema = `(
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  seller_id TEXT NOT NULL REFERENCES users(id),
  buyer_id TEXT REFERENCES users(id),
  buyer_email TEXT NOT NULL,
  buyer_name TEXT NOT NULL,
  arbiter_id TEXT REFERENCES users(id),
  resolution_mode TEXT NOT NULL DEFAULT 'external' CHECK (resolution_mode IN ('pending','external','esquora')),
  arbiter_email TEXT,
  arbiter_invite_token TEXT UNIQUE,
  unit TEXT NOT NULL,
  unit_detail TEXT,
  price INTEGER NOT NULL,
  deposit INTEGER NOT NULL,
  fee_bps INTEGER NOT NULL,
  refund_response_hours REAL NOT NULL,
  contract_file_id TEXT REFERENCES files(id),
  contract_sha256 TEXT,
  terms_json TEXT NOT NULL,
  terms_digest TEXT NOT NULL,
  seller_sig TEXT,
  seller_signed_at TEXT,
  buyer_sig TEXT,
  invite_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  decline_reason TEXT,
  escrow_contract_id TEXT UNIQUE,
  escrow_tx TEXT,
  deployment_error TEXT,
  held_on_chain INTEGER,
  observed_at TEXT,
  observed_ledger INTEGER,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  funded_at TEXT,
  closed_at TEXT
)`

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  pollar_id TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  name TEXT NOT NULL,
  kind TEXT CHECK (kind IN ('buyer','developer','arbiter')),
  org_name TEXT,
  org_nit TEXT,
  phone TEXT,
  public_key TEXT NOT NULL UNIQUE,
  wallet_status TEXT NOT NULL DEFAULT 'pending',
  notif_seen_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  address TEXT NOT NULL,
  description TEXT,
  units_total INTEGER,
  delivery_date TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_docs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  req_key TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES files(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS operations ${operationSchema};
CREATE TABLE IF NOT EXISTS tranches (
  id TEXT PRIMARY KEY,
  op_id TEXT NOT NULL REFERENCES operations(id),
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  condition TEXT NOT NULL,
  requirements_json TEXT NOT NULL,
  amount INTEGER NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence_note TEXT,
  evidence_at TEXT,
  objection TEXT,
  objected_at TEXT,
  approved_at TEXT,
  refund_requested_at TEXT,
  refund_response TEXT,
  refund_response_reason TEXT,
  refund_responded_at TEXT,
  dispute_reason TEXT,
  dispute_by TEXT,
  dispute_at TEXT,
  settled_at TEXT,
  to_seller INTEGER,
  to_buyer INTEGER,
  fee INTEGER,
  tx_hash TEXT
);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  tranche_id TEXT NOT NULL REFERENCES tranches(id),
  req_key TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES files(id),
  created_at TEXT NOT NULL,
  version_hash TEXT,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1))
);
CREATE TABLE IF NOT EXISTS chain_txs (
  id TEXT PRIMARY KEY,
  op_id TEXT REFERENCES operations(id),
  tranche_id TEXT REFERENCES tranches(id),
  deposit_id TEXT REFERENCES deposits(id),
  withdrawal_id TEXT REFERENCES withdrawals(id),
  kind TEXT NOT NULL,
  xdr TEXT NOT NULL,
  signed_xdr TEXT,
  source TEXT NOT NULL,
  expires_at INTEGER,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('armed','pending','confirmed','failed')),
  hash TEXT NOT NULL UNIQUE,
  ledger INTEGER,
  error TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  confirmed_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL REFERENCES operations(id),
  actor_id TEXT,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  tx_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  op_id TEXT NOT NULL REFERENCES operations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  rate REAL NOT NULL,
  amount_bob INTEGER NOT NULL,
  reference TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  tx_hash TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  rate REAL NOT NULL,
  amount_bob INTEGER NOT NULL,
  bank TEXT NOT NULL,
  account TEXT NOT NULL,
  holder TEXT NOT NULL,
  xdr TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_seller ON operations(seller_id);
CREATE INDEX IF NOT EXISTS idx_ops_buyer ON operations(buyer_id);
CREATE INDEX IF NOT EXISTS idx_tranches_op ON tranches(op_id);
CREATE INDEX IF NOT EXISTS idx_events_op ON events(op_id);
CREATE INDEX IF NOT EXISTS idx_chain_op ON chain_txs(op_id, status);
CREATE INDEX IF NOT EXISTS idx_chain_source ON chain_txs(source, status);
CREATE INDEX IF NOT EXISTS idx_chain_tranche ON chain_txs(tranche_id, status);
`)
const chainColumns = db.prepare('PRAGMA table_info(chain_txs)').all()
if (!chainColumns.some((column) => column.name === 'ledger')) {
  db.exec('ALTER TABLE chain_txs ADD COLUMN ledger INTEGER')
}
const evidenceColumns = db.prepare('PRAGMA table_info(evidence)').all()
if (!evidenceColumns.some((column) => column.name === 'version_hash')) {
  db.exec('ALTER TABLE evidence ADD COLUMN version_hash TEXT')
}
if (!evidenceColumns.some((column) => column.name === 'is_current')) {
  db.exec('ALTER TABLE evidence ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1))')
}
if (!db.prepare('PRAGMA table_info(operations)').all().some((column) => column.name === 'resolution_mode')) {
  // SQLite requiere reemplazar la tabla para quitar NOT NULL sin cambiar las referencias de sus tablas hijas.
  const snapshotPath = join(DATA_DIR, 'esquora-antes-de-acuerdos-' + Date.now() + '.db')
  db.prepare('VACUUM main INTO ?').run(snapshotPath)
  console.log('Copia de SQLite guardada en el volumen antes de actualizar los acuerdos.')
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    inTransaction(() => {
      const previous = db.prepare('PRAGMA table_info(operations)').all()
      if (previous.some((column) => column.name === 'resolution_mode')) return
      const dependents = db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name = 'operations' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all()
      db.exec('CREATE TABLE operations_migrated ' + operationSchema)
      const migrated = new Set(db.prepare('PRAGMA table_info(operations_migrated)').all().map((column) => column.name))
      const columns = previous.filter((column) => migrated.has(column.name))
        .map((column) => '"' + String(column.name).replaceAll('"', '""') + '"').join(', ')
      db.exec('INSERT INTO operations_migrated (' + columns + ') SELECT ' + columns + ' FROM operations')
      db.exec('DROP TABLE operations; ALTER TABLE operations_migrated RENAME TO operations;')
      for (const artifact of dependents) db.exec(String(artifact.sql))
      if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('La migración de operaciones produjo referencias inválidas.')
    })
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_evidence_tranche ON evidence(tranche_id, created_at);')

type Param = string | number | null | bigint

export function get<T = any>(sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined
}
export function all<T = any>(sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[]
}
export function run(sql: string, ...params: Param[]) {
  return db.prepare(sql).run(...params)
}

export function inTransaction<T>(write: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = write()
    db.exec('COMMIT')
    return value
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export const now = () => new Date().toISOString()

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export function newId(prefix: string) {
  return `${prefix}_${randomBytes(12).toString('base64url')}`
}
export function shortCode(len = 6) {
  const bytes = randomBytes(len)
  let s = ''
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length]
  return s
}
export function token(bytes = 24) {
  return randomBytes(bytes).toString('base64url')
}
