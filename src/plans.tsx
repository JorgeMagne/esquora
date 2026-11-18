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

export function AccessPlan() {
  const towerOutline = 'M284 256V113h24v-12h26v12h22v143'
  return <svg className="access-plan" width="420" height="308" viewBox="0 0 420 308"
    fill="none" aria-hidden="true" focusable="false">
    <g className="access-plan-guides" stroke="currentColor" strokeWidth=".75">
      <path d="M20 262h375M31 275h299l67-38M116 290h197l59-33M40 257l-20 11m69-11-37 21m285-13 60-34M260 275v13m-78-13v13M19 257v10m377-28v10" />
      <path d="M71 101V50h127m166-19h22v210M12 121h142m220 139V87" strokeDasharray="2 4" />
      <path d="M69 50h5m-3-3v6m312-22h6m-3-3v6m-18 53h11m-5-5v10" />
    </g>

    <g className="access-plan-background" strokeWidth=".85">
      <path className="plan-face" d="M98 48h66v175H98zM298 41h53v177h-53z" />
      <path className="plan-face plan-side" d="M164 48l23-14v175l-23 14zM351 41l23-14v178l-23 13z" />
      <path className="plan-face plan-roof" d="M98 48l23-14h66l-23 14zM298 41l23-14h53l-23 14z" />
      <path d="M114 61v152m17-152v152m17-152v152m166-159v150m20-150v150M98 69h66m-66 17h66m-66 17h66m134-40h53l23-14m-76 35h53l23-14m-76 35h53l23-14" strokeDasharray="2 3.5" />
    </g>

    <g className="access-plan-buildings" strokeWidth="1">
      <path className="plan-face" d="M159 242V108h28V97h77v145z" />
      <path className="plan-face plan-side" d="M264 97l24-14v145l-24 14z" />
      <path className="plan-face plan-side" d="M187 97l24-14v11l-24 14z" />
      <path className="plan-face plan-roof" d="M159 108l24-14h28l-24 14zM187 97l24-14h77l-24 14z" />
      <path d="M174 117v119m21-130v128m21-128v128m23-128v128m-80-111h105l24-14m-129 35h105l24-14m-129 35h105l24-14m-129 35h105l24-14" strokeDasharray="2 3" />
      <path className="plan-face" d="M36 259V139l24-14h94l-24 14v120z" />
      <path className="plan-face plan-side" d="M130 139l24-14v120l-24 14z" />
      <path className="plan-face plan-roof" d="M36 139l24-14h94l-24 14z" />
      <path d="M48 259V153h68v106M48 175h68m-68 24h68m-68 24h68m-68 24h68M71 153v106m22-106v106M130 161l24-14m-24 37 24-14m-24 37 24-14m-24 37 24-14" strokeDasharray="2 3" />
    </g>

    <g stroke="currentColor" strokeWidth="1.1">
      <path className="plan-face plan-side" d="M356 113l20-12v143l-20 12z" />
      <path className="plan-face plan-roof" d="M284 113l20-12h4l20-12h26v12h22l-20 12z" />
      <path className="plan-face" d={towerOutline} stroke="none" />
      <path d="M334 101l20-12m-20 24 20-12" />
      <path className="access-plan-grid" d="M284 131h72l20-12m-92 30h72l20-12m-92 30h72l20-12m-92 30h72l20-12m-92 30h72l20-12m-92 30h72l20-12m-92 30h72l20-12m-74-114v143m18-143v143m18-143v143" strokeDasharray="2 3" />
      <rect x="302" y="203" width="18" height="18" fill="var(--blue)" stroke="none" />
      <path d="M277 212h4" stroke="var(--blue)" />
    </g>
    <TracedOutline d={towerOutline} />

    <path className="plan-face plan-roof" d="M126 194l26-15h124l-26 15z" />
    <path className="plan-face plan-side" d="M250 194l26-15v79l-26 15z" />
    <path className="plan-face" d="M126 194h124v79H126z" />
    <TracedOutline d="M126 273v-79l26-15h124v79l-26 15H126m0-79h124l26-15m-26 15v79" />
    <g stroke="currentColor" strokeWidth="1">
      <rect x="137" y="204" width="102" height="59" />
      <rect x="142" y="209" width="92" height="49" />
      <path className="plan-face" d="M134 212h9v11h-9zM134 244h9v11h-9z" />
      <path d="M225 230v8m33-35 10-6m-10 53 10-6" />
      <circle cx="188" cy="233.5" r="17" fill="var(--blue-wash)" stroke="var(--blue)" />
      <path d="M184 232v-3a4 4 0 0 1 8 0v3m-10 0h12v9h-12zM188 235v3" stroke="var(--blue)" />
    </g>
  </svg>
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
