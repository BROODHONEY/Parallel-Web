import { getPeers, updateLastSynced } from './db/peers'
import { writeEntry } from './db/entries'
import { embed } from './pipeline/embed'
import 'dotenv/config'

interface FeedEntry {
  id:                  string
  topic:               string
  facts:               any[]
  source_url:          string
  fetched_at:          string
  extraction_quality:  number | null
  volatility_class:    string | null
}

/**
 * Pull new entries from a single peer node's /feed endpoint.
 * Only imports entries we don't already have (checks source_url).
 */
async function syncPeer(peer: { id: string; name: string; url: string; last_synced: string | null }) {
  const since = peer.last_synced
    ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days back on first sync

  const feedUrl = `${peer.url}/feed?since=${encodeURIComponent(since)}&limit=100`

  console.log(`Syncing ${peer.name} (${peer.url}) since ${since}`)

  let feedData: any
  try {
    const response = await fetch(feedUrl, {
      headers: { 'User-Agent': 'AWP-Federation/0.1' },
      signal:  AbortSignal.timeout(30000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    feedData = await response.json()
  } catch (err: any) {
    console.warn(`  Failed to fetch feed from ${peer.name}: ${err.message}`)
    return 0
  }

  const entries: FeedEntry[] = feedData.entries ?? []
  console.log(`  Got ${entries.length} entries from ${peer.name}`)

  let imported = 0

  for (const entry of entries) {
    try {
      // Embed the topic string for semantic search
      const embedding = await embed(entry.topic)

      await writeEntry({
        topic:              entry.topic,
        facts:              entry.facts,
        source_url:         entry.source_url,
        embedding,
        extraction_quality: entry.extraction_quality ?? undefined,
        volatility_class:   entry.volatility_class   ?? undefined,
      })

      imported++
    } catch (err: any) {
      // upsert handles duplicates — other errors log and continue
      if (!err.message.includes('duplicate')) {
        console.warn(`  Failed to import entry "${entry.topic}": ${err.message}`)
      }
    }
  }

  await updateLastSynced(peer.id, imported)
  console.log(`  Imported ${imported} new entries from ${peer.name}`)
  return imported
}

/**
 * Sync all peer nodes.
 * Called on startup and every 30 minutes.
 */
export async function syncAllPeers(): Promise<void> {
  let peers: any[]
  try {
    peers = await getPeers()
  } catch (err: any) {
    console.warn('Could not load peers:', err.message)
    return
  }

  if (peers.length === 0) {
    console.log('No peers configured — skipping sync')
    return
  }

  console.log(`\nFederation sync — ${peers.length} peer(s)`)
  let total = 0
  for (const peer of peers) {
    total += await syncPeer(peer)
  }
  console.log(`Federation sync complete — ${total} total entries imported\n`)
}