type FoldMotion = { input: number; value: number }

// Filter the input over a frame, then let the edge ease toward it at a slower rate.
function advanceFold(track: FoldMotion, target: number, elapsed: number) {
  const inputRate = 60
  const settlingRate = 5.9
  const inputDecay = Math.exp(-inputRate * elapsed)
  const settlingDecay = Math.exp(-settlingRate * elapsed)
  const inputDelta = track.input - target
  const inputEffect = inputDelta * settlingRate * (settlingDecay - inputDecay) / (inputRate - settlingRate)
  track.input = target + inputDelta * inputDecay
  track.value = target + (track.value - target) * settlingDecay + inputEffect

  if (Math.abs(track.value - target) >= .002 || Math.abs(track.input - target) >= .002) return true

  track.input = target
  track.value = target
  return false
}

export function setupHeroFold(hero: HTMLElement, nav: HTMLElement, motion: MediaQueryList) {
  const sheet = hero.querySelector<HTMLElement>('.hero-sheet')!
  const copy = hero.querySelector<HTMLElement>('.hero-copy')!
  const brand = hero.querySelector<HTMLElement>('.hero-brand')!
  const device = hero.querySelector<HTMLElement>('.hero-device')!
  const nativeScrollTimeline = CSS.supports('animation-timeline', 'scroll(root block)') && CSS.supports('animation-range', '0px 100px')
  const fold: FoldMotion = { input: 0, value: 0 }
  let layout = readLayout()
  let previousScroll = -1
  let foldTarget = 0
  let frame = 0
  let lastTime = 0

  function readLayout() {
    const viewport = window.innerHeight
    const compact = window.innerWidth <= 735
    const copyTop = brand.offsetTop + copy.offsetTop
    // The transparent edge of the phone image leaves room for the heading.
    const phoneTop = device.offsetTop + device.offsetHeight * .044

    return {
      height: hero.offsetHeight,
      foldDistance: Math.max(145, Math.min(215, viewport * .22)),
      approachDistance: Math.max(270, Math.min(435, viewport * .45)),
      driftRatio: compact ? .34 : .29,
      maxTilt: compact ? 0 : 5,
      maxZoom: compact ? .024 : .014,
      copyTop,
      copyRoom: Math.max(0, Math.min(64, phoneTop - copyTop - copy.offsetHeight - 12)),
      navEdge: nav.offsetTop + nav.offsetHeight + 12,
    }
  }

  function render(now: number) {
    frame = 0
    const elapsed = Math.max(0, (now - lastTime) / 1000)
    lastTime = now

    const foldMoving = advanceFold(fold, foldTarget, elapsed)
    const progress = Math.max(0, Math.min(1, fold.value))
    sheet.style.setProperty('--sheet-progress', progress.toFixed(4))

    if (foldMoving) frame = requestAnimationFrame(render)
  }

  function syncScroll() {
    if (!motion.matches) return

    const travel = Math.max(0, Math.min(layout.height, window.scrollY))
    if (travel === previousScroll) return

    previousScroll = travel
    const drift = travel * layout.driftRatio
    const copyLead = Math.max(0, Math.min(layout.copyRoom, layout.navEdge - (layout.copyTop - travel + drift)))
    sheet.style.setProperty('--device-drift', `${drift.toFixed(2)}px`)
    sheet.style.setProperty('--copy-lead', `${copyLead.toFixed(2)}px`)

    // Keep the fallback synchronized to the native scroll while the frame settles independently.
    if (!nativeScrollTimeline) {
      const approach = Math.min(1, travel / layout.approachDistance)
      device.style.setProperty('--device-tilt', `${(approach * layout.maxTilt).toFixed(2)}deg`)
      device.style.setProperty('--device-scale', (1 + approach * layout.maxZoom).toFixed(4))
    }

    const target = Math.min(1, travel / layout.foldDistance)
    if (target === foldTarget && (frame || fold.value === target)) return
    foldTarget = target
    if (!frame) {
      lastTime = performance.now()
      render(lastTime)
    }
  }

  function refreshLayout() {
    layout = readLayout()
    previousScroll = -1
    syncScroll()
  }

  window.addEventListener('scroll', syncScroll, { passive: true })
  window.addEventListener('resize', refreshLayout)
  window.addEventListener('pageshow', syncScroll)
  document.fonts.ready.then(refreshLayout)
  motion.addEventListener('change', () => {
    if (motion.matches) refreshLayout()
    else if (frame) {
      cancelAnimationFrame(frame)
      frame = 0
    }
  })

  syncScroll()
}
