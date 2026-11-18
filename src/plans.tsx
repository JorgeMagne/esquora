import { useId } from 'react'

function TracedOutline({ d }: { d: string }) {
  const id = useId()
  const mask = id + '-reveal'
  return <>
    <defs>
      <path id={id} d={d} pathLength="100" />
      <mask id={mask} x="0" y="0" width="100%" height="100%" maskUnits="userSpaceOnUse">
        <use href={'#' + id} className="plan-trace" fill="none" stroke="white" strokeWidth="4" strokeLinejoin="round" />
      </mask>
    </defs>
    <use href={'#' + id} mask={'url(#' + mask + ')'} fill="none" stroke="currentColor" strokeWidth="1.2" />
  </>
}

export function ProtectionPlan({ className, protectedFunds = false }: { className?: string; protectedFunds?: boolean }) {
  const classes = ['protection-plan', protectedFunds && 'plan-protected', className].filter(Boolean).join(' ')
  return <svg className={classes} viewBox="8 30 272 170" fill="none" aria-hidden="true">
    <g className="plan-guides" stroke="currentColor" strokeWidth=".7">
      <path d="M13 149l94 44 168-62-93-43zM24 161l74 35 156-58M42 167l150-58M51 166l76 19m-38-33 82 17m-43-32 88 16" />
      <path d="M29 134h232M95 40v142M220 35v129" strokeDasharray="2 4" />
    </g>
    <g className="plan-neighbors" stroke="currentColor" strokeWidth=".85">
      <path className="plan-face" d="M25 103l29-22 26 22v39H25zM54 81l29-15 26 22-29 15zM80 103l29-15v39l-29 15z" />
      <path d="M34 111h12v11H34zM57 111h12v11H57zM46 142v-14h12v14M88 109l13-7v13l-13 7z" />
      <path className="plan-face" d="M199 61l26-14h35v65l-26 14h-35z" />
      <path d="M199 61h35l26-14m-26 14v65m-35-49h35l26-14M199 92h35l26-14m-61 29h35l26-14M216 61v65m30-72v65" strokeDasharray="2.2 2.5" />
    </g>
    <path className="plan-face plan-roof" d="M92 77l34-19h86l-34 19z" />
    <path className="plan-face plan-side" d="M178 77l34-19v76l-34 19z" />
    <path className="plan-face" d="M92 77h86v76H92z" />
    <TracedOutline d="M92 153V77l34-19h86v76l-34 19H92M92 77h86l34-19M178 77v76" />
    <g className="plan-vault-door" stroke="currentColor" strokeWidth="1">
      <path d="M102 86h66v57h-66z" />
      <path d="M107 91h56v47h-56z" />
      <path d="M98 88h7v14h-7zM98 127h7v14h-7zM157 108v13" className="plan-face" />
      <circle cx="132" cy="114.5" r="12" />
      <circle cx="132" cy="114.5" r="6" />
      <path d="M132 101v7m0 13v7m-13-13.5h7m12 0h7" />
    </g>
    <g className="plan-guides" stroke="currentColor" strokeWidth=".7">
      <path d="M91 164h88m-87-4v8m86-8v8m7-6 31-17m-31 13v8m31-25v8" />
    </g>
  </svg>
}
