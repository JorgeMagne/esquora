// Fase 0, S8 ruta B: política de Pollar que permite a las billeteras firmar entradas de autorización
// de UN contrato y UNA función. Usa la llave secreta de .env (nunca se imprime).
// Uso: npx tsx scripts/spikes/pollar-policy.ts list | create <contractId> | delete <policyId> | settings

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const env = Object.fromEntries(
  readFileSync(join(process.cwd(), '.env'), 'utf8').split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
    .map((m) => [m![1], m![2].trim()]),
)
const BASE = 'https://server.api.pollar.xyz/v3/treasury/soroban-auth'
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'x-pollar-api-key': env.POLLAR_SECRET_KEY, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await res.json().catch(() => null)
  console.log(method, path, res.status, JSON.stringify(j, null, 2))
  return j
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'list') await call('GET', '/policies')
else if (cmd === 'create') {
  if (!/^C[A-Z2-7]{55}$/.test(arg ?? '')) throw new Error('Falta el id del contrato (C…)')
  await call('POST', '/policies', { contract_id: arg, functions: ['resolve_milestone_dispute'], label: 'ESQUORA fase 0 S8 (prueba, borrar)', enabled: true })
} else if (cmd === 'delete') await call('DELETE', `/policies/${arg}`)
else console.error('Uso: list | create <contractId> | delete <policyId>')
