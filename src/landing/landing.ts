import { setupReservationDemo } from './reservation-demo.ts'
import { setupHeroPhrases } from './hero-phrases.ts'
import { setupHeroFold } from './hero-fold.ts'
import { setupHeroScrollCue } from './hero-scroll-cue.ts'
import { setupReservationJourney } from './reservation-journey.ts'

const nav = document.querySelector<HTMLElement>('.nav')!
const menu = document.querySelector<HTMLDetailsElement>('.nav-menu')!
const menuToggle = menu.querySelector<HTMLElement>('summary')!
const hero = document.querySelector<HTMLElement>('.hero')!
const heroLogo = hero.querySelector<HTMLImageElement>('.hero-logo')!
const navLogo = nav.querySelector<HTMLImageElement>('.nav-brand img')!
const brandFlight = document.querySelector<HTMLImageElement>('.brand-flight')!
const main = document.querySelector<HTMLElement>('#contenido')!
const footer = document.querySelector<HTMLElement>('.site-footer')!
const motion = window.matchMedia('(prefers-reduced-motion: no-preference)')
setupHeroFold(hero, nav, motion)
setupHeroScrollCue(hero, motion)
setupReservationJourney(document.getElementById('como-funciona')!)

let frame = 0
let navProgress = -1
let footerHeight = 0
let footerStart = 0
let footerRadius = -1
let revealFooter = false

function measureFooter() {
  footerHeight = footer.offsetHeight
  footerStart = main.offsetTop + main.offsetHeight - window.innerHeight
  // A tall footer stays in normal flow so every link can scroll into view.
  revealFooter = motion.matches && footerHeight + 80 <= window.innerHeight
  main.toggleAttribute('data-footer-reveal', revealFooter)
  footer.toggleAttribute('data-reveal', revealFooter)
  requestScrollSync()
}

function synchronizeNavigation(offset: number, start: number, end: number) {
  const progress = motion.matches ? Math.min(1, Math.max(0, (offset - start) / (end - start))) : Number(offset > 95)
  const inFlight = progress > 0 && progress < 1

  if (inFlight) {
    const origin = heroLogo.getBoundingClientRect()
    const destination = navLogo.getBoundingClientRect()
    const horizontal = progress * progress * (3 - 2 * progress)
    const vertical = 1 - (1 - progress) ** 1.4
    const originTop = origin.top + offset - start
    const x = origin.left + (destination.left - origin.left) * horizontal
    const y = originTop + (destination.top - originTop) * vertical
    const scale = 1 + (destination.width / origin.width - 1) * horizontal

    brandFlight.style.width = `${origin.width}px`
    brandFlight.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`
  }

  if (progress === navProgress) return
  navProgress = progress
  hero.toggleAttribute('data-logo-travel', progress > 0)
  nav.toggleAttribute('data-compact', progress === 1)
  brandFlight.hidden = !inFlight
  const eased = progress * progress * (3 - 2 * progress)
  nav.style.setProperty('--nav-progress', String(eased))
  nav.style.setProperty('--nav-backdrop', String(Math.min(1, Math.max(0, (eased - .39) / .61))))
}

function synchronizeScroll() {
  frame = 0
  const offset = window.scrollY
  const compact = window.innerWidth <= 735
  const navStart = compact ? 16 : 22
  if ((offset > navStart || location.hash) && !hero.hasAttribute('data-skip-opening')) hero.setAttribute('data-skip-opening', '')
  synchronizeNavigation(offset, navStart, compact ? 135 : 172)
  if (revealFooter) {
    const exposed = Math.max(0, offset - footerStart)
    const progress = Math.min(1, exposed / (footerHeight * .55))
    const radius = Math.round(progress * progress * (3 - 2 * progress) * (compact ? 22 : 36) * 10) / 10
    if (radius !== footerRadius) {
      footerRadius = radius
      main.style.setProperty('--footer-fold', `${radius}px`)
    }
  }
}

function requestScrollSync() {
  if (!frame) frame = window.requestAnimationFrame(synchronizeScroll)
}

window.addEventListener('scroll', requestScrollSync, { passive: true })
window.addEventListener('resize', measureFooter)
window.addEventListener('pageshow', measureFooter)
motion.addEventListener('change', measureFooter)
const footerLayout = new ResizeObserver(measureFooter)
footerLayout.observe(main)
footerLayout.observe(footer)
footer.addEventListener('focusin', event => {
  const control = event.target as HTMLElement
  if (revealFooter && control.getBoundingClientRect().top < main.getBoundingClientRect().bottom + 8) {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
  }
})
nav.setAttribute('data-managed', '')
measureFooter()

const market = document.getElementById('problema')
if (market && 'IntersectionObserver' in window) {
  const entryThreshold = .18
  const marketObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) entry.target.removeAttribute('data-entered')
      else if (entry.intersectionRatio >= entryThreshold) entry.target.setAttribute('data-entered', '')
    }
  }, { threshold: [0, entryThreshold] })
  market.querySelectorAll('[data-market-amount]').forEach(amount => marketObserver.observe(amount))
  market.setAttribute('data-motion', '')
}

const pause = hero.querySelector<HTMLButtonElement>('.motion-control')!
const setDemoPaused = setupReservationDemo(hero.querySelector<HTMLElement>('[data-reservation-demo]')!, motion)
const setPhrasesPaused = setupHeroPhrases(hero.querySelector<HTMLElement>('.hero-phrase')!, motion)
let paused = false
pause.hidden = !motion.matches
pause.addEventListener('click', () => {
  paused = !paused
  pause.textContent = paused ? 'Reanudar recorrido' : 'Pausar recorrido'
  setDemoPaused(paused)
  setPhrasesPaused(paused)
})
motion.addEventListener('change', () => { pause.hidden = !motion.matches })

menu.addEventListener('click', event => {
  if ((event.target as Element).closest('a')) menu.open = false
})
document.addEventListener('keydown', event => {
  if (event.key === 'Tab' || event.key === 'Escape') hero.setAttribute('data-skip-opening', '')
  if (event.key === 'Escape' && menu.open) {
    menu.open = false
    menuToggle.focus()
  }
})
document.addEventListener('pointerdown', event => {
  if (menu.open && !menu.contains(event.target as Node)) menu.open = false
})

const finish = document.querySelector<HTMLElement>('.reservation-finish')
const finishTablet = finish?.querySelector('.finish-tablet')
if (finish && finishTablet && 'IntersectionObserver' in window) {
  const entrance = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return
    if (motion.matches) finish.setAttribute('data-arrived', '')
    entrance.disconnect()
  }, { threshold: .32 })
  entrance.observe(finishTablet)
}

const developerIllustration = document.querySelector<HTMLElement>('.developer-illustration')
if (developerIllustration && 'IntersectionObserver' in window && motion.matches) {
  const entrance = new IntersectionObserver(([entry]) => {
    if (entry.intersectionRatio < .36) return
    developerIllustration.setAttribute('data-arrived', '')
    entrance.disconnect()
  }, { threshold: .36 })
  entrance.observe(developerIllustration)
}
