// ── PandaScore API client ────────────────────────────────────────────────────
// Free tier: 100 req/hour, no OAuth needed — just a Bearer token.
// Get a free key at https://pandascore.co
import { PANDASCORE } from './config.js';

const BASE = PANDASCORE.BASE;

let _apiKey = '';

export function setPandaKey(key) {
  _apiKey = key.trim();
}

export function hasPandaKey() {
  return _apiKey.length > 0;
}

// ── Network ───────────────────────────────────────────────────────────────

const _cache = new Map();
const CACHE_TTL = 20_000; // 20 s for live data

async function fetchJSON(path, params = {}) {
  if (!_apiKey) throw new Error('PandaScore API key not configured');

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  const key = url.toString();
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${_apiKey}` },
  });

  if (res.status === 401) throw new Error('Invalid PandaScore API key');
  if (res.status === 429) throw new Error('PandaScore rate limit reached (100 req/hr on free tier)');
  if (!res.ok) throw new Error(`PandaScore API error ${res.status}`);

  const data = await res.json();
  _cache.set(key, { data, ts: Date.now() });
  return data;
}

// ── Game slug ─────────────────────────────────────────────────────────────

function gameSlug(game) {
  return game === 'lol' ? 'lol' : 'csgo';
}

// ── Matches ───────────────────────────────────────────────────────────────

const MATCH_INCLUDE = [
  'opponents',
  'games',
  'tournament',
  'league',
  'serie',
].join(',');

/**
 * Fetch currently live matches for a game.
 * @param {'cs2'|'lol'} game
 * @returns {Promise<PandaMatch[]>}
 */
export async function fetchLiveMatches(game) {
  const slug = gameSlug(game);
  return fetchJSON(`/${slug}/matches/running`, {
    include: MATCH_INCLUDE,
    per_page: 50,
    sort: 'begin_at',
  });
}

/**
 * Fetch upcoming matches for a game.
 * @param {'cs2'|'lol'} game
 * @returns {Promise<PandaMatch[]>}
 */
export async function fetchUpcomingMatches(game) {
  const slug = gameSlug(game);
  return fetchJSON(`/${slug}/matches/upcoming`, {
    include: MATCH_INCLUDE,
    per_page: 50,
    sort: 'begin_at',
  });
}

/**
 * Fetch details for a single match including games/maps.
 * @param {'cs2'|'lol'} game
 * @param {number} matchId
 * @returns {Promise<PandaMatch>}
 */
export async function fetchMatchDetail(game, matchId) {
  const slug = gameSlug(game);
  return fetchJSON(`/${slug}/matches/${matchId}`, {
    include: [MATCH_INCLUDE, 'games.teams', 'games.results'].join(','),
  });
}

// ── Teams ─────────────────────────────────────────────────────────────────

/**
 * Search for a team by name and return their stats.
 * @param {'cs2'|'lol'} game
 * @param {string} name
 */
export async function searchTeam(game, name) {
  const slug = gameSlug(game);
  const results = await fetchJSON(`/${slug}/teams`, {
    'search[name]': name,
    per_page: 5,
  });
  return results[0] ?? null;
}

/**
 * Get recent match history for a team.
 * @param {'cs2'|'lol'} game
 * @param {number} teamId
 * @param {number} [count=10]
 */
export async function fetchTeamRecentMatches(game, teamId, count = 10) {
  const slug = gameSlug(game);
  return fetchJSON(`/${slug}/teams/${teamId}/matches`, {
    'filter[status]': 'finished',
    sort: '-begin_at',
    per_page: count,
    include: 'opponents,results',
  });
}

// ── Normalisation ─────────────────────────────────────────────────────────

/**
 * Normalise a raw PandaScore match into the shape the app uses.
 * @param {object} raw
 * @returns {NormPandaMatch}
 */
export function normalisePandaMatch(raw) {
  if (!raw) return null;

  const opponents = (raw.opponents ?? []).map(o => ({
    id: o.opponent?.id ?? null,
    name: o.opponent?.name ?? '—',
    acronym: o.opponent?.acronym ?? '',
    imageUrl: o.opponent?.image_url ?? null,
  }));

  const games = (raw.games ?? []).map((g, idx) => ({
    id: g.id,
    position: g.position ?? idx + 1,
    status: g.status,         // 'not_started' | 'running' | 'finished'
    mapName: g.map?.name ?? null,
    mapSlug: (g.map?.name ?? '').toLowerCase().replace(/\s+/g, ''),
    winner: g.winner?.name ?? null,
    teams: (g.teams ?? []).map(t => ({
      name: t.team?.name ?? '',
      score: t.score ?? 0,
    })),
  }));

  // Calculate series score from finished games
  const team1 = opponents[0];
  const team2 = opponents[1];
  let score1 = 0, score2 = 0;
  for (const g of games) {
    if (g.status === 'finished') {
      if (g.winner === team1?.name) score1++;
      else if (g.winner === team2?.name) score2++;
    }
  }

  return {
    id: raw.id,
    name: raw.name ?? '',
    status: raw.status,          // 'not_started' | 'running' | 'finished'
    beginAt: raw.begin_at ?? null,
    endAt: raw.end_at ?? null,
    numberOfGames: raw.number_of_games ?? 3,
    seriesScore: { [team1?.name]: score1, [team2?.name]: score2 },
    opponents,
    games,
    tournament: {
      id: raw.tournament?.id,
      name: raw.tournament?.name ?? '',
      tier: raw.tournament?.tier ?? null,
    },
    league: {
      id: raw.league?.id,
      name: raw.league?.name ?? '',
      imageUrl: raw.league?.image_url ?? null,
    },
    serie: {
      id: raw.serie?.id,
      fullName: raw.serie?.full_name ?? '',
    },
  };
}

/**
 * Try to match a PandaScore match to a Polymarket event by comparing team names.
 * @param {NormPandaMatch} panda
 * @param {GameEvent[]} polyEvents
 * @returns {GameEvent|null}
 */
export function findPolymarketMatch(panda, polyEvents) {
  if (!panda?.opponents?.length) return null;

  const pandaTeams = panda.opponents.map(o =>
    normaliseTeamName(o.name ?? o.acronym ?? '')
  );

  return polyEvents.find(ev => {
    const ml = ev.markets.find(m => m.subtype === 'ml');
    if (!ml) return false;

    const polyTeams = [ml.team1, ml.team2].map(normaliseTeamName);
    return pandaTeams.every(pt => polyTeams.some(qt => teamMatch(pt, qt)));
  }) ?? null;
}

function normaliseTeamName(name) {
  return name
    .toLowerCase()
    .replace(/\s+esports?$/i, '')
    .replace(/\s+gaming$/i, '')
    .replace(/\s+/g, '')
    .trim();
}

function teamMatch(a, b) {
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  // Levenshtein-lite: allow 1 char diff for short strings
  if (Math.abs(a.length - b.length) > 3) return false;
  let diff = 0;
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff <= 2;
}
