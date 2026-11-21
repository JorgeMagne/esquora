import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { VaultDrawing } from './deposit-vault.tsx'
import type { TowerStage } from './model.ts'

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

function BlueprintFrame({ children, className = '' }: { children: ReactNode; className?: string }) {
  const frame = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    const element = frame.current
    if (!element) return
    let inView = !('IntersectionObserver' in window)
    const syncVisibility = () => setVisible(inView && !document.hidden)
    const observer = inView ? null : new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting
      syncVisibility()
    })
    syncVisibility()
    observer?.observe(element)
    document.addEventListener('visibilitychange', syncVisibility)
    return () => {
      observer?.disconnect()
      document.removeEventListener('visibilitychange', syncVisibility)
    }
  }, [])

  const action = paused ? 'Reanudar movimiento del plano' : 'Pausar movimiento del plano'
  return <div ref={frame} className={'blueprint-frame ' + className} data-moving={visible && !paused}>
    {children}
    <button className="blueprint-toggle" type="button" aria-label={action} title={action}
      onClick={() => setPaused((previous) => !previous)} />
  </div>
}

function DraftingMask({ id, width, height }: { id: string; width: number; height: number }) {
  const gradient = id + '-gradient'
  return <defs>
    <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="white" stopOpacity="0" />
      <stop offset=".16" stopColor="white" stopOpacity=".85" />
      <stop offset=".38" stopColor="white" />
      <stop offset=".68" stopColor="white" stopOpacity=".55" />
      <stop offset="1" stopColor="white" stopOpacity="0" />
    </linearGradient>
    <mask id={id} x="0" y="0" width={width} height={height} maskUnits="userSpaceOnUse">
      <rect className="blueprint-band" width={width} height={height * .46} fill={'url(#' + gradient + ')'} />
      <rect className="blueprint-band blueprint-band-secondary" width={width} height={height * .46} fill={'url(#' + gradient + ')'} />
    </mask>
  </defs>
}

function ResidentialPlan({ children }: { children: ReactNode }) {
  const maskId = useId()
  const mask = 'url(#' + maskId + ')'
  const towerOutline = 'M284 256V113h24v-12h26v12h22v143'
  const towerGrid = 'M284 131h72l20-12m-92 30h72l20-12m-92 30h72l20-12m-92 30h72l20-12m-92 30h72l20-12m-92 30h72l20-12m-92 30h72l20-12m-74-114v143m18-143v143m18-143v143'
  const middleGrid = 'M174 117v119m21-130v128m21-128v128m23-128v128m-80-111h105l24-14m-129 35h105l24-14m-129 35h105l24-14m-129 35h105l24-14'
  const frontGrid = 'M48 259V153h68v106M48 175h68m-68 24h68m-68 24h68m-68 24h68M71 153v106m22-106v106M130 161l24-14m-24 37 24-14m-24 37 24-14m-24 37 24-14'
  return <svg className="access-plan" width="420" height="308" viewBox="0 0 420 308"
      fill="none" aria-hidden="true" focusable="false">
      <DraftingMask id={maskId} width={420} height={308} />
      <g className="access-plan-guides" stroke="currentColor" strokeWidth=".75">
        <path d="M20 262h375M31 275h299l67-38M116 290h197l59-33M40 257l-20 11m69-11-37 21m285-13 60-34M260 275v13m-78-13v13M19 257v10m377-28v10" />
        <path d="M71 101V50h127m166-19h22v210M12 121h142m220 139V87" strokeDasharray="2 4" />
        <path d="M69 50h5m-3-3v6m312-22h6m-3-3v6m-18 53h11m-5-5v10" />
      </g>
      <path className="blueprint-ink blueprint-ink-back" mask={mask} d="M20 262h375M31 275h299l67-38M71 101V50h127m166-19h22v210M12 121h142" />

      <g className="access-plan-background" strokeWidth=".85">
        <path className="plan-face" d="M98 48h66v175H98zM298 41h53v177h-53z" />
        <path className="plan-face plan-side" d="M164 48l23-14v175l-23 14zM351 41l23-14v178l-23 13z" />
        <path className="plan-face plan-roof" d="M98 48l23-14h66l-23 14zM298 41l23-14h53l-23 14z" />
        <path d="M114 61v152m17-152v152m17-152v152m166-159v150m20-150v150M98 69h66m-66 17h66m-66 17h66m134-40h53l23-14m-76 35h53l23-14m-76 35h53l23-14" strokeDasharray="2 3.5" />
        <path className="blueprint-ink blueprint-ink-back" mask={mask}
          d="M98 119V48l23-14h66m-89 35h66m-66 17h66m-50-25v78m34-78v78M298 136V41l23-14h53v93M298 63h53l23-14m-76 35h53l23-14m-40-15v90" />
      </g>

      <g className="access-plan-buildings" strokeWidth="1">
        <path className="plan-face" d="M159 242V108h28V97h77v145z" />
        <path className="plan-face plan-side" d="M264 97l24-14v145l-24 14z" />
        <path className="plan-face plan-side" d="M187 97l24-14v11l-24 14z" />
        <path className="plan-face plan-roof" d="M159 108l24-14h28l-24 14zM187 97l24-14h77l-24 14z" />
        <path d={middleGrid} strokeDasharray="2 3" />
        <path className="blueprint-ink" mask={mask} d={middleGrid} />
        <path className="plan-face" d="M36 259V139l24-14h94l-24 14v120z" />
        <path className="plan-face plan-side" d="M130 139l24-14v120l-24 14z" />
        <path className="plan-face plan-roof" d="M36 139l24-14h94l-24 14z" />
        <path d={frontGrid} strokeDasharray="2 3" />
        <path className="blueprint-ink" mask={mask} d={frontGrid} />
        <path className="blueprint-ink" mask={mask} d="M36 139l24-14h94l-24 14H36" />
      </g>

      <g stroke="currentColor" strokeWidth="1.1">
        <path className="plan-face plan-side" d="M356 113l20-12v143l-20 12z" />
        <path className="plan-face plan-roof" d="M284 113l20-12h4l20-12h26v12h22l-20 12z" />
        <path className="plan-face" d={towerOutline} stroke="none" />
        <path d="M334 101l20-12m-20 24 20-12" />
        <path className="access-plan-grid" d={towerGrid} strokeDasharray="2 3" />
        <path d={towerOutline} stroke="currentColor" strokeWidth="1.2" />
        <path className="blueprint-ink blueprint-ink-front" mask={mask} d={towerGrid} />
        <rect x="302" y="203" width="18" height="18" fill="var(--blue)" stroke="none" />
        <path d="M277 212h4" stroke="var(--blue)" />
      </g>

      {children}
    </svg>
}

