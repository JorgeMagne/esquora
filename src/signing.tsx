import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { Link, useLocation } from 'react-router'
import { api, ApiError, write, type ActionInput, type Armed, type Receipt } from './api.ts'
import { wait } from './model.ts'
import { useAuthorize, useSession } from './session.tsx'
import { usePollar } from '@pollar/react'
import { Dialog, Feedback, Loading, useWork } from './ui.tsx'

export function useAgreementSignature() {
  const authorize = useAuthorize()
  return async (digest: string) => {
    const proof = await authorize().stellar.sep53.signMessage('esquora:acuerdo:sha256:' + digest)
    if (proof.status !== 'signed') throw new Error('El acuerdo no se confirmó. Vuelve a intentar.')
    return proof.signature
  }
}

export function useSigningAvailable() {
  const pollar = usePollar()
  const user = useSession().data?.user
  return pollar.verified && !!user && pollar.wallet?.address === user.publicKey
}

export function ReconnectLink() {
  const location = useLocation()
  return <Link className="text-link" to={'/entrar?reconectar=1&volver=' + encodeURIComponent(location.pathname + location.search)}>Reconectar mi cuenta</Link>
}

export type ActionPrompt = {
  input: ActionInput
  title: string
  detail: string
  complete: string
}

const readReceipt = (id: string) => api<Receipt>('/acciones/' + encodeURIComponent(id))

function expiration(expiresAt: Armed['expiresAt']) {
  if (typeof expiresAt === 'number') return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt
  return expiresAt ? new Date(expiresAt).getTime() : 0
}

export function useChainAction(onReceipt?: (receipt: Receipt) => void) {
  const authorize = useAuthorize()
  const query = useQueryClient()
  const task = useWork()
  const [prompt, setPrompt] = useState<ActionPrompt | null>(null)
  const [phase, setPhase] = useState('')
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState<{ id: string; kind: ActionInput['kind']; complete: string } | null>(null)

  async function send(action: ActionPrompt) {
    setMessage('')
    setPhase('Preparando la confirmación…')
    let receipt: Receipt | undefined
    let id: string | undefined
    try {
      const client = authorize()
      const armed = await write<Armed>('/acciones', action.input)
      id = armed.id
      if (action.input.kind === 'probe' && armed.status === 'failed' && !armed.xdr) {
        onReceipt?.({ status: 'failed', error: armed.error, hash: armed.hash })
        return
      }
      if (!id || !armed.xdr) throw new Error('No pudimos preparar la confirmación. Vuelve a intentar.')
      setPhase('Confirma en la ventana que se abrió…')
      const signed = await client.signTx(armed.xdr, { skipSponsorship: true })
      if (signed.status !== 'signed') {
        throw new Error('La acción no se confirmó. Vuelve a iniciar la confirmación cuando estés listo.')
      }
      const deadline = expiration(armed.expiresAt)
      if (deadline && deadline <= Date.now()) {
        throw new Error('Venció el tiempo para confirmar. Inicia la acción de nuevo para renovar la solicitud.')
      }
      setPhase('Confirmando…')
      try {
        receipt = await write<Receipt>('/acciones/' + encodeURIComponent(id) + '/enviar', { signedXdr: signed.signedXdr })
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) throw error
        // Si se perdió la respuesta de envío, consultar la solicitud que ya se preparó.
        const known = await readReceipt(id).catch(() => null)
        if (!known || !['pending', 'confirmed', 'failed'].includes(known.status)) throw error
        receipt = known
      }
      for (let attempt = 0; receipt.status === 'pending' && attempt < 10; attempt += 1) {
        await wait(2400)
        receipt = await readReceipt(id).catch(() => receipt!)
      }
      if (receipt.status === 'pending') {
        setPending({ id, kind: action.input.kind, complete: action.complete })
        setMessage('La acción sigue confirmándose. Puedes consultar su estado sin repetirla.')
        return
      }
      onReceipt?.(receipt)
      if (receipt.status === 'failed' && action.input.kind !== 'probe') {
        throw new Error(receipt.error || 'La acción no quedó confirmada. Revisa el estado de la operación antes de volver a intentar.')
      }
      if (receipt.status === 'confirmed') setMessage(action.complete)
    } finally {
      setPhase('')
      void query.invalidateQueries({ predicate: ({ queryKey }) => queryKey[0] !== '/me' })
    }
  }

  function checkPending() {
    if (!pending) return
    void task.run(async () => {
      const receipt = await readReceipt(pending.id)
      if (receipt.status === 'pending') return
      setPending(null)
      setMessage(receipt.status === 'confirmed' ? pending.complete : '')
      onReceipt?.(receipt)
      await query.invalidateQueries({ predicate: ({ queryKey }) => queryKey[0] !== '/me' })
      if (receipt.status === 'failed' && pending.kind !== 'probe') throw new Error(receipt.error || 'La acción no quedó confirmada.')
    })
  }

  const dialog = prompt && <Dialog title={prompt.title} onClose={() => setPrompt(null)}>
    <p>{prompt.detail}</p>
    <p className="muted">La ventana de confirmación puede estar en inglés.</p>
    <div className="button-row">
      <button className="button secondary" type="button" onClick={() => setPrompt(null)}>Volver</button>
      <button className="button primary" type="button" onClick={() => {
        const action = prompt
        setPrompt(null)
        void task.run(() => send(action))
      }}>Continuar<ArrowRight size={18} aria-hidden="true" /></button>
    </div>
  </Dialog>

  return {
    open: setPrompt,
    busy: task.busy || !!pending,
    feedback: <>{phase && <Loading>{phase}</Loading>}<Feedback error={task.error}>{message}</Feedback>
      {pending && <button className="text-button" type="button" disabled={task.busy} onClick={checkPending}>Comprobar estado</button>}</>,
    dialog,
  }
}
