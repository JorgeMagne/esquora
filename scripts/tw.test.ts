import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder, Address, xdr } from '@stellar/stellar-sdk'

const dataDir = mkdtempSync(join(tmpdir(), 'esquora-tw-test-'))
process.env.DATA_DIR = dataDir
process.env.TRUSTLESS_WORK_API_KEY = 'local-fixture-key'
after(() => {
  rmSync(join(dataDir, 'service-keys.json'), { force: true })
  rmdirSync(join(dataDir, 'uploads'))
  rmdirSync(dataDir)
})

test('la firma conserva el hash y corresponde al origen de la transacción', async () => {
  const { inspectEnvelope } = await import('../server/tw.ts')
  const origin = Keypair.random()
  const other = Keypair.random()
  const expiry = 2_000_000_000
  const transaction = new TransactionBuilder(new Account(origin.publicKey(), '1'), {
    fee: '100', networkPassphrase: Networks.TESTNET, timebounds: { minTime: 0, maxTime: expiry },
  }).addOperation(Operation.changeTrust({ asset: new Asset('USDC', other.publicKey()) })).build()
  const unsigned = inspectEnvelope(transaction.toXDR(), origin.publicKey())
  transaction.sign(origin)
  const signedXdr = transaction.toXDR()
  const signed = inspectEnvelope(signedXdr, origin.publicKey())
  assert.match(unsigned.hash, /^[0-9a-f]{64}$/)
  assert.equal(signed.hash, unsigned.hash)
  assert.equal(signed.source, origin.publicKey())
  assert.equal(signed.expiresAt, expiry * 1000)
  assert.equal(unsigned.hasSignature, false)
  assert.equal(signed.hasSignature, true)
  assert.equal(inspectEnvelope(signedXdr, other.publicKey()).hasSignature, false)
})

test('signService no firma sobres construidos para otra cuenta', async () => {
  const { signService } = await import('../server/tw.ts')
  const source = Keypair.random()
  const xdr = new TransactionBuilder(new Account(source.publicKey(), '1'), {
    fee: '100', networkPassphrase: Networks.TESTNET,
  }).addOperation(Operation.manageData({ name: 'caso', value: 'demo' })).setTimeout(60).build().toXDR()
  assert.throws(() => signService(xdr, 'anchor'), /origen/i)
})

test('una transferencia conserva stroops que se perderían al redondear individualmente', async () => {
  const { circleTransfers, stroopsToCents, USDC } = await import('../server/stellar.ts')
  const transfer = { type: 'transfer', asset_code: USDC.code, asset_issuer: USDC.issuer, from: 'origen', to: 'destino' }
  const changes = circleTransfers([
    { ...transfer, amount: '0.0040000' },
    { ...transfer, amount: '0.0040000' },
    { ...transfer, asset_issuer: Keypair.random().publicKey(), amount: '1000.0000000' },
  ])
  assert.deepEqual(changes.map(({ cents, stroops }) => [cents, stroops]), [[0, '40000'], [0, '40000']])
  assert.equal(stroopsToCents(changes.reduce((sum, change) => sum + BigInt(change.stroops ?? '0'), 0n)), 1)
})

test('un sobre construido para un contrato distinto no se envía al firmante', async (context) => {
  const { buildMilestoneAction } = await import('../server/tw.ts')
  const buyer = Keypair.random().publicKey()
  const seller = Keypair.random().publicKey()
  const expectedContract = new Asset('USDC', seller).contractId(Networks.TESTNET)
  const otherContract = new Asset('USDC', buyer).contractId(Networks.TESTNET)
  const unsigned = new TransactionBuilder(new Account(buyer, '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({
      contract: otherContract,
      function: 'approve_milestone',
      args: [xdr.ScVal.scvU32(0), Address.fromString(buyer).toScVal()],
    })).setTimeout(60).build().toXDR()
  context.mock.method(globalThis, 'fetch', async () => Response.json({ unsignedTransaction: unsigned }))
  await assert.rejects(
    buildMilestoneAction({ kind: 'approve', contractId: expectedContract, index: 0, actor: buyer, buyer, seller, amount: 100 }),
    /transacción preparada/i,
  )
})
