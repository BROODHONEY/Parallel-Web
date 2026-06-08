import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { queryRouter }  from './routes/query'
import { entryRouter }  from './routes/entry'
import { agentsRouter } from './routes/agents'
import { feedRouter, corroborateRouter }   from './routes/feed'
import { peersRouter }  from './routes/peers'
import { flagRouter }   from './routes/flag'
import { syncAllPeers } from './sync'
import 'dotenv/config'

const app = new Hono()

app.route('/query',       queryRouter)
app.route('/entry',       entryRouter)
app.route('/agents',      agentsRouter)
app.route('/feed',        feedRouter)
app.route('/corroborate', corroborateRouter)  
app.route('/peers',       peersRouter)
app.route('/flag',        flagRouter)

app.get('/health', (c) => c.json({
  status:    'ok',
  timestamp: new Date().toISOString(),
  node:      'awp-prototype-v0.3',
  layer:     3,
}))

app.notFound((c) => c.json({ error: 'Not found' }, 404))

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, async () => {
  console.log(`\nAWP node running — Layer 3`)
  console.log(`  http://localhost:${port}/health`)
  console.log(`  http://localhost:${port}/feed`)
  console.log(`  http://localhost:${port}/peers\n`)

  // Run federation sync on startup
  await syncAllPeers()

  // Then sync every 30 minutes
  setInterval(() => {
    syncAllPeers().catch(console.error)
  }, 30 * 60 * 1000)
})