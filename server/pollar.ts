import { createHash } from 'node:crypto'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { POLLAR_SECRET_KEY, POLLAR_SERVER_URL } from './config.ts'

export interface Identity {
  subject: string
  publicKey: string
  email: string | null
  name: string
}

export class PollarError extends Error {
  constructor(message: string, readonly status: 401 | 502 | 503) {
    super(message)
  }
}

interface VerifiedToken {
  userId?: string
  applicationId?: string
  expiresAt?: string | number
  network?: string
  wallet?: { address?: string }
  profile?: {
    email?: string
    mail?: string
    first_name?: string
    last_name?: string
    name?: string
  }
}

export async function verifyPollarToken(token: string): Promise<Identity> {
  if (!POLLAR_SECRET_KEY) throw new PollarError('El inicio de sesión aún no está configurado.', 503)
  let response: Response
  try {
    response = await fetch(POLLAR_SERVER_URL + '/v3/tokens/verify', {
      method: 'POST',
      headers: { 'x-pollar-api-key': POLLAR_SECRET_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new PollarError('No pudimos conectar con el servicio de acceso. Inténtalo de nuevo.', 502)
  }
  if (response.status >= 500 || response.status === 429) {
    throw new PollarError('El servicio de acceso no está disponible por el momento.', 502)
  }
  const body = await response.json().catch(() => null) as {
    code?: string
    content?: VerifiedToken
    data?: VerifiedToken
  } | null
  const claim = body?.content ?? body?.data
  const address = claim?.wallet?.address
  if (!response.ok || body?.code !== 'SERVER_TOKEN_VERIFIED' || typeof claim?.userId !== 'string' ||
      claim.userId.length === 0 || typeof address !== 'string' || !StrKey.isValidEd25519PublicKey(address) ||
      claim.network?.toLowerCase() !== 'testnet') {
    throw new PollarError('Tu sesión de acceso venció. Vuelve a entrar.', 401)
  }
  const email = (claim.profile?.mail ?? claim.profile?.email)?.trim().toLowerCase() ?? null
  const validEmail = email && email.length <= 200 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null
  const name = (claim.profile?.name ?? [claim.profile?.first_name, claim.profile?.last_name].filter(Boolean).join(' ')).trim()
  return { subject: 'pollar:' + claim.userId, publicKey: address, email: validEmail, name: name.slice(0, 120) }
}

export function verifyAgreementSignature(termsDigest: string, publicKey: string, signature: string) {
  try {
    const message = 'esquora:acuerdo:sha256:' + termsDigest
    const digest = createHash('sha256').update('Stellar Signed Message:\n').update(message).digest()
    return Keypair.fromPublicKey(publicKey).verify(digest, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}
