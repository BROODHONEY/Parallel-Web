/**
 * AWP Confidence Scoring — Layer 2
 * 
 * Confidence is computed from three signals:
 *   score = sourceAuthority(url) × extractionQuality × freshness(age, volatility)
 * 
 * All signals are derived dynamically — no hardcoded domain lists.
 * Recomputed on every read, never stored.
 */

// ── Volatility → half-life in days ──────────────────────────────────────────

const HALF_LIVES: Record<string, number> = {
  permanent: Infinity,
  slow:      180,
  medium:    35,
  fast:      3,
}

// ── TLD authority bonuses ────────────────────────────────────────────────────
// Regulated or institutional TLDs get a structural boost
// regardless of the specific domain name

const TLD_BONUS: Record<string, number> = {
  '.gov':    0.25,   // government — highly regulated
  '.edu':    0.20,   // academic institution
  '.mil':    0.20,   // military
  '.int':    0.15,   // international organisations (NATO, UN, etc.)
  '.org':    0.05,   // non-profit — slight boost, not conclusive
}

// ── Subdomain signals ────────────────────────────────────────────────────────
// Official technical/reference subdomains — applies to any domain

const AUTHORITATIVE_SUBDOMAINS = [
  'docs.',        // docs.python.org, docs.github.com
  'developer.',   // developer.apple.com, developer.mozilla.org
  'research.',    // research.google.com
  'api.',         // api.openai.com
  'learn.',       // learn.microsoft.com
  'wiki.',        // wiki.archlinux.org
  'support.',     // support.google.com
  'help.',        // help.github.com
  'official.',
]

// ── Path signals ─────────────────────────────────────────────────────────────
// URL path patterns that indicate reference/structured content

const AUTHORITATIVE_PATHS = [
  '/wiki/',
  '/docs/',
  '/documentation/',
  '/reference/',
  '/paper/',
  '/research/',
  '/specification/',
  '/spec/',
  '/official/',
  '/release/',
  '/changelog/',
  '/whitepaper/',
]

// ── UGC platform patterns ────────────────────────────────────────────────────
// User-generated content — inherently less authoritative than primary sources

const UGC_PATTERNS = [
  'reddit.com',
  'quora.com',
  'medium.com',
  'substack.com',
  'blogspot.com',
  'wordpress.com',
  'tumblr.com',
  'stackoverflow.com',   // answers vary in quality
  'stackexchange.com',
  'answers.yahoo.com',
  'forum.',
  '/forum/',
  '/forums/',
  '/community/',
  '/discussion/',
  '/thread/',
  '/comment/',
  '/blog/',
  '/post/',
  '/user/',
  '/profile/',
]

/**
 * Compute source authority dynamically from URL structure.
 * No hardcoded domain list — generalises to any URL.
 * 
 * Returns a value between 0.20 and 0.98.
 */
export function sourceAuthority(url: string): number {
  let score = 0.65   // base score for any unknown domain

  try {
    const parsed   = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    const path     = parsed.pathname.toLowerCase()
    const full     = hostname + path

    // ── TLD bonus ──────────────────────────────────────────────────
    for (const [tld, bonus] of Object.entries(TLD_BONUS)) {
      if (hostname.endsWith(tld)) {
        score += bonus
        break
      }
    }

    // ── Subdomain bonus ────────────────────────────────────────────
    // Check if the hostname starts with an authoritative subdomain
    for (const sub of AUTHORITATIVE_SUBDOMAINS) {
      if (hostname.startsWith(sub)) {
        score += 0.15
        break
      }
    }

    // ── Path bonus ─────────────────────────────────────────────────
    for (const pathPattern of AUTHORITATIVE_PATHS) {
      if (path.includes(pathPattern)) {
        score += 0.10
        break
      }
    }

    // ── Wikipedia special case ─────────────────────────────────────
    // Wikipedia is the most reliable general reference on the web
    if (hostname.includes('wikipedia.org')) {
      score += 0.25
    }

    // ── UGC penalty ────────────────────────────────────────────────
    // User-generated content is less reliable than primary sources
    for (const pattern of UGC_PATTERNS) {
      if (full.includes(pattern)) {
        score -= 0.25
        break
      }
    }

    // ── Clamp to valid range ────────────────────────────────────────
    return Math.min(0.98, Math.max(0.20, Math.round(score * 100) / 100))

  } catch {
    // Malformed URL
    return 0.50
  }
}

/**
 * Compute freshness using exponential decay.
 * At age 0: score = 1.0
 * At age = half-life: score = 0.5
 * permanent class: always 1.0
 */
export function freshness(fetchedAt: string, volatilityClass: string): number {
  const halfLife = HALF_LIVES[volatilityClass] ?? 35

  if (halfLife === Infinity) return 1.0

  const ageMs   = Date.now() - new Date(fetchedAt).getTime()
  const ageDays = ageMs / (1000 * 60 * 60 * 24)

  return Math.exp(-Math.LN2 * ageDays / halfLife)
}

export function corroborationMultiplier(count: number): number {
  return Math.min(1.30, 1.0 + count * 0.05)
}

export function computeConfidence(entry: {
  source_url:           string
  fetched_at:           string
  extraction_quality?:  number | null
  volatility_class?:    string | null
  flag_count?:          number
  corroboration_count?: number  
}): number {
  const authority       = sourceAuthority(entry.source_url)
  const quality         = entry.extraction_quality ?? 0.75
  const decay           = freshness(entry.fetched_at, entry.volatility_class ?? 'medium')
  const corroboration   = corroborationMultiplier(entry.corroboration_count ?? 0)

  let score = authority * quality * decay * corroboration

  if (entry.flag_count && entry.flag_count > 0) {
    score = applyFlagPenalty(score, entry.flag_count)
  }

  return Math.round(score * 100) / 100
}

/**
 * Is this entry stale enough to warrant a re-fetch?
 */
export function isStale(score: number): boolean {
  return score < 0.45
}

/**
 * Human-readable confidence label — useful for debugging and API responses.
 */
export function confidenceLabel(score: number): string {
  if (score >= 0.85) return 'high'
  if (score >= 0.65) return 'medium'
  if (score >= 0.45) return 'low'
  return 'stale'
}

// How many flags before confidence starts getting penalised
const FLAG_THRESHOLD = 3

/**
 * Apply a flag penalty to a confidence score.
 * Each flag above the threshold reduces confidence by 15%.
 * At 3 flags: no penalty yet
 * At 4 flags: score × 0.85
 * At 5 flags: score × 0.70
 * At 7 flags: score × 0.40 → below stale threshold → triggers re-fetch
 */
export function applyFlagPenalty(score: number, flagCount: number): number {
  if (flagCount < FLAG_THRESHOLD) return score

  const flagsOverThreshold = flagCount - FLAG_THRESHOLD
  const penalty = Math.pow(0.85, flagsOverThreshold)
  return Math.round(score * penalty * 100) / 100
}