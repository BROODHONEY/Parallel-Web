import { db } from './client'
import type { Entry, NewEntry } from './types'

/**
 * Semantic search against the entries table.
 * Calls the search_entries Postgres function we created in Supabase.
 */
export async function searchEntries(
  embedding: number[],
  threshold = 0.78,
  limit = 3
): Promise<Entry[]> {
  const { data, error } = await db.rpc('search_entries', {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: limit,
  })

  if (error) throw new Error(`Search failed: ${error.message}`)
  return (data ?? []) as Entry[]
}

/**
 * Write a new entry to the index.
 */
export async function writeEntry(entry: NewEntry): Promise<Entry> {
  // Upsert on source_url — if it exists, update it; if not, create it
  // This is atomic and prevents race condition duplicates
  const { data, error } = await db
    .from('entries')
    .upsert(
      {
        topic:              entry.topic,
        facts:              entry.facts,
        source_url:         entry.source_url,
        embedding:          entry.embedding,
        fetched_at:         new Date().toISOString(),
        extraction_quality: entry.extraction_quality ?? null,
        volatility_class:   entry.volatility_class   ?? null,
      },
      {
        onConflict: 'source_url',   // unique constraint we added earlier
        ignoreDuplicates: false,    // update if exists
      }
    )
    .select()
    .single()

  if (error) throw new Error(`Write failed: ${error.message}`)
  return data as Entry
}

/**
 * Fetch one entry by ID.
 * Returns null if not found — callers should handle this gracefully.
 */
export async function getEntry(id: string): Promise<Entry | null> {
  const { data, error } = await db
    .from('entries')
    .select('*')
    .eq('id', id)
    .single()

  if (error) return null
  return data as Entry
}

/**
 * Store the query string that produced an entry.
 * Used to match future similar questions to existing entries.
 */
export async function writeQuery(
  entryId: string,
  queryText: string,
  embedding: number[]
): Promise<void> {
  // Verify the entry actually exists before storing the query
  const { data: entryExists } = await db
    .from('entries')
    .select('id')
    .eq('id', entryId)
    .single()

  if (!entryExists) {
    console.warn(`  Skipping writeQuery — entry ${entryId} does not exist`)
    return
  }

  const { error } = await db
    .from('queries')
    .insert({ entry_id: entryId, query_text: queryText, embedding })

  if (error) {
    console.error('writeQuery FAILED:', error.message)
  } else {
    console.log(`  Query stored: "${queryText.slice(0, 60)}"`)
  }
}

/**
 * Search stored queries by semantic similarity.
 * Returns the entry_id of the best matching previous query.
 */
export async function searchQueries(
  embedding: number[],
  threshold = 0.82
): Promise<{ entryId: string; similarity: number } | null> {
  const { data, error } = await db.rpc('search_queries', {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: 1,
  })

  if (error || !data || data.length === 0) return null
  return {
    entryId:    data[0].entry_id as string,
    similarity: data[0].similarity as number,
  }
}

/**
 * Unified lookup — tries query table first, then topic embeddings.
 * Returns the best matching entry or null if nothing found.
 */
export async function findBestMatch(
  embedding: number[]
): Promise<{ entry: Entry; matchedVia: 'query' | 'topic' } | null> {
  const queryMatch = await searchQueries(embedding, 0.82)  // was 0.65
  if (queryMatch && queryMatch.similarity >= 0.82) {
    const entry = await getEntry(queryMatch.entryId)
    if (entry) return { entry, matchedVia: 'query' }
  }

  const entryResults = await searchEntries(embedding, 0.78, 3)  // was 0.55
  if (entryResults.length > 0 && (entryResults[0].similarity ?? 0) >= 0.78) {
    return { entry: entryResults[0], matchedVia: 'topic' }
  }

  return null
}