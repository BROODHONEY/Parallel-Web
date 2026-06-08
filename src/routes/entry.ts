import { Hono } from 'hono'
import { requireAuth, requireWriteAccess } from '../middleware/auth'
import { writeEntry, getEntry } from '../db/entries'
import { recordWrite } from '../db/agents'
import { embed } from '../pipeline/embed'
import type { Fact } from '../db/types'

export const entryRouter = new Hono()

/**
 * GET /entry/:id — fetch a single entry by ID (open)
 */
entryRouter.get('/:id', async (c) => {
  const id    = c.req.param('id')
  const entry = await getEntry(id)

  if (!entry) {
    return c.json({ error: `Entry not found: ${id}` }, 404)
  }

  return c.json(entry)
})

/**
 * POST /entry — write a new entry directly (trusted agents only)
 * 
 * This is for agents that have already extracted facts themselves
 * and want to contribute directly to the index.
 */
entryRouter.post('/', requireAuth, requireWriteAccess, async (c) => {
  const agent = c.get('agent')

  let body: {
    topic?:      string
    facts?:      Fact[]
    source_url?: string
    volatility_class?: string
  }

  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Request body must be valid JSON' }, 400)
  }

  // Validate required fields
  if (!body.topic?.trim()) {
    return c.json({ error: 'topic is required' }, 400)
  }

  if (!Array.isArray(body.facts) || body.facts.length === 0) {
    return c.json({ error: 'facts must be a non-empty array' }, 400)
  }

  if (!body.source_url?.startsWith('http')) {
    return c.json({ error: 'source_url must be a valid URL starting with http' }, 400)
  }

  try {
    // Embed the topic
    const embedding = await embed(body.topic.trim())

    // Write entry — agent_id and agent_trust stored for provenance
    const entry = await writeEntry({
      topic:            body.topic.trim(),
      facts:            body.facts,
      source_url:       body.source_url,
      embedding,
      volatility_class: body.volatility_class ?? 'medium',
    })

    // Record the write against this agent's stats
    await recordWrite(agent.id)

    return c.json({
      message:    'Entry written successfully',
      id:         entry.id,
      topic:      entry.topic,
      facts:      entry.facts.length,
      written_by: agent.name,
      trust_used: agent.trust_score,
    }, 201)

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

