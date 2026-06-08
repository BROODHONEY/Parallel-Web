import { HfInference } from '@huggingface/inference'
import type { Fact } from '../db/types'
import 'dotenv/config'

const hf = new HfInference(process.env.HF_API_KEY)

// Qwen2.5-72B-Instruct: free, widely available across HF providers,
// better at structured JSON output than Mistral-7B
const EXTRACTION_MODEL = 'Qwen/Qwen2.5-72B-Instruct'
const MODELS = [
  'Qwen/Qwen2.5-72B-Instruct',
  'meta-llama/Llama-3.1-8B-Instruct',
  'HuggingFaceH4/zephyr-7b-beta',
  'mistralai/Mistral-7B-Instruct-v0.2',  // v0.2 has better provider support than v0.3
]

export interface ExtractionResult {
  topic: string
  facts: Fact[]
  source_type: 'primary' | 'secondary' | 'aggregator'
  extraction_quality: number
  volatility_class: 'permanent' | 'slow' | 'medium' | 'fast'
}

const SYSTEM_PROMPT = `You are a structured knowledge extractor for the Agent Web Protocol (AWP).
Your job is to extract discrete, verifiable facts from webpage content and classify their metadata accurately.

Return ONLY a valid JSON object. No explanation, no markdown fences, no extra text before or after.

Required JSON shape:
{
  "topic": "concise canonical label for the main subject",
  "facts": [
    { "claim": "one discrete fact", "type": "text|numeric|boolean|date", "value": "optional", "unit": "optional" }
  ],
  "source_type": "primary|secondary|aggregator",
  "extraction_quality": 0.85,
  "volatility_class": "permanent|slow|medium|fast"
}

━━━ FACT EXTRACTION RULES ━━━

Facts must be discrete and verifiable:
  ✓ "Enzo Ferrari founded Ferrari in 1939"
  ✓ "Python supports object-oriented programming"
  ✗ "Ferrari is a great car company" (opinion)
  ✗ "Python is popular" (vague)

Type must be one of:
  text    — a string claim with no numeric value
  numeric — a measurable quantity (always include unit when applicable)
  boolean — a true/false claim
  date    — a specific point or period in time

source_type:
  primary    — official source (company site, government, standards body, author's own page)
  secondary  — reliable third-party (Wikipedia, reputable journalism, academic summary)
  aggregator — directory, forum, blog, or content farm

extraction_quality: your honest self-assessment
  1.0 — clean, structured, authoritative source with clear facts
  0.8 — good source, minor noise or ambiguity
  0.6 — usable but source was cluttered, paywalled, or partially relevant
  0.4 — poor source quality, facts may be incomplete or unclear
  0.2 — source was mostly noise, very few facts extractable

━━━ VOLATILITY CLASSIFICATION RULES ━━━

CRITICAL: Classify based on the NATURE OF THE FACTS, not the topic domain.
Sports, tech, politics, science — the domain does not determine volatility.
Ask yourself: "Could this specific fact ever change?"

PERMANENT — Facts that are definitionally or historically fixed forever.
These facts were true, are true, and will always be true. No event can change them.

Examples of PERMANENT facts regardless of domain:
  • Historical events: "The 1966 FIFA World Cup was held in England"
  • Historical scores: "Brazil beat Italy 3-2 in the 1994 World Cup final"
  • Scientific constants: "Water boils at 100°C at standard pressure"
  • Mathematical facts: "A triangle has three sides"
  • Biographical fixed points: "Nikola Tesla was born on July 10, 1856"
  • Protocol definitions: "DNS translates domain names to IP addresses"
  • Founding facts: "Apple was founded in 1976 by Steve Jobs, Steve Wozniak, and Ronald Wayne"
  • Records at a fixed point: "Usain Bolt ran 100m in 9.58 seconds at the 2009 World Championships"
  • How things work (stable mechanisms): "GPS receivers triangulate position from satellite signals"
  • Rules of games (stable rulebooks): "In chess, the queen can move any number of squares in any direction"
  • Laws of physics: "Objects in motion stay in motion unless acted on by an external force"

SLOW — Facts that are stable for years but could eventually change.
These are true now and will likely stay true for a long time, but are not permanently fixed.

Examples of SLOW facts:
  • Current laws and regulations (change through legislation)
  • Country capitals (rarely change, but can: e.g. Myanmar moved its capital in 2006)
  • Constitutional structures (how a government is organized)
  • Standards and specifications (RFCs, ISO standards — updated occasionally)
  • Population figures (change slowly, census data)
  • Company headquarters locations
  • Long-standing records that could theoretically be broken
  • Rules of modern sports (FIFA, NFL rules change occasionally, not annually)
  • Academic consensus on well-established science

MEDIUM — Facts that are accurate for weeks to months but routinely change.
These are current facts that will become outdated within a season or product cycle.

Examples of MEDIUM facts:
  • Software versions and release notes
  • Current product specifications and pricing
  • Company leadership (CEO, management team)
  • Current sports standings, team rosters, current season stats
  • Current geopolitical situations
  • Academic paper citation counts
  • API documentation for active products
  • Economic indicators (inflation rate, GDP growth for a quarter)

FAST — Facts that are accurate for hours to days only.
These become stale almost immediately. Do not use fast unless the fact is genuinely time-sensitive.

Examples of FAST facts:
  • Live match scores or in-progress game stats
  • Stock prices, cryptocurrency prices
  • Weather conditions
  • Breaking news events (first 48 hours)
  • Today's exchange rates
  • Injury reports before a game
  • Real-time availability (flight seats, hotel rooms)

━━━ CLASSIFICATION DECISION GUIDE ━━━

Ask these questions in order:

1. Is this fact about something that already happened and is now historical record?
   → PERMANENT (past tense events, historical records, completed matches)

2. Is this fact about how something works at a fundamental level (physics, protocol, rules)?
   → PERMANENT if the mechanism is stable; SLOW if subject to revision

3. Is this fact about a current state that changes yearly or less?
   → SLOW (laws, population, long-standing records)

4. Is this fact about something that changes within a product/sports season?
   → MEDIUM (rosters, versions, standings, leadership)

5. Is this fact only accurate for today or this week?
   → FAST (live scores, prices, breaking news)

When a page contains facts of mixed volatility, classify by the MOST VOLATILE fact present,
since that determines when the entry as a whole becomes unreliable.

━━━ COMMON MISTAKES TO AVOID ━━━

✗ "This is about sports so it must be fast"
  → A 1994 World Cup final score is PERMANENT. A current season table is MEDIUM.

✗ "This is about technology so it must be medium"  
  → How TCP/IP works is PERMANENT. The latest Node.js version is MEDIUM.

✗ "This is about a person so it must be slow"
  → Their birth date is PERMANENT. Their current job title is MEDIUM.

✗ "This is a news article so it must be fast"
  → An article about a 1969 moon landing is PERMANENT. An article about today's stock market is FAST.

✗ "Wikipedia articles are always slow"
  → Depends entirely on the facts. A Wikipedia article about the history of chess: PERMANENT.
     A Wikipedia article about current Premier League standings: MEDIUM.`

