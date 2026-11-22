import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Hono } from 'hono'

export function mountWebPages(server: Hono, dist: string) {
  const landing = join(dist, 'conoce/index.html')
  if (existsSync(landing)) {
    const html = readFileSync(landing, 'utf8')
    server.get('/conoce', (c) => c.redirect('/conoce/' + new URL(c.req.url).search, 308))
    server.on('GET', ['/', '/conoce/'], (c) => {
      c.header('Cache-Control', 'no-cache')
      c.header('Referrer-Policy', 'same-origin')
      return c.html(html)
    })
  }

  const entry = join(dist, 'index.html')
  if (!existsSync(entry)) return
  const index = readFileSync(entry, 'utf8')
  // Las rutas de la API se registran antes. Una ruta desconocida nunca devuelve la SPA.
  server.all('/api/*', (c) => c.notFound())
  server.all('/.vite/*', (c) => c.notFound())
  server.use('/*', serveStatic({ root: dist }))
  server.get('*', (c) => {
    if (c.req.path.startsWith('/assets/')) return c.notFound()
    c.header('Cache-Control', 'no-cache')
    c.header('Referrer-Policy', 'same-origin')
    return c.html(index)
  })
}
