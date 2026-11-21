import { useId, useLayoutEffect, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'

// The plan and the moving detail use the same paths, in the same drawing coordinates.
export function VaultDrawing({ settled = false, moving = false }: { settled?: boolean; moving?: boolean }) {
  const id = useId()
  const hatch = 'url(#' + id + '-hatch)'
  return <g fill="none" stroke="currentColor" strokeWidth=".95" strokeLinecap="round" strokeLinejoin="round">
    <defs>
      <pattern id={id + '-hatch'} patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(29)">
        <path d="M0 0v4" stroke="currentColor" strokeWidth=".45" opacity=".54"/>
      </pattern>
      <g id={id + '-bill'} fill="var(--paper)" stroke="var(--blue-dark)">
        <path d="M-20-8.5q10-2 20-.4t20-.2l-.2 17q-10 2-20 .4t-20 .2z"/>
        <path d="M-16-5.7q8-1.2 16-.1t16 0q0 2 1.5 2v7q-2 .4-2 2.7-7 1.1-15.5-.1t-15.6.2q-.2-2-2-2.3l.1-7q2 0 1.5-2.4z" strokeWidth=".48"/>
        <ellipse rx="6.2" ry="7.1" fill="var(--blue-wash)" strokeWidth=".65"/>
        <path d="M2.1-2.7C.5-5-3.1-3.5-2.7-1.5S2.8-.7 2.5 1.8-.7 4.4-2.8 2.3M0-5v10" strokeWidth="1.1"/>
        <path d="m-13-.3 4-.3m18 1 4-.3" strokeWidth=".7"/>
      </g>
    </defs>
    <path d="M92 77.1l34.1-19 86.1-.2-34.1 19.3z" fill="var(--white)"/>
    <path d="m178.1 77.2 34.1-19.3-.4 76.3-33.8 18.9z" fill="var(--paper-2)"/>
    <path d="m178.1 77.2 34.1-19.3-.4 76.3-33.8 18.9z" fill={hatch} stroke="none"/>
    <path d="m92 77.1 86.1.1-.1 75.9-86.2-.3z" fill="var(--paper)"/>
    <g opacity=".42" strokeWidth=".47">
      <path d="m90 78.6 90 .1 33.4-19.4m-119 94.8 82.3.3M179.8 78l-.5 74.6m-79.2-75.9 28.1-16.4 70.3-.8"/>
      <path d="m90.2 74.5 1.6 81m-3.1-4 91.9 2.3m27.9-94 6.5-3.1"/>
    </g>
    <path d="m101.7 85.8 66.9.4-.4 57.2-66.1-.3z" fill="var(--line)"/>
    <path d="m101.7 85.8 66.9.4-.4 57.2-9.7-6.8.4-42-48.3-.5-8.4-8.3z" fill={hatch} strokeWidth=".55"/>
    <path d="m102 143 8.6-7.4 47.9 1.1 9 6.6" strokeWidth=".6"/>
    {moving && <g>{[0,1,2].map(i => <use key={i} href={'#' + id + '-bill'} className={'vault-bill bill-' + i} x="135" y="116"/>)}</g>}
    <g className="vault-leaf">
      <path d="m102 86 66 .3-.2 56.6-65.6.2z" fill="var(--paper)"/>
      <path d="m105.6 89.7 58.6.3-.1 49.2-58.2-.4z" strokeWidth=".68"/>
      <path d="m107.7 92 54.5-.3m-55.3 45.8 54.1.5" strokeWidth=".4" opacity=".55"/>
      <path d="m157.6 107.4 1.6.2v12.1l-1.8 1.2z"/>
      <g className="vault-dial">
        <circle cx="132" cy="114.5" r="11.6" fill="var(--paper-2)"/>
        <circle cx="132" cy="114.5" r="9.7" strokeWidth=".5" strokeDasharray=".85 2.2"/>
        <path d="m132 114.5 0-8.5m0 8.5 7 4.4m-7-4.4-7.2 4.2" strokeWidth="1.8"/>
        <circle cx="132" cy="114.5" r="2.5" fill="var(--white)"/>
      </g>
      {settled && <path className="vault-ink-check" d="m149.1 131.5 2.9 3 6.9-8.3" stroke="var(--blue)" strokeWidth="1.7" pathLength="1"/>}
    </g>
    <path d="m99 90.4 4.8-.4.2 9.2-4.9.4zm.2 37.4 4.6-.2.1 9.3-4.9.1z" fill="var(--line)" strokeWidth=".7"/>
  </g>
}

type FlightStyle = CSSProperties & Record<'--vault-x' | '--vault-y' | '--vault-scale' | '--vault-width', string>

export function VaultFlight({ plan }: { plan: RefObject<SVGGElement | null> }) {
  const [style, setStyle] = useState<FlightStyle | null>(null)
  useLayoutEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const matrix = plan.current?.getScreenCTM()
    if (motion.matches || !matrix || document.hidden) return
    const origin = new DOMPoint(152, 106).matrixTransform(matrix)
    const width = Math.min(window.innerWidth * .90, window.innerHeight * .91, 530)
    setStyle({
      '--vault-width': width + 'px',
      '--vault-x': origin.x - window.innerWidth / 2 + 'px',
      '--vault-y': origin.y - window.innerHeight / 2 + 'px',
      '--vault-scale': String(matrix.a / (width / 240)),
    })
    const finish = () => setStyle(null)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') finish() }
    window.addEventListener('resize', finish)
    window.addEventListener('scroll', finish, { passive: true })
    window.addEventListener('keydown', escape)
    motion.addEventListener('change', finish)
    document.addEventListener('visibilitychange', finish)
    return () => {
      window.removeEventListener('resize', finish)
      window.removeEventListener('scroll', finish)
      window.removeEventListener('keydown', escape)
      motion.removeEventListener('change', finish)
      document.removeEventListener('visibilitychange', finish)
    }
  }, [plan])
  if (!style) return null
  return <div className="vault-flight" aria-hidden="true" style={style}
    onAnimationEnd={event => { if (event.animationName === 'vault-trip') setStyle(null) }}>
    <div className="vault-veil"/>
    <svg className="vault-detail" viewBox="32 21 240 170" fill="none">
      <VaultDrawing settled moving/>
      <g className="vault-measure" stroke="currentColor" strokeWidth=".5">
        <path d="M88 161.5h95m-90.9-5.5-.2 10m86.5-10.2-.3 10m4.2-8 34.5-19.3m-31 12.7v10m27.5-25v9"/>
        <path d="m89.5 163.7 4.6-4.6m81.5 4.8 4.7-4.8" />
      </g>
    </svg>
    <p className="vault-caption">Tu dinero ahora está <strong>protegido.</strong></p>
  </div>
}
