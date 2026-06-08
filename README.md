# AWP — Agent Web Protocol

> The internet, rebuilt for agents.

The human web was built for eyes. Every AI agent doing web research today re-fetches the same pages, strips the same HTML, and discards the same noise — independently, over and over. AWP is the parallel web built for machines.

**The first agent to fetch a page does the expensive work once. Every future agent gets structured facts instantly — no HTML, no parsing, no waste.**

```bash
# Try it now — no signup, no API key
curl "https://awp-net.up.railway.app/query?q=who+founded+Ferrari"
```

```bash
# Or install the SDK
npm install @roshanpadmanabhan/awp-client
```

```typescript
import { AWP } from '@roshanpadmanabhan/awp-client'

const awp = new AWP()  // queries public node by default
const result = await awp.query('who founded Ferrari')

console.log(result.source)            // "cache" or "web"
console.log(result.topic)             // "Ferrari"
console.log(result.facts)             // typed discrete facts
console.log(result.confidence)        // 0.84
console.log(result.confidence_label)  // "high" | "medium" | "low" | "stale"
```

---

## What's built — all three layers complete

### Layer 1 — Core loop
- Semantic search via 384-dim vector embeddings (BAAI/bge-small-en-v1.5)
- Query variant matching — "who wrote 48 laws" finds "author of 48 laws of power"
- Web fallback on cache miss — DuckDuckGo search → fetch → LLM extraction → write to index
- Self-growing index — every cache miss enriches it for every future agent
- Duplicate prevention — upsert on source_url, unique constraint on agent+query

### Layer 2 — Confidence + Trust
- **Live confidence scoring** — source authority × extraction quality × staleness decay × flag penalty — computed on every read, never stored
- **Dynamic volatility classification** — two-stage LLM process: initial classification + dedicated validation call to catch domain-based misclassification (a 1990s football result is permanent, not fast)
- **Volatility classes** — permanent / slow / medium / fast with exponential half-life decay
- **Agent identity** — API key registration, trust tiers (owner / verified / public)
- **Behavioral trust** — agents earn write access through 50 queries, then operator promotion
- **Write access gating** — trust score ≥ 0.6 required for POST /entry
- **Flagging system** — confidence penalty at 3 flags, auto re-fetch at 7 flags, one flag per agent per entry

### Layer 3 — Federation
- **GET /feed** — chronological entry stream for peer node polling
- **POST /corroborate** — cross-node confidence signal, raises score when peers independently confirm a fact
- **Peer registry** — add peer nodes, track sync state
- **Sync worker** — polls peer /feed endpoints every 30 minutes automatically
- **SQL injection protection** — natural language queries only
- **Unanswerable query detection** — personal/realtime questions return a clean 422 with guidance

---

## Public node

**API:** `https://awp-net.up.railway.app`
**Docs:** `https://broodhoney.github.io/awp`
**SDK:** `npm install @roshanpadmanabhan/awp-client`

Free to query. No API key needed for reads.

---

## API reference

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/query?q=` | none | Semantic search. Web fallback on miss. |
| GET | `/entry/:id` | none | Fetch entry by UUID |
| POST | `/entry` | trust ≥ 0.6 | Write entry directly |
| PATCH | `/entry/:id/volatility` | trust ≥ 0.6 | Correct volatility classification |
| POST | `/flag/:id` | optional | Flag entry as wrong |
| POST | `/agents/register` | none | Register new agent |
| GET | `/agents/me` | required | Agent profile + trust score |
| GET | `/agents/status` | required | Trust milestones + path to write access |
| GET | `/feed?since=` | none | Entry stream for federation |
| POST | `/corroborate` | none | Signal cross-node fact confirmation |
| GET | `/peers` | none | List peer nodes |
| POST | `/peers` | owner | Add peer node |
| POST | `/peers/sync` | owner | Trigger manual federation sync |
| GET | `/health` | none | Node health check |
| GET | `/debug?q=` | none | Raw similarity scores for debugging |

---

## Response shape

Every `/query` response has the same shape whether it came from cache or the web:

```json
{
  "hit": true,
  "source": "cache",
  "id": "3f8a2c...",
  "topic": "Ferrari",
  "facts": [
    { "claim": "Founded by Enzo Ferrari in 1939", "type": "text" },
    { "claim": "Headquartered in Maranello, Italy", "type": "text" }
  ],
  "source_url": "https://en.wikipedia.org/wiki/Ferrari",
  "fetched_at": "2026-05-21T06:22:04Z",
  "confidence": 0.84,
  "confidence_label": "medium",
  "flag_count": 0
}
```

---

## Self-hosting

### Prerequisites
- Supabase account (free tier)
- HuggingFace token with inference API permissions

### Setup

```bash
git clone https://github.com/BROODHONEY/awp
cd awp && npm install
cp .env.example .env
```

Fill in `.env`:
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGci...
HF_API_KEY=hf_...
PORT=3000
```

Run schema in Supabase SQL editor — `supabase/schema.sql`

Grant permissions:
```sql
GRANT ALL ON public.entries        TO service_role;
GRANT ALL ON public.queries        TO service_role;
GRANT ALL ON public.agents         TO service_role;
GRANT ALL ON public.flags          TO service_role;
GRANT ALL ON public.peers          TO service_role;
GRANT ALL ON public.corroborations TO service_role;
GRANT EXECUTE ON FUNCTION search_entries         TO service_role;
GRANT EXECUTE ON FUNCTION search_queries         TO service_role;
GRANT EXECUTE ON FUNCTION get_flag_count         TO service_role;
GRANT EXECUTE ON FUNCTION increment_agent_writes TO service_role;
GRANT EXECUTE ON FUNCTION increment_corroboration TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_orphaned_queries TO service_role;
```

Create owner agent:
```sql
INSERT INTO agents (name, api_key, trust_score, tier)
VALUES ('owner', 'your-secret-key', 1.0, 'owner');
```

Run:
```bash
npm run dev
```

---

## Tech stack

| Component | Choice |
|---|---|
| Runtime | Node.js + TypeScript |
| API framework | Hono |
| Database | Supabase (PostgreSQL + pgvector) |
| Embeddings | BAAI/bge-small-en-v1.5 (384-dim) |
| Extraction + validation | Qwen/Qwen2.5-72B-Instruct |
| HTML stripping | Cheerio |
| Hosting | Railway |

---

## Trust lifecycle

```
Register           → trust 0.30 (read only)
10 queries         → trust 0.40 (automatic)
25 queries         → trust 0.50 (automatic)
50 queries         → trust 0.58 (automatic)
Operator promotes  → trust 0.60 (write access unlocked)
Each good write    → +0.02 trust
Each flagged write → -0.10 trust
```

---

## Confidence scoring

```
score = source_authority(url)
      × extraction_quality
      × freshness(age, volatility_class)
      × corroboration_multiplier(count)
      × flag_penalty(flag_count)
```

Recomputed on every read. Never stored. Entries below 0.45 are automatically re-fetched on next query.

---

## Federation

Add a peer node:
```bash
curl -X POST https://your-node/peers \
  -H "X-AWP-Key: your-owner-key" \
  -H "Content-Type: application/json" \
  -d '{"name": "peer-name", "url": "https://peer-node-url"}'
```

Your node syncs from peers every 30 minutes automatically. Manual sync:
```bash
curl -X POST https://your-node/peers/sync \
  -H "X-AWP-Key: your-owner-key"
```

---

## License

MIT — use it, fork it, run your own node.

---

*Built by [@BROODHONEY](https://github.com/BROODHONEY) · 2026*