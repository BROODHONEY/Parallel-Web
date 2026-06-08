import { Hono } from 'hono'
import { embed } from '../pipeline/embed'
import { webSearch, fetchAndStrip } from '../pipeline/search'
import { extractFacts } from '../pipeline/extract'
import { searchEntries, writeEntry, searchQueries, writeQuery, getEntry, findBestMatch } from '../db/entries'
import { computeConfidence, isStale, confidenceLabel } from '../pipeline/confidence'
import { getFlagCount } from '../db/flags'

export const queryRouter = new Hono()

queryRouter.get('/', async (c) => {
  const q = c.req.query('q')

  if (!q || q.trim() === '') {
    return c.json({ error: 'q parameter is required. Usage: /query?q=your+question' }, 400)
  }

  // If agent provided a key, record the query for trust purposes
  const apiKey = c.req.header('X-AWP-Key') 
    ?? c.req.header('Authorization')?.replace('Bearer ', '')

  if (apiKey) {
    const { getAgentByKey, recordQuery } = await import('../db/agents')
    const agent = await getAgentByKey(apiKey)
    if (agent) recordQuery(agent.id).catch(() => {})  // fire and forget
  }

  try {

    const queryEmbedding = await embed(q)

    // Catches rephrased questions about the same topic
    const matchedEntryId = await searchQueries(queryEmbedding)

    if (matchedEntryId) {
      const entry = await getEntry(matchedEntryId)

      if (entry) {
        const flagCount  = await getFlagCount(entry.id)
        const confidence = computeConfidence({
          source_url:         entry.source_url,
          fetched_at:         entry.fetched_at,
          extraction_quality: (entry as any).extraction_quality ?? null,
          volatility_class:   (entry as any).volatility_class   ?? null,
          flag_count:         flagCount,
          corroboration_count: (entry as any).corroboration_count ?? 0,
        })

        if (!isStale(confidence)) {
          console.log(`Query cache hit: "${q}" → "${entry.topic}" (confidence: ${confidence}, flags: ${flagCount})`)

          // Store this variant so future similar queries also match
          await writeQuery(entry.id, q, queryEmbedding)

          return c.json({
            hit:              true,
            source:           'cache',
            id:               entry.id,
            topic:            entry.topic,
            facts:            entry.facts,
            source_url:       entry.source_url,
            fetched_at:       entry.fetched_at,
            confidence,
            confidence_label: confidenceLabel(confidence),
            flag_count:       flagCount,
          })
        }

        console.log(`Query matched but stale (confidence: ${confidence}, flags: ${flagCount}) — re-fetching...`)
      }
    }

    const results = await searchEntries(queryEmbedding)

    if (results.length > 0) {
      const best      = results[0]
      const flagCount = await getFlagCount(best.id)

      const confidence = computeConfidence({
        source_url:         best.source_url,
        fetched_at:         best.fetched_at,
        extraction_quality: (best as any).extraction_quality ?? null,
        volatility_class:   (best as any).volatility_class   ?? null,
        flag_count:         flagCount,
        corroboration_count: (best as any).corroboration_count ?? 0,
      })

      console.log(`Topic cache hit: "${best.topic}" (similarity: ${best.similarity?.toFixed(3)}, confidence: ${confidence}, flags: ${flagCount})`)

      if (!isStale(confidence)) {
        await writeQuery(best.id, q, queryEmbedding)

        return c.json({
          hit:              true,
          source:           'cache',
          id:               best.id,
          topic:            best.topic,
          facts:            best.facts,
          source_url:       best.source_url,
          fetched_at:       best.fetched_at,
          similarity:       best.similarity,
          confidence,
          confidence_label: confidenceLabel(confidence),
          flag_count:       flagCount,
        })
      }

      console.log(`Entry stale (confidence: ${confidence}, flags: ${flagCount}) — re-fetching...`)
    }

    console.log(`Web fetch for: "${q}"`)

    const urls = await webSearch(q)
    if (urls.length === 0) {
      return c.json({ error: `No sources found for: "${q}"` }, 404)
    }

    const targetUrl = urls[0]
    console.log(`  Source: ${targetUrl}`)

    const strippedText = await fetchAndStrip(targetUrl)

    console.log('  Extracting facts...')
    const extracted = await extractFacts(targetUrl, strippedText)
    console.log(`  Topic: "${extracted.topic}" — ${extracted.facts.length} facts`)
    console.log(`  Quality: ${extracted.extraction_quality}, Volatility: ${extracted.volatility_class}`)

    const topicEmbedding = await embed(extracted.topic)

    const entry = await writeEntry({
      topic:              extracted.topic,
      facts:              extracted.facts,
      source_url:         targetUrl,
      embedding:          topicEmbedding,
      extraction_quality: extracted.extraction_quality,
      volatility_class:   extracted.volatility_class,
    })

    await writeQuery(entry.id, q, queryEmbedding)

    const confidence = computeConfidence({
      source_url:         entry.source_url,
      fetched_at:         entry.fetched_at,
      extraction_quality: extracted.extraction_quality,
      volatility_class:   extracted.volatility_class,
      flag_count:         0,
      corroboration_count: (entry as any).corroboration_count ?? 0,
    })

    console.log(`  Written: ${entry.id} (confidence: ${confidence})`)

    return c.json({
      hit:              false,
      source:           'web',
      id:               entry.id,
      topic:            entry.topic,
      facts:            entry.facts,
      source_url:       entry.source_url,
      fetched_at:       entry.fetched_at,
      confidence,
      confidence_label: confidenceLabel(confidence),
      flag_count:       0,
    })

  } catch (err: any) {
    console.error('Query error:', err.message)
    return c.json({ error: err.message }, 500)
  }
})