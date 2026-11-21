export function setupHeroScrollCue(hero: HTMLElement, motion: MediaQueryList) {
  if (window.scrollY > 4 || (location.hash && location.hash !== '#inicio') || document.hidden) return

  const sheet = hero.querySelector<HTMLElement>('.hero-sheet')!
  const cue = sheet.querySelector<HTMLElement>('.hero-scroll-cue')!
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')
  const listeners = new AbortController()
  const passive = { passive: true, signal: listeners.signal }
  let point: { x: number; y: number } | undefined
  let cueWidth = 0
  let timer = window.setTimeout(show, motion.matches ? 2660 : 650)

  function dismiss() {
    window.clearTimeout(timer)
    cue.removeAttribute('data-visible')
    sheet.removeAttribute('data-scroll-cursor')
    listeners.abort()
  }

  function positionCursor() {
    const attached = cueWidth > 0 && !!point && finePointer.matches && motion.matches
    sheet.toggleAttribute('data-scroll-cursor', attached)
    if (!attached || !point) return

    const iconCenter = 22
    const inward = point.x + cueWidth - iconCenter > window.innerWidth - 8
    const left = point.x - (inward ? cueWidth - iconCenter : iconCenter)
    cue.style.setProperty('--cue-x', `${left}px`)
    cue.style.setProperty('--cue-y', `${point.y + window.scrollY}px`)
    cue.toggleAttribute('data-inward', inward)
    cue.setAttribute('data-at-pointer', '')
  }

  function forgetPointer() {
    point = undefined
    sheet.removeAttribute('data-scroll-cursor')
  }

  function show() {
    if (window.scrollY > 4 || document.hidden) {
      dismiss()
      return
    }

    cueWidth = cue.offsetWidth
    if (point && document.elementFromPoint(point.x, point.y) !== sheet) forgetPointer()
    positionCursor()
    cue.setAttribute('data-visible', '')
    timer = window.setTimeout(dismiss, 2800)
  }

  window.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || event.target !== sheet || event.clientX < 26 || event.clientX > window.innerWidth - 26 || event.clientY < 26 || event.clientY > window.innerHeight - 26) {
      forgetPointer()
      return
    }

    point = { x: event.clientX, y: event.clientY }
    positionCursor()
  }, passive)
  document.documentElement.addEventListener('pointerleave', forgetPointer, passive)
  window.addEventListener('pointerdown', dismiss, passive)
  window.addEventListener('scroll', () => {
    if (window.scrollY > 4) dismiss()
  }, passive)
  window.addEventListener('wheel', event => {
    if (event.deltaY > 0 && !event.ctrlKey) dismiss()
  }, passive)
  window.addEventListener('keydown', event => {
    if (['Tab', 'Escape', ' ', 'ArrowDown', 'PageDown', 'End'].includes(event.key)) dismiss()
  }, passive)
  window.addEventListener('resize', () => {
    forgetPointer()
    cue.removeAttribute('data-at-pointer')
    cue.removeAttribute('data-inward')
  }, passive)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) dismiss()
  }, passive)
  motion.addEventListener('change', dismiss, passive)
}
