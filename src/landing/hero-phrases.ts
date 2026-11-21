export function setupHeroPhrases(group: HTMLElement, motion: MediaQueryList) {
  const phrases = [...group.querySelectorAll<HTMLElement>('[data-phrase]')]
  let current = 0
  let visible = false
  let paused = false
  let timer = 0
  let nextDelay = 4500

  function showNext() {
    timer = 0
    const leaving = phrases[current]
    current = (current + 1) % phrases.length
    const arriving = phrases[current]
    leaving.removeAttribute('data-current')
    arriving.setAttribute('data-current', '')
    leaving.animate([
      { translate: '0 0', opacity: 1 },
      { translate: '0 -88%', opacity: 0 },
    ], { duration: 235, easing: 'cubic-bezier(.45, 0, .85, .45)' })
    arriving.animate([
      { translate: '0 92%', opacity: 0 },
      { translate: '0 0', opacity: 1 },
    ], { delay: 85, duration: 430, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' })

    nextDelay = 3500
    sync()
  }

  function sync() {
    const canPlay = motion.matches && visible && !paused && !document.hidden
    if (!canPlay) {
      window.clearTimeout(timer)
      timer = 0
      for (const animation of group.getAnimations({ subtree: true })) animation.cancel()
    } else if (!timer) {
      timer = window.setTimeout(showNext, nextDelay)
    }
  }

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting && entry.intersectionRatio >= .6
    sync()
  }, { threshold: .6 }).observe(group)
  document.addEventListener('visibilitychange', sync)
  motion.addEventListener('change', () => {
    if (!motion.matches) {
      phrases[current].removeAttribute('data-current')
      current = 0
      phrases[0].setAttribute('data-current', '')
    }
    sync()
  })

  return (value: boolean) => {
    paused = value
    sync()
  }
}
