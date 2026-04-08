// ── Polymarket Gamma API client ──────────────────────────────────────────────
import { POLYMARKET } from './config.js';

const BASE = POLYMARKET.BASE;

// Simple in-memory cache to avoid hammering the API.
const _cache = new Map();
const CACHE_TTL_UPCOMING = 300_000;  // 5 min — matches upcoming data refresh
const CACHE_TTL_LIVE     = 4_000;    // 4 sec — keeps live data fresh between 5 s polls

// Mode flag set by app.js before each fetch cycle
let _liveMode = false;
export function setLiveMode(on) { _liveMode = on; }

function cacheTTL() {
  return _liveMode ? CACHE_TTL_LIVE : CACHE_TTL_UPCOMING;
}

async function fetchJSON(path, params = {}) {
  const url = new URL(BASE, location.origin);
  url.searchParams.set('path', path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  const key = url.toString();
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < cacheTTL()) return cached.data;

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Polymarket API error ${res.status}: ${url}`);
  const data = await res.json();
  _cache.set(key, { data, ts: Date.now() });
  return data;
}

// ── Event fetching ────────────────────────────────────────────────────────

/**
 * Fetch all active events from Polymarket for a given game.
 * Tries multiple tag slugs and deduplicates by event id.
 * @param {'cs2'|'lol'} game
 * @returns {Promise<PolyEvent[]>}
 */
export async function fetchGameEvents(game) {
  const tagSlugs = POLYMARKET.TAGS[game] ?? ['esports'];
  const keywords = POLYMARKET.GAME_KEYWORDS[game] ?? [];

  const results = await Promise.allSettled(
    tagSlugs.map(slug =>
      fetchJSON('/events', {
        tag_slug: slug,
        closed: 'false',
        limit: 100,
      })
    )
  );

  const seen = new Set();
  const events = [];

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const arr = Array.isArray(r.value) ? r.value : (r.value?.events ?? []);
    for (const ev of arr) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      events.push(ev);
    }
  }

  // Filter: must mention at least one game keyword in title (unless tag slug was game-specific)
  // or be a well-known esports event title.
  const filtered = events.filter(ev => {
    const title = (ev.title ?? ev.label ?? ev.name ?? '').toLowerCase();
    return keywords.some(kw => title.includes(kw));
  });

  return filtered;
}

/**
 * Fetch the individual markets inside an event.
 * In live mode we also fetch closed markets so we can infer which maps are done.
 * @param {string|number} eventId
 * @returns {Promise<PolyMarket[]>}
 */
export async function fetchEventMarkets(eventId) {
  // Fetch open markets always
  const openData = await fetchJSON('/markets', {
    event_id: eventId,
    closed: 'false',
    active: 'true',
    limit: 50,
  });
  const open = Array.isArray(openData) ? openData : (openData?.markets ?? []);

  // In live mode also grab closed/resolved markets to infer map scores
  let closed = [];
  if (_liveMode) {
    try {
      const closedData = await fetchJSON('/markets', {
        event_id: eventId,
        closed: 'true',
        limit: 50,
      });
      closed = Array.isArray(closedData) ? closedData : (closedData?.markets ?? []);
    } catch { /* non-fatal */ }
  }

  return [...open, ...closed];
}

/**
 * Infer series score from settled (closed) map markets on Polymarket.
 * When a map market resolves, outcomePrices snaps to ["1","0"] (team1 won)
 * or ["0","1"] (team2 won).
 *
 * @param {NormMarket[]} markets – all markets (open + closed) for the event
 * @param {string} team1
 * @param {string} team2
 * @returns {{ score1: number, score2: number, resolvedMaps: ResolvedMap[] }}
 */
export function inferSeriesScore(markets, team1, team2) {
  const mapSubtypes = new Set(['map1', 'map2', 'map3', 'map_winner']);
  const resolvedMaps = [];
  let score1 = 0, score2 = 0;

  for (const m of markets) {
    if (!m.closed) continue;
    if (!mapSubtypes.has(m.subtype)) continue;

    const [p0, p1] = m.probs;
    // A settled market has one price at ~1.0 and the other at ~0.0
    const t1Won = p0 >= 0.95;
    const t2Won = p1 >= 0.95;
    if (!t1Won && !t2Won) continue;

    const winner = t1Won ? m.team1 : m.team2;
    resolvedMaps.push({ subtype: m.subtype, winner, question: m.question });
    if (t1Won) score1++; else score2++;
  }

  return { score1, score2, resolvedMaps };
}

// ── High-level data helpers ──────────────────────────────────────────────

/**
 * Return enriched game data: events with their markets attached, filtered by
 * minimum volume and normalised into a consistent shape.
 *
 * @param {'cs2'|'lol'} game
 * @param {number} minVolume
 * @returns {Promise<GameEvent[]>}
 */
export async function getEnrichedEvents(game, minVolume = 20_000) {
  const events = await fetchGameEvents(game);

  const enriched = await Promise.all(
    events.map(async ev => {
      let markets = [];
      try {
        markets = await fetchEventMarkets(ev.id);
      } catch {
        // Use markets embedded in the event object if the separate call fails
        markets = ev.markets ?? [];
      }

      // Normalise each market into a consistent schema
      const normMarkets = markets
        .map(m => normaliseMarket(m))
        .filter(m => m !== null);

      return normaliseEvent(ev, normMarkets);
    })
  );

  // Filter by volume and sort by volume descending
  return enriched
    .filter(ev => ev.totalVolume >= minVolume)
    .filter(ev => {
      // Drop events where ML team names look like garbage (single words, "the", yes/no)
      const ml = ev.markets.find(m => m.subtype === 'ml');
      if (!ml) return true; // keep non-ML events (tournament winners etc.)
      const bad = (name) => !name || name.length < 2 || /^(yes|no|the)$/i.test(name.trim());
      return !bad(ml.team1) && !bad(ml.team2);
    })
    .sort((a, b) => b.totalVolume - a.totalVolume);
}

// ── Normalisation ────────────────────────────────────────────────────────

/**
 * Normalise a raw Polymarket event object.
 * @param {object} raw
 * @param {NormMarket[]} markets
 * @returns {GameEvent}
 */
function normaliseEvent(raw, markets) {
  const title = raw.title ?? raw.label ?? raw.name ?? raw.slug ?? '';
  const totalVolume = markets.reduce((s, m) => s + m.volume, 0) ||
    parseFloat(raw.volume ?? raw.volumeNum ?? 0);

  // Detect the market type: match (individual game) vs tournament winner
  const isTournamentWinner = /winner|champion|win the|take the title/i.test(title);

  return {
    id: raw.id,
    slug: raw.slug ?? '',
    title,
    isTournamentWinner,
    startDate: raw.startDate ?? raw.start_date ?? null,
    endDate: raw.endDate ?? raw.end_date ?? null,
    totalVolume,
    markets,
    image: raw.image ?? null,
    // Derived fields populated by app.js after enrichment
    pandaMatch: null,
  };
}

/**
 * Normalise a raw Polymarket market object.
 * Returns null if we can't extract useful data.
 * @param {object} raw
 * @returns {NormMarket|null}
 */
function normaliseMarket(raw) {
  try {
    const question = raw.question ?? raw.title ?? '';
    const outcomes = raw.outcomes
      ? (typeof raw.outcomes === 'string' ? JSON.parse(raw.outcomes) : raw.outcomes)
      : ['Yes', 'No'];

    const prices = raw.outcomePrices
      ? (typeof raw.outcomePrices === 'string' ? JSON.parse(raw.outcomePrices) : raw.outcomePrices)
      : [0.5, 0.5];

    const p0 = parseFloat(prices[0]) || 0;
    const p1 = parseFloat(prices[1]) || 0;

    const volume = parseFloat(raw.volumeNum ?? raw.volume ?? 0);
    const liquidity = parseFloat(raw.liquidityNum ?? raw.liquidity ?? 0);

    // Determine market subtype
    const qLow = question.toLowerCase();
    const subtype = detectSubtype(qLow, outcomes);

    // Extract team names
    const { team1, team2 } = extractTeams(question, outcomes);

    // For match winner markets, p0 = team1 win prob, p1 = team2 win prob.
    // For Yes/No markets, p0 = Yes prob.
    return {
      id: raw.id ?? raw.conditionId,
      conditionId: raw.conditionId ?? '',
      question,
      outcomes,
      probs: [p0, p1],      // [prob_outcome0, prob_outcome1]
      team1,
      team2,
      subtype,              // 'ml' | 'map1' | 'map2' | 'map3' | 'total_maps' | 'other'
      volume,
      liquidity,
      active: raw.active ?? true,
      closed: raw.closed ?? false,
      endDate: raw.endDate ?? raw.end_date ?? null,
      acceptingOrders: raw.acceptingOrders ?? true,
    };
  } catch {
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

const SUBTYPE_PATTERNS = [
  { re: /map\s*1\s*(winner|ml)/i,  type: 'map1' },
  { re: /map\s*2\s*(winner|ml)/i,  type: 'map2' },
  { re: /map\s*3\s*(winner|ml)/i,  type: 'map3' },
  { re: /map\s*[1-3]/i,            type: 'map_winner' },
  { re: /\b(2\.5|2\.5\+|over.+map|map.+over)\b/i, type: 'total_maps' },
  { re: /handicap|spread/i,        type: 'handicap' },
  { re: /\b(win|beat|defeat|match winner|ml)\b/i, type: 'ml' },
];

function detectSubtype(questionLower, outcomes) {
  for (const { re, type } of SUBTYPE_PATTERNS) {
    if (re.test(questionLower)) return type;
  }
  // Two-outcome markets with team names as outcomes → ML
  if (outcomes.length === 2 &&
      outcomes[0].toLowerCase() !== 'yes' &&
      outcomes[0].toLowerCase() !== 'no') {
    return 'ml';
  }
  // Yes/No with "win" → ML
  if (/\bwill\b.+\bwin\b/i.test(questionLower)) return 'ml';
  return 'other';
}

/**
 * Extract team names from a question string or outcomes array.
 * Handles formats like:
 *   "G2 vs. NaVi – BLAST Open"  → ["G2", "NaVi"]
 *   outcomes: ["G2", "NaVi"]
 *   "Will G2 win against NaVi?" → ["G2", "NaVi"]
 */
export function extractTeams(question, outcomes) {
  // If outcomes are not Yes/No, use them directly
  if (
    outcomes.length === 2 &&
    outcomes[0].toLowerCase() !== 'yes' &&
    outcomes[0].toLowerCase() !== 'no'
  ) {
    return { team1: outcomes[0], team2: outcomes[1] };
  }

  // Try "A vs B" / "A vs. B" pattern
  const vsMatch = question.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*[–\-|:,]|$)/i);
  if (vsMatch) {
    return { team1: vsMatch[1].trim(), team2: vsMatch[2].trim() };
  }

  // Try "Will [Team A] beat/win..."
  const willMatch = question.match(/will\s+(.+?)\s+(?:beat|win|defeat)\s+(.+?)[\s?]/i);
  if (willMatch) {
    return { team1: willMatch[1].trim(), team2: willMatch[2].trim() };
  }

  return { team1: outcomes[0] ?? '—', team2: outcomes[1] ?? '—' };
}

/**
 * Given an event title, guess the tournament name.
 * e.g. "ESL Counter-Strike Quarterfinals: G2 vs Liquid" → "ESL Counter-Strike"
 */
export function parseTournamentName(title) {
  // Remove "A vs B" suffixes
  const clean = title
    .replace(/:\s*.+\s+vs\.?\s+.+$/i, '')
    .replace(/\s+-\s+.+\s+vs\.?\s+.+$/i, '')
    .replace(/\s+\d{4}$/, '')
    .trim();
  return clean || title;
}
