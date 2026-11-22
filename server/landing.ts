import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Hono } from 'hono'

type Bundle = { file: string; css?: string[]; assets?: string[]; imports?: string[] }

export function mountPublicLanding(server: Hono, dist: string) {
  const entry = join(dist, 'conoce/index.html')
  if (!existsSync(entry)) return

  const html = readFileSync(entry, 'utf8')
  const manifest = JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf8')) as Record<string, Bundle>
  const publicAssets = new Set(['/esquora-logo.svg', '/favicon.svg', '/fonts/sofia-sans-latin.woff2'])
  for (const file of readdirSync(join(dist, 'landing'), { withFileTypes: true })) {
    if (file.isFile()) publicAssets.add('/landing/' + file.name)
  }

  // Only expose the marketing entry and its dependencies before the app's access gate.
  function includeBundle(key: string) {
    const chunk = manifest[key]
    if (publicAssets.has('/' + chunk.file)) return
    publicAssets.add('/' + chunk.file)
    for (const file of [...chunk.css ?? [], ...chunk.assets ?? []]) publicAssets.add('/' + file)
    for (const dependency of chunk.imports ?? []) includeBundle(dependency)
  }
  includeBundle('conoce/index.html')

  const staticAsset = serveStatic({ root: dist })
  server.use('*', (c, next) => {
    if (c.req.method === 'GET' && publicAssets.has(c.req.path)) return staticAsset(c, next)
    return next()
  })
  server.get('/conoce', (c) => c.redirect('/conoce/' + new URL(c.req.url).search, 308))
  server.on('GET', ['/', '/conoce/'], (c) => {
    c.header('Cache-Control', 'no-cache')
    c.header('Referrer-Policy', 'same-origin')
    return c.html(html)
  })
}
