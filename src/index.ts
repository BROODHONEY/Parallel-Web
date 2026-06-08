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

app.get('/debug', async (c) => {
  const q = c.req.query('q')
  if (!q) return c.json({ error: 'q required' }, 400)

  const { embed } = await import('./pipeline/embed')
  const { db }    = await import('./db/client')

  const queryEmbedding = await embed(q)

  const { data: queryMatches } = await db.rpc('search_queries', {
    query_embedding: queryEmbedding,
    match_threshold: 0.0,
    match_count: 5,
  })

  const { data: entryMatches } = await db.rpc('search_entries', {
    query_embedding: queryEmbedding,
    match_threshold: 0.0,
    match_count: 5,
  })

  return c.json({
    query: q,
    query_matches: (queryMatches ?? []).map((r: any) => ({
      query_text: r.query_text,
      similarity: Number(r.similarity.toFixed(4)),
    })),
    entry_matches: (entryMatches ?? []).map((r: any) => ({
      topic:      r.topic,
      similarity: Number(r.similarity.toFixed(4)),
    })),
    thresholds: {
      query_table:  0.82,
      entries_table: 0.78,
      hard_gate:    0.78,
    }
  })
})

// Clean orphaned query rows on startup
async function cleanOrphanedQueries() {
  const { db } = await import('./db/client')
  const { error } = await db.rpc('cleanup_orphaned_queries')
  if (!error) console.log('Orphaned queries cleaned ✓')
}


app.notFound((c) => c.json({ error: 'Not found' }, 404))

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, async () => {
  console.log(`\nAWP node running — Layer 3`)
  console.log(`  http://localhost:${port}/health`)
  console.log(`  http://localhost:${port}/feed`)
  console.log(`  http://localhost:${port}/peers\n`)

  // clear orphaned queries that reference deleted entries
  await cleanOrphanedQueries()

  // Run federation sync on startup
  await syncAllPeers()

  // Then sync every 30 minutes
  setInterval(() => {
    syncAllPeers().catch(console.error)
  }, 30 * 60 * 1000)
})
