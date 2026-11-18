import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronRight, Download, FileText, LoaderCircle } from 'lucide-react'
import { Link } from 'react-router'
import { fileLink, type FileInfo, type Totals } from './api.ts'
import { money, numberAmount } from './model.ts'

export function Brand() {
  return <Link className="brand" to="/" aria-label="ESQUORA, inicio">
    <svg width="21" height="21" viewBox="0 0 21 21" aria-hidden="true">
      <path d="M1 1h19v19H1zM10.5 1v19M1 10.5h19" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M1.7 11.2h8.1v8.1H1.7z" fill="var(--blue)" />
    </svg>
    ESQUORA
  </Link>
}

export function Title({ children, detail, action }: { children: ReactNode; detail?: ReactNode; action?: ReactNode }) {
  return <header className="page-title"><div><h1>{children}</h1>{detail && <p>{detail}</p>}</div>{action}</header>
}

export function Back({ to, children }: { to: string; children: ReactNode }) {
  return <Link className="back" to={to}><ArrowLeft size={17} aria-hidden="true" />{children}</Link>
}

export function Loading({ children = 'Cargando…' }: { children?: ReactNode }) {
  return <p className="loading" role="status"><LoaderCircle size={18} aria-hidden="true" />{children}</p>
}

export function Feedback({ error, onRetry, children }: { error?: string | Error | null; onRetry?: () => void; children?: ReactNode }) {
  if (!error && !children) return null
  return <div className={'feedback' + (error ? ' feedback-error' : '')} role={error ? 'alert' : 'status'}>
    <span>{error ? typeof error === 'string' ? error : error.message : children}</span>
    {onRetry && <button className="text-button" type="button" onClick={onRetry}>Volver a intentar</button>}
  </div>
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <section className="empty"><h2>{title}</h2><p>{children}</p></section>
}

export function Field({ label, help, children, wide = false }: { label: string; help?: string; children: ReactNode; wide?: boolean }) {
  return <label className={'field' + (wide ? ' field-wide' : '')}><span>{label}</span>{children}{help && <small>{help}</small>}</label>
}

export function Submit({ children, waiting, disabled = false }: { children: ReactNode; waiting?: boolean; disabled?: boolean }) {
  return <button className="button primary" type="submit" disabled={disabled || waiting}>
    {waiting ? 'Procesando…' : children}{waiting ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : <ArrowRight size={18} aria-hidden="true" />}
  </button>
}

export function ActionLink({ to, children, fixed = false }: { to: string; children: ReactNode; fixed?: boolean }) {
  const link = <Link className="button primary" to={to}>{children}<ArrowRight size={18} aria-hidden="true" /></Link>
  return fixed ? <div className="context-action">{link}</div> : link
}

export function TotalsStrip({ totals }: { totals: Totals }) {
  return <dl className="totals-strip">
    <div><dt><i className="swatch held" aria-hidden="true" />Protegido</dt><dd>{money(totals.held)}</dd></div>
    <div><dt><i className="swatch delivered" aria-hidden="true" />Entregado al desarrollador</dt><dd>{money(totals.released)}</dd></div>
    <div><dt><i className="swatch returned" aria-hidden="true" />Devuelto</dt><dd>{money(totals.refunded)}</dd></div>
  </dl>
}

export function Amount({ cents, currency = 'USD' }: { cents: number; currency?: string }) {
  return <strong className="amount"><small>{currency}</small>{numberAmount(cents)}</strong>
}

export function FileRow({ file, label, detail }: { file: FileInfo; label?: string; detail?: string }) {
  return <a className="row file-row" href={fileLink(file)}>
    <FileText size={19} aria-hidden="true" />
    <span><strong>{label ?? file.name}</strong>{detail && <small>{detail}</small>}</span>
    <Download size={18} aria-hidden="true" />
  </a>
}

export function RowLink({ to, title, detail, end }: { to: string; title: ReactNode; detail?: ReactNode; end?: ReactNode }) {
  return <Link className="row row-link" to={to}>
    <span><strong>{title}</strong>{detail && <small>{detail}</small>}</span>
    {end && <span className="row-end">{end}</span>}<ChevronRight size={18} aria-hidden="true" />
  </Link>
}

export function ExplorerLink({ base, hash, kind = 'tx', children = 'Ver en el registro público' }: { base?: string; hash?: string | null; kind?: 'tx' | 'contract'; children?: ReactNode }) {
  if (!base || !hash) return null
  return <a className="external-link" href={base.replace(/\/$/, '') + '/' + kind + '/' + encodeURIComponent(hash)}
    target="_blank" rel="noopener noreferrer">{children} <ArrowUpRight size={15} aria-hidden="true" /></a>
}

export function useWork() {
  const lock = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    try { return await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'No pudimos completar la acción. Vuelve a intentar.') }
    finally { setBusy(false); lock.current = false }
  }
  function submit(action: (data: FormData) => Promise<unknown>) {
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const data = new FormData(event.currentTarget)
      void run(() => action(data))
    }
  }
  return { busy, error, run, submit }
}

export function Dialog({ title, children, onClose, locked = false }: { title: string; children: ReactNode; onClose: () => void; locked?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return <dialog ref={ref} className="dialog" aria-label={title} onCancel={(event) => { event.preventDefault(); if (!locked) onClose() }}>
    <h2>{title}</h2>{children}
  </dialog>
}
