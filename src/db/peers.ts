import { db } from './client'

export interface Peer {
  id:           string
  name:         string
  url:          string
  last_synced:  string | null
  entry_count:  number
  trusted:      boolean
}

export async function getPeers(): Promise<Peer[]> {
  const { data, error } = await db
    .from('peers')
    .select('*')
    .order('added_at', { ascending: true })

  if (error) throw new Error(`Failed to get peers: ${error.message}`)
  return (data ?? []) as Peer[]
}

export async function addPeer(name: string, url: string): Promise<Peer> {
  const cleanUrl = url.replace(/\/$/, '')

  const { data, error } = await db
    .from('peers')
    .insert({ name, url: cleanUrl })
    .select()
    .single()

  if (error) throw new Error(`Failed to add peer: ${error.message}`)
  return data as Peer
}

export async function updateLastSynced(
  peerId: string,
  entryCount: number
): Promise<void> {
  await db
    .from('peers')
    .update({
      last_synced:  new Date().toISOString(),
      entry_count:  entryCount,
    })
    .eq('id', peerId)
}