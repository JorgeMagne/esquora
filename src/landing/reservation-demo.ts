const timeline = [
  { stage: 'selection', title: 'Elige tu unidad', hold: 1900 },
  { stage: 'selection', title: 'Elige tu unidad', hold: 1660 },
  { stage: 'review', title: 'Revisa la condición', hold: 2050 },
  { stage: 'depositing', title: 'Protegiendo el anticipo', hold: 1760 },
  { stage: 'protected', title: 'Anticipo protegido', hold: 3650 },
] as const

export function setupReservationDemo(demo: HTMLElement, motion: MediaQueryList) {
  const title = demo.querySelector<HTMLElement>('[data-demo-title]')!
  const selection = demo.querySelector<HTMLElement>('.demo-options')!
  const units = [...selection.querySelectorAll<HTMLButtonElement>('[data-demo-unit]')]
  const unitInfo = demo.querySelector<HTMLElement>('.demo-unit-info')!
  const steps = [...demo.querySelectorAll<HTMLLIElement>('.demo-steps li')]
  const review = demo.querySelector<HTMLElement>('.demo-review')!
  const reviewUnit = demo.querySelector<HTMLElement>('[data-review-unit]')!
  const protection = demo.querySelector<HTMLElement>('.demo-protection')!
  const receipt = demo.querySelector<HTMLElement>('[data-demo-receipt]')!
  const receiptUnit = demo.querySelector<HTMLElement>('[data-receipt-unit]')!
  const description = demo.querySelector<HTMLElement>('[data-demo-description]')!

  let index = 0
  let unit = '304'
  let inView = false
  let paused = false
  let timer = 0
  let scheduledAt = 0
  let remaining = 3500

  function render() {
    const step = timeline[index]
    const { stage } = step
    const focusWasInSelection = selection.contains(document.activeElement)
    demo.dataset.stage = stage
    demo.dataset.unit = unit
    if (title.textContent !== step.title) {
      title.textContent = step.title
      if (motion.matches && inView && !paused) {
        title.animate([
          { opacity: .45, translate: '0 5px' },
          { opacity: 1, translate: '0 0' },
        ], { duration: 380, easing: 'cubic-bezier(.16, 1, .3, 1)' })
      }
    }
    selection.hidden = stage !== 'selection'
    unitInfo.hidden = selection.hidden
    review.hidden = stage !== 'review'
    protection.hidden = stage !== 'depositing' && stage !== 'protected'
    reviewUnit.textContent = unit
    receiptUnit.textContent = unit
    for (const item of units) item.setAttribute('aria-pressed', String(item.dataset.demoUnit === unit))
    if (selection.hidden && focusWasInSelection) title.focus({ preventScroll: true })
    const currentStep = stage === 'selection' ? 0 : stage === 'review' ? 1 : 2
    for (const [position, item] of steps.entries()) {
      item.toggleAttribute('data-complete', position < currentStep)
      if (position === currentStep) item.setAttribute('aria-current', 'step')
      else item.removeAttribute('aria-current')
    }

    const protectedAdvance = stage === 'protected'
    receipt.hidden = !protectedAdvance
    description.textContent = protectedAdvance
      ? 'Queda retenido hasta que apruebes el avance acordado.'
      : 'El anticipo entra al contrato.'
  }

  function syncPlayback() {
    const canPlay = motion.matches && inView && !document.hidden && !paused
    demo.toggleAttribute('data-paused', !canPlay)
    if (!canPlay && timer) {
      window.clearTimeout(timer)
      timer = 0
      remaining = Math.max(0, remaining - (performance.now() - scheduledAt))
    }
    if (canPlay && !timer) {
      scheduledAt = performance.now()
      timer = window.setTimeout(() => {
        timer = 0
        index = (index + 1) % timeline.length
        if (index === 0) unit = '304'
        if (index === 1) unit = '305'
        remaining = timeline[index].hold
        render()
        syncPlayback()
      }, remaining)
    }
  }

  function syncMotionPreference() {
    if (!motion.matches) {
      syncPlayback()
      index = timeline.length - 1
      unit = '305'
      remaining = timeline[index].hold
      render()
    }
    syncPlayback()
  }

  for (const option of units) option.addEventListener('click', () => {
    window.clearTimeout(timer)
    timer = 0
    index = 1
    unit = option.dataset.demoUnit!
    remaining = 2300
    render()
    syncPlayback()
  })

  new IntersectionObserver(([entry]) => {
    inView = entry.intersectionRatio >= .45
    syncPlayback()
  }, { threshold: .45 }).observe(demo.querySelector('.demo-visual')!)
  document.addEventListener('visibilitychange', syncPlayback)
  motion.addEventListener('change', syncMotionPreference)
  render()
  syncMotionPreference()

  return (value: boolean) => {
    paused = value
    syncPlayback()
  }
}
