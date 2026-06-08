import { Hono } from 'hono'
import { requireAuth, requireWriteAccess } from '../middleware/auth'
import { getPeers, addPeer } from '../db/peers'
import { syncAllPeers } from '../sync'

export const peersRouter = new Hono()

/**
 * GET /peers — list all peer nodes (open)
 */
peersRouter.get('/', async (c) => {
  const peers = await getPeers()
  return c.json({ peers, count: peers.length })
})

/**
 * POST /peers — add a new peer node (owner only)
 * Body: { name, url }
 */
peersRouter.post('/', requireAuth, requireWriteAccess, async (c) => {
  const agent = c.get('agent')

  // Only owners can add peers
  if (agent.tier !== 'owner') {
    return c.json({ error: 'Only node owners can add peers' }, 403)
  }

  let body: { name?: string; url?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Request body must be valid JSON' }, 400)
  }

  if (!body.name?.trim() || !body.url?.trim()) {
    return c.json({ error: 'name and url are required' }, 400)
  }

  if (!body.url.startsWith('http')) {
    return c.json({ error: 'url must start with http or https' }, 400)
  }

  try {
    // Verify the peer node is reachable before adding
    const healthUrl = `${body.url.replace(/\/$/, '')}/health`
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`Peer health check failed: ${res.status}`)
  } catch (err: any) {
    return c.json({
      error:   'Peer node is not reachable',
      details: err.message,
      tip:     'Make sure the peer node is running and its /health endpoint responds'
    }, 400)
  }

  const peer = await addPeer(body.name.trim(), body.url.trim())

  return c.json({
    message: 'Peer added successfully',
    peer,
    tip:     'Federation sync runs every 30 minutes. Trigger manually with POST /peers/sync'
  }, 201)
})

/**
 * POST /peers/sync — manually trigger federation sync (owner only)
 */
peersRouter.post('/sync', requireAuth, async (c) => {
  const agent = c.get('agent')
  if (agent.tier !== 'owner') {
    return c.json({ error: 'Only owners can trigger sync' }, 403)
  }

  // Fire and forget — don't await, return immediately
  syncAllPeers().catch(console.error)

  return c.json({
    message: 'Federation sync started',
    tip:     'Check server logs for sync progress'
  })
})