export function AccessPlan() {
  return <BlueprintFrame className="access-plan-frame">
    <ResidentialPlan>
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
    </ResidentialPlan>
  </BlueprintFrame>
}

export function Tower({ unit, stage = 'planned' }: { unit?: string; stage?: TowerStage }) {
  const maskId = useId()
  const description = unit ? 'Corte ilustrativo del edificio, con un marcador de la unidad ' + unit +
    '. El marcador tiene una posición esquemática.' : 'Corte esquemático de un edificio en preventa'
  const floors = 'M30 213h68M30 196h68M30 179h68M30 162h68M30 145h68M30 128h68M30 111h68M30 94h68M30 77h68M30 60h68M30 43h68'
  const columns = 'M47 26v204M64 26v204M81 26v204'
  return <BlueprintFrame>
    <svg className={'tower tower-' + stage} viewBox="0 0 116 230" fill="none" role="img" aria-label={description}>
      <DraftingMask id={maskId} width={116} height={230} />
      <g className="tower-floors" stroke="currentColor" strokeWidth=".65" strokeDasharray="2 2.5" opacity=".46">
        <path d={floors} />
        <path d={columns} />
      </g>
      <path className="tower-registration" d="M30 213h68M30 196h68M30 179h68" stroke="currentColor" strokeWidth=".65" />
      <path d="M30 230V26h22V14h24v12h22v204" stroke="currentColor" strokeWidth="1.25" />
      <path className="blueprint-ink blueprint-ink-front" mask={'url(#' + maskId + ')'} d={floors + columns} />
      <g className="tower-unit">
        <rect x="47" y="162" width="17" height="17" fill="var(--blue)" />
        <path d="M20 170.5h8" stroke="var(--blue)" strokeWidth="1.25" />
        {unit && <text x="27" y="165" fill="var(--blue)" fontSize="7.6" fontWeight="700" textAnchor="end">{unit.length > 6 ? unit.slice(0, 5) + '…' : unit}</text>}
      </g>
    </svg>
  </BlueprintFrame>
}

export function ProtectionPlan({ className, settled, planRef }: { className: string; settled: boolean; planRef: RefObject<SVGGElement | null> }) {
  return <BlueprintFrame className={'protection-plan ' + className}>
    <ResidentialPlan>
      <g ref={planRef} className="vault-on-plan" transform="translate(20 92) scale(1.18)">
        <VaultDrawing settled={settled} />
      </g>
    </ResidentialPlan>
  </BlueprintFrame>
}