/**
 * Sends stripped webpage text to a HuggingFace model and returns structured facts.
 */
export async function extractFacts(
  sourceUrl: string,
  strippedText: string
): Promise<ExtractionResult> {
  let lastError: Error = new Error('No models available')

  for (const model of MODELS) {
    try {
      console.log(`  Trying model: ${model}`)

      const response = await hf.chatCompletion({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Source URL: ${sourceUrl}\n\nContent:\n${strippedText.slice(0, 2000)}`,
          },
        ],
        max_tokens: 1000,
        temperature: 0.1,
      })

      const rawText = response.choices[0]?.message?.content?.trim() ?? ''
      if (!rawText) throw new Error('Empty response')

      const parsed = safeParseJSON(rawText)
      if (!parsed) {
        console.error('Raw response:', rawText)
        throw new Error('Failed to parse JSON')
      }

      if (!parsed.topic || !Array.isArray(parsed.facts)) {
        throw new Error(`Missing required fields: ${JSON.stringify(parsed)}`)
      }

      console.log(`  Success with model: ${model}`)

      const correctedVolatility = await validateVolatility(
        String(parsed.topic),
        parsed.facts as Fact[],
        (parsed.volatility_class as string) ?? 'medium',
        sourceUrl
      )

      return {
        topic:              String(parsed.topic),
        facts:              parsed.facts as Fact[],
        source_type:        (parsed.source_type as ExtractionResult['source_type']) ?? 'secondary',
        extraction_quality: Number(parsed.extraction_quality ?? 0.5),
        volatility_class:   correctedVolatility as ExtractionResult['volatility_class'],
      }

    } catch (err: any) {
      const body = err?.httpResponse?.body
      const msg  = typeof body === 'object' ? JSON.stringify(body) : String(body ?? err.message)
      console.warn(`  Model ${model} failed: ${msg}`)
      lastError = new Error(msg)
      // continue to next model
    }
  }

  throw lastError
}

/**
 * Tries to extract valid JSON from a string that might have noise around it.
 * Handles: clean JSON, text before/after JSON, markdown code fences.
 */
function safeParseJSON(text: string): Record<string, unknown> | null {
  // Attempt 1: direct parse — works when model behaves perfectly
  try { return JSON.parse(text) } catch { /* continue */ }

  // Attempt 2: find the outermost { } block
  const start = text.indexOf('{')
  const end   = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch { /* continue */ }
  }

  // Attempt 3: strip ```json ... ``` or ``` ... ``` fences
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fence?.[1]) {
    try { return JSON.parse(fence[1].trim()) } catch { /* continue */ }
  }

  return null
}

/**
 * Validates the LLM's volatility classification using a second focused call.
 * Cheaper than re-extraction — small prompt, short response.
 * Returns the corrected classification.
 */
async function validateVolatility(
  topic: string,
  facts: Fact[],
  proposedClass: string,
  sourceUrl: string
): Promise<string> {

  const factsText = facts
    .map((f, i) => `${i + 1}. ${f.claim}`)
    .join('\n')

  const prompt = `You are a volatility classifier for a knowledge index.

A fact extractor proposed volatility class "${proposedClass}" for the following entry.
Your job is to verify this is correct, or correct it if wrong.

Topic: ${topic}
Source: ${sourceUrl}
Proposed class: ${proposedClass}

Facts extracted:
${factsText}

Volatility classes:
- permanent: facts that are historically fixed and can never change
  (past events, historical scores, scientific constants, how stable protocols work,
   biographical fixed points like birth dates, founding dates)
- slow: facts stable for years but could eventually change
  (current laws, country capitals, standards, long-standing records)
- medium: facts accurate for weeks to months
  (software versions, current rosters, leadership, current season stats)
- fast: facts only accurate for hours to days
  (live scores, stock prices, weather, breaking news)

Key rule: classify by the FACTS, not the topic domain.
A 1990s football match result is PERMANENT. A live score is FAST.
How DNS works is PERMANENT. The current DNS server software version is MEDIUM.

Reply with ONLY one word — the correct volatility class.
No explanation. No punctuation. Just the word: permanent, slow, medium, or fast`

  try {
    const response = await hf.chatCompletion({
      model: EXTRACTION_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,       // we only need one word
      temperature: 0.0,     // fully deterministic
    })

    const raw = response.choices[0]?.message?.content?.trim().toLowerCase() ?? ''
    const valid = ['permanent', 'slow', 'medium', 'fast']

    // Extract just the classification word even if model adds punctuation
    const found = valid.find(v => raw.includes(v))

    if (found) {
      if (found !== proposedClass) {
        console.log(`  Volatility corrected: ${proposedClass} → ${found} (topic: ${topic})`)
      }
      return found
    }

    // Model gave an unexpected response — trust the original
    console.warn(`  Volatility validator gave unexpected response: "${raw}" — keeping "${proposedClass}"`)
    return proposedClass

  } catch (err: any) {
    // Validation failed — don't crash extraction, keep original
    console.warn(`  Volatility validation failed: ${err.message} — keeping "${proposedClass}"`)
    return proposedClass
  }
}