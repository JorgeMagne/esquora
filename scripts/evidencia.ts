// Lista en Markdown las reservas que tienen contrato en Stellar Testnet,
// con su importe, su desenlace y el hash de cada movimiento.
// Solo lee la base: no modifica datos ni llama a la red.
// Uso: npm run evidencia            (lee ./data/esquora.db)
//      DATA_DIR=/app/data npm run evidencia
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const EXPLORER = 'https://stellar.expert/explorer/testnet'
const dataDir = process.env.DATA_DIR ?? './data'
const file = join(dataDir, 'esquora.db')

if (!existsSync(file)) {
  console.error(`No existe ${file}. Indica el directorio de datos con DATA_DIR.`)
  process.exit(1)
}

const db = new DatabaseSync(file, { readOnly: true })

type Row = Record<string, string | number | null>
const all = (sql: string, ...params: (string | number)[]) => db.prepare(sql).all(...params) as unknown as Row[]
const hasColumn = (table: string, column: string) => all(`PRAGMA table_info(${table})`).some((c) => c.name === column)

const usdc = (cents: unknown) =>
  typeof cents === 'number'
    ? (cents / 100).toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—'
const txLink = (label: string, hash: unknown) => (typeof hash === 'string' && hash ? `[${label}](${EXPLORER}/tx/${hash})` : '—')
const day = (iso: unknown) => (typeof iso === 'string' ? iso.slice(0, 10) : '—')

const settledColumns = hasColumn('tranches', 'to_seller') && hasColumn('tranches', 'to_buyer')
const trancheHash = hasColumn('tranches', 'tx_hash')

const operations = all(
  `SELECT id, code, deposit, status, escrow_contract_id, escrow_tx, created_at
     FROM operations
    WHERE escrow_contract_id IS NOT NULL
    ORDER BY created_at`,
)

const counts = { cobro: 0, devolucion: 0, reparto: 0, enCurso: 0 }
const lines: string[] = []

for (const op of operations) {
  const deposit = all(
    `SELECT tx_hash FROM deposits WHERE op_id = ? AND tx_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    String(op.id),
  )[0]
  const tranches = all(
    `SELECT idx, amount, status${settledColumns ? ', to_seller, to_buyer' : ''}${trancheHash ? ', tx_hash' : ''}
       FROM tranches WHERE op_id = ? ORDER BY idx`,
    String(op.id),
  )

  const outcomes: string[] = []
  const exits: string[] = []
  for (const t of tranches) {
    const net = settledColumns ? { seller: t.to_seller, buyer: t.to_buyer } : { seller: null, buyer: null }
    if (t.status === 'released') {
      counts.cobro += 1
      outcomes.push(`Cobro del promotor${settledColumns ? ` (${usdc(net.seller)})` : ''}`)
      exits.push(txLink('cobro', trancheHash ? t.tx_hash : null))
    } else if (t.status === 'refunded') {
      counts.devolucion += 1
      outcomes.push(`Devolución al comprador${settledColumns ? ` (${usdc(net.buyer)})` : ''}`)
      exits.push(txLink('devolución', trancheHash ? t.tx_hash : null))
    } else if (t.status === 'resolved') {
      counts.reparto += 1
      outcomes.push(
        settledColumns ? `Reparto (${usdc(net.seller)} promotor, ${usdc(net.buyer)} comprador)` : 'Reparto resuelto',
      )
      exits.push(txLink('resolución', trancheHash ? t.tx_hash : null))
    } else {
      counts.enCurso += 1
      outcomes.push(`En curso (${String(t.status)})`)
    }
  }

  lines.push(
    [
      String(op.code),
      day(op.created_at),
      usdc(op.deposit),
      outcomes.join('<br>') || '—',
      `[${String(op.escrow_contract_id).slice(0, 8)}…](${EXPLORER}/contract/${String(op.escrow_contract_id)})`,
      txLink('depósito', deposit?.tx_hash),
      exits.filter((e) => e !== '—').join(' · ') || '—',
    ].join(' | '),
  )
}

console.log(`Reservas con contrato en Stellar Testnet: **${operations.length}**`)
console.log(
  `Tramos liquidados: ${counts.cobro} con cobro, ${counts.devolucion} con devolución, ${counts.reparto} con reparto. En curso: ${counts.enCurso}.`,
)
console.log('')
console.log('| Reserva | Fecha | Depósito (USDC de prueba) | Desenlace | Contrato | Depósito | Salida |')
console.log('| --- | --- | ---: | --- | --- | --- | --- |')
for (const line of lines) console.log(`| ${line} |`)
