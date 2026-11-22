const chapterTiming = [
  { mail: [.04, .24], trace: [.19, .37], code: [.35, .56], access: [.56, .71] },
  { selection: [.02, .18], trace: [.16, .31], signature: [.32, .57], confirmation: [.57, .69] },
  { transfer: [.08, .43], close: [.45, .65], lock: [.65, .75] },
  { trace: [.08, .26], review: [.25, .44], seal: [.43, .51], approval: [.51, .71] },
  { trace: [.07, .33], ledger: [.29, .56], seal: [.55, .61], approval: [.61, .74] },
] as const
const chapterDuration = [1080, 1180, 1110, 890, 930]
const wheelPause = 320

function easeBetween(value: number, start: number, end: number) {
  const progress = Math.max(0, Math.min(1, (value - start) / (end - start)))
  return progress * progress * (3 - 2 * progress)
}

export function setupReservationJourney(section: HTMLElement) {
  const journey = section.querySelector<HTMLElement>('.reservation-journey')!
  const board = journey.querySelector<HTMLElement>('.journey-board')!
  const stage = board.querySelector<HTMLElement>('.journey-stage')!
  const steps = [...board.querySelectorAll<HTMLElement>('.journey-step')]
  const links = [...stage.querySelectorAll<HTMLAnchorElement>('.journey-nav a')]
  const drawings = [...stage.querySelectorAll<SVGGElement>('[data-drawing]')]
  const motion = window.matchMedia('(prefers-reduced-motion: no-preference)')
  const destinations = steps.map(step => step.id)
  journey.style.setProperty('--journey-last-index', String(steps.length - 1))
  const markers = destinations.map((_, index) => {
    const marker = document.createElement('span')
    marker.className = 'journey-marker'
    marker.style.setProperty('--journey-index', String(index))
    marker.setAttribute('aria-hidden', 'true')
    journey.insertBefore(marker, board)
    return marker
  })
  const drawnProgress = drawings.map(() => -1)
  let active = -1
  let scrollFrame = 0
  let playbackFrame = 0
  let queuedChapter = -1
  let hasPlayed = false
  let openingFinished = false
  let enhanced = false
  let inRange = !('IntersectionObserver' in window)
  let stickyTop = 0
  let distance = 0
  let wheelTime = -Infinity
  let wheelDirection = 0
  let wheelConsumed = false
  let nativeWheel = false
  let previousScroll = window.scrollY
  let touch: { x: number; y: number; scrolling: boolean; consumed: boolean; until: number } | undefined

  function showChapter(index: number) {
    if (active === index) return
    steps[active]?.removeAttribute('data-current')
    links[active]?.removeAttribute('aria-current')
    steps[index].setAttribute('data-current', '')
    links[index].setAttribute('aria-current', 'step')
    drawings.forEach((drawing, position) => drawing.toggleAttribute('data-layer', position === index))
    stage.dataset.beat = String(index)
    active = index
  }

  function paintChapter(index: number, progress: number) {
    if (drawnProgress[index] === progress) return
    drawnProgress[index] = progress
    for (const [cue, [start, end]] of Object.entries(chapterTiming[index])) {
      drawings[index].style.setProperty(`--${cue}`, easeBetween(progress, start, end).toFixed(3))
    }
  }

  function stopPlayback() {
    if (playbackFrame) window.cancelAnimationFrame(playbackFrame)
    playbackFrame = 0
    queuedChapter = -1
    stage.style.removeProperty('--journey-art-light')
  }

  function play(index: number) {
    stopPlayback()
    hasPlayed = true
    openingFinished = index !== 0 || !motion.matches
    showChapter(index)
    if (!motion.matches) {
      paintChapter(index, 1)
      return
    }

    paintChapter(index, 0)
    stage.style.setProperty('--journey-art-light', '.78')
    const started = performance.now()
    const duration = chapterDuration[index]

    function tick(now: number) {
      const progress = Math.max(0, Math.min(1, (now - started) / duration))
      paintChapter(index, Math.min(.76, progress * .9))
      stage.style.setProperty('--journey-art-light', (.78 + .22 * easeBetween(progress, 0, .16)).toFixed(3))
      if (progress < 1 && motion.matches) {
        playbackFrame = window.requestAnimationFrame(tick)
        return
      }

      playbackFrame = 0
      paintChapter(index, 1)
      openingFinished = true
      stage.style.removeProperty('--journey-art-light')
      const next = queuedChapter
      queuedChapter = -1
      if (next >= 0 && enhanced && inRange) {
        const position = travel()
        if (position >= 4 && position <= trackEnd()) jumpTo(next)
      }
    }

    playbackFrame = window.requestAnimationFrame(tick)
  }

  function travel() {
    return stickyTop - journey.getBoundingClientRect().top
  }

  function trackEnd() {
    return distance * (steps.length - 1) + 28
  }

  function render() {
    scrollFrame = 0
    if (!enhanced) return

    const position = travel()
    const bounds = board.getBoundingClientRect()
    const visible = bounds.bottom <= window.innerHeight && bounds.top >= 0
    const index = Math.max(0, Math.min(steps.length - 1, Math.round((position - 8) / distance)))
    if (!openingFinished && index === 0) {
      if (visible && position >= 0 && position <= trackEnd() && !hasPlayed) play(0)
      else if (active === -1) {
        showChapter(0)
        paintChapter(0, motion.matches ? 0 : 1)
      }
      return
    }
    if (visible && index !== active) play(index)
  }

  function schedule() {
    if (!scrollFrame && enhanced && inRange) scrollFrame = window.requestAnimationFrame(render)
  }

  function jumpTo(index: number, replay = true) {
    const top = window.scrollY + markers[index].getBoundingClientRect().top - stickyTop
    window.scrollTo({ top, behavior: 'instant' })
    previousScroll = window.scrollY
    if (replay || active !== index || !hasPlayed) play(index)
  }

  function gesture(direction: number, reach: number, position = travel()) {
    if (!enhanced) return false

    const end = trackEnd()
    if (position < 4) {
      if (direction < 0 || position < -reach) return false
      jumpTo(0, false)
      return true
    }
    if (position > end) {
      if (direction > 0 || position > end + reach) return false
      jumpTo(steps.length - 1, false)
      return true
    }

    if (!openingFinished) {
      if (direction < 0) return false
      jumpTo(0, false)
      return true
    }
    const next = active + direction
    // Let the agreement and the final receipt finish before moving past them.
    if (direction > 0 && playbackFrame && (active === 1 || next === steps.length)) return true
    if (next < 0 || next >= steps.length) return false
    if (playbackFrame) queuedChapter = next
    else jumpTo(next)
    return true
  }

  function boardFits() {
    const height = board.offsetHeight
    const recordedHeight = `${height}px`
    if (journey.style.getPropertyValue('--journey-board-height') !== recordedHeight) {
      journey.style.setProperty('--journey-board-height', recordedHeight)
    }
    stickyTop = parseFloat(getComputedStyle(board).top)
    return height + stickyTop <= window.innerHeight - 8
  }

  function measure() {
    if (scrollFrame) window.cancelAnimationFrame(scrollFrame)
    scrollFrame = 0
    journey.setAttribute('data-journey-ready', '')
    journey.removeAttribute('data-journey-compact')
    let fits = boardFits()
    if (!fits) {
      journey.setAttribute('data-journey-compact', '')
      fits = boardFits()
      if (!fits) journey.removeAttribute('data-journey-compact')
    }
    journey.toggleAttribute('data-journey-ready', fits)
    if (enhanced !== fits) {
      enhanced = fits
      destinations.forEach((id, index) => {
        const [from, to] = fits ? [steps[index], markers[index]] : [markers[index], steps[index]]
        from.removeAttribute('id')
        to.id = id
      })
    }
    if (enhanced) {
      distance = markers[1].offsetTop - markers[0].offsetTop
      render()
    } else {
      stopPlayback()
      links[active]?.removeAttribute('aria-current')
      steps[active]?.removeAttribute('data-current')
      drawings[active]?.removeAttribute('data-layer')
      drawings[0].setAttribute('data-layer', '')
      paintChapter(0, 1)
      stage.dataset.beat = '0'
      active = -1
      hasPlayed = false
      openingFinished = false
    }
  }

  measure()
  const initialDestination = destinations.indexOf(location.hash.slice(1))
  if (enhanced && initialDestination !== -1) {
    window.requestAnimationFrame(() => {
      if (location.hash === `#${destinations[initialDestination]}`) {
        jumpTo(initialDestination)
      }
    })
  }

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(([entry]) => {
      inRange = entry.isIntersecting
      if (inRange) schedule()
      else if (playbackFrame) {
        stopPlayback()
        if (openingFinished) paintChapter(active, 1)
        else {
          hasPlayed = false
          paintChapter(0, 0)
        }
      }
    }, { rootMargin: '100px 0px' })
    observer.observe(journey)
  }
  window.addEventListener('scroll', handleScroll, { passive: true })
  window.addEventListener('resize', measure)
  window.addEventListener('pageshow', schedule)
  motion.addEventListener('change', () => {
    if (enhanced && active >= 0 && !motion.matches) {
      stopPlayback()
      openingFinished = true
      paintChapter(active, 1)
    }
    schedule()
  })

  links.forEach((link, index) => link.addEventListener('click', event => {
    if (!enhanced || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    touch = undefined
    nativeWheel = false
    if (location.hash !== link.hash) window.history.pushState(history.state, '', link.hash)
    jumpTo(index)
  }))

  function handleWheel(event: WheelEvent) {
    if (!enhanced || event.defaultPrevented || event.ctrlKey) return
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    const direction = Math.sign(event.deltaY)
    const now = event.timeStamp
    if (direction !== wheelDirection || now - wheelTime > wheelPause) wheelConsumed = false
    wheelTime = now
    wheelDirection = direction
    touch = undefined
    nativeWheel = !event.cancelable
    if (nativeWheel) return
    if (!wheelConsumed) wheelConsumed = gesture(direction, Math.abs(event.deltaY) * units)
    if (wheelConsumed) event.preventDefault()
  }

  function beginTouch(event: TouchEvent) {
    const finger = event.touches[0]
    nativeWheel = false
    touch = enhanced && event.touches.length === 1
      ? { x: finger.clientX, y: finger.clientY, scrolling: false, consumed: false, until: Infinity }
      : undefined
  }

  function handleTouch(event: TouchEvent) {
    if (!touch || event.touches.length !== 1) return
    const finger = event.touches[0]
    const vertical = touch.y - finger.clientY
    if (Math.abs(vertical) >= 5 && Math.abs(vertical) > Math.abs(touch.x - finger.clientX)) {
      touch.scrolling = true
      if (event.cancelable && !touch.consumed) touch.consumed = gesture(Math.sign(vertical), Math.abs(vertical))
    }
    if (touch.consumed && event.cancelable) event.preventDefault()
  }

  function endTouch() {
    if (touch?.scrolling) touch.until = performance.now() + wheelPause
    else touch = undefined
  }

  function handleScroll() {
    const offset = window.scrollY
    const delta = offset - previousScroll
    previousScroll = offset
    const now = performance.now()
    if (enhanced && delta) {
      // Touch momentum and some wheel sequences have already scrolled by the time we see them.
      const direction = Math.sign(delta)
      if (touch?.scrolling && now <= touch.until) {
        if (touch.until !== Infinity) touch.until = now + wheelPause
        if (touch.consumed || gesture(direction, Math.abs(delta), travel() - delta)) {
          touch.consumed = true
          jumpTo(active, false)
        }
      } else if (nativeWheel && now - wheelTime <= wheelPause && direction === wheelDirection) {
        if (wheelConsumed || gesture(direction, Math.abs(delta), travel() - delta)) {
          wheelConsumed = true
          jumpTo(active, false)
        }
      }
    }
    schedule()
  }

  window.addEventListener('wheel', handleWheel, { passive: false })
  window.addEventListener('touchstart', beginTouch, { passive: true })
  window.addEventListener('touchmove', handleTouch, { passive: false })
  window.addEventListener('touchend', endTouch, { passive: true })
  window.addEventListener('touchcancel', endTouch, { passive: true })

  window.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.target instanceof Element) {
      if (event.target.closest('input,select,textarea,[contenteditable]')) return
      if (event.key === ' ' && event.target.closest('button,summary')) return
    }
    const direction = event.key === 'ArrowDown' || event.key === 'PageDown' ? 1
      : event.key === 'ArrowUp' || event.key === 'PageUp' ? -1
      : event.key === ' ' ? (event.shiftKey ? -1 : 1) : 0
    if (direction) {
      touch = undefined
      nativeWheel = false
      const reach = event.key.startsWith('Arrow') ? 40 : window.innerHeight
      if (gesture(direction, reach)) event.preventDefault()
    }
  })
  document.fonts.ready.then(measure)
}
