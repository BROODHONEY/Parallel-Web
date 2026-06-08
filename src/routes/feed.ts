import { Hono } from 'hono'
import { db } from '../db/client'

export const feedRouter = new Hono()

/**
 * GET /feed?since=ISO_TIMESTAMP&limit=50
 *
 * Returns entries created or updated since the given timestamp.
 * Used by peer nodes to sync knowledge from this node.
 * Open — no auth required. Reading is always free.
 */
feedRouter.get('/', async (c) => {
  const sinceParam = c.req.query('since')
  const limitParam = c.req.query('limit')

  // Default to last 24 hours if no since provided
  const since = sinceParam
    ? new Date(sinceParam).toISOString()
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Cap at 100 entries per request — prevents abuse
  const limit = Math.min(100, Math.max(1, parseInt(limitParam ?? '50', 10) || 50))

  const { data, error } = await db
    .from('entries')
    .select(`
      id,
      topic,
      facts,
      source_url,
      fetched_at,
      extraction_quality,
      volatility_class,
      corroboration_count
    `)
    .gte('fetched_at', since)
    .order('fetched_at', { ascending: true })
    .limit(limit)

  if (error) {
    return c.json({ error: 'Feed fetch failed: ' + error.message }, 500)
  }

  return c.json({
    node:         'awp-net.up.railway.app',
    since,
    limit,
    count:        data.length,
    entries:      data,
    next_since:   data.length > 0
      ? data[data.length - 1].fetched_at
      : since,
  })
})

/**
 * POST /corroborate
 *
 * A peer node tells us they independently found the same fact
 * from a different source. We increment the corroboration count
 * on that entry — raising its confidence score.
 *
 * Body: { entry_id, source_url, peer_url }
 */
export const corroborateRouter = new Hono()

corroborateRouter.post('/', async (c) => {
  let body: {
    entry_id?: string
    source_url?: string
    peer_url?: string
  }

  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Request body must be valid JSON' }, 400)
  }

  if (!body.entry_id || !body.source_url || !body.peer_url) {
    return c.json({
      error: 'Missing required fields: entry_id, source_url, peer_url'
    }, 400)
  }

  // Verify the entry exists
  const { data: entry, error: entryError } = await db
    .from('entries')
    .select('id, topic, corroboration_count')
    .eq('id', body.entry_id)
    .single()

  if (entryError || !entry) {
    return c.json({ error: `Entry not found: ${body.entry_id}` }, 404)
  }

  // Record the corroboration (unique per peer per entry)
  const { error: insertError } = await db
    .from('corroborations')
    .insert({
      entry_id:   body.entry_id,
      peer_url:   body.peer_url,
      source_url: body.source_url,
    })

  if (insertError) {
    // Duplicate — this peer already corroborated this entry
    if (insertError.code === '23505') {
      return c.json({
        message:            'Already corroborated by this peer',
        corroboration_count: entry.corroboration_count,
      })
    }
    return c.json({ error: 'Corroboration failed: ' + insertError.message }, 500)
  }

  // Increment the count on the entry
  await db.rpc('increment_corroboration', { target_entry_id: body.entry_id })

  return c.json({
    message:             'Corroboration recorded',
    entry_id:            body.entry_id,
    topic:               entry.topic,
    corroboration_count: (entry.corroboration_count ?? 0) + 1,
  }, 201)
})