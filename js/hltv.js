// ── HLTV scraper client ──────────────────────────────────────────────────────
// Fetches rankings, team stats, and per-map win rates by proxying HLTV HTML
// through /api/hltv and parsing with DOMParser.

const BASE = '/api/hltv';

// In-memory caches with different TTLs
const _cache = new Map();
const TTL_RANKING = 60 * 60 * 1000;   // 1 hour
const TTL_TEAM    = 24 * 60 * 60 * 1000; // 24 hours

async function fetchHTML(path) {
  const key = path;
  const cached = _cache.get(key);
  const now = Date.now();
  if (cached && (now - cached.ts) < cached.ttl) return cached.html;

  const url = new URL(BASE, location.origin);
  url.searchParams.set('path', path);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HLTV proxy error ${res.status} for ${path}`);
  const html = await res.text();

  const ttl = path.startsWith('/ranking') ? TTL_RANKING : TTL_TEAM;
  _cache.set(key, { html, ts: now, ttl });
  return html;
}

function parseDOM(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

// ── Team name fuzzy matching (reused from pandascore.js) ─────────────────────

function normaliseTeamName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\s+esports?$/i, '')
    .replace(/\s+gaming$/i, '')
    .replace(/\s+team$/i, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function teamMatch(a, b) {
  a = normaliseTeamName(a);
  b = normaliseTeamName(b);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  if (Math.abs(a.length - b.length) > 3) return false;
  let diff = 0;
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) if (a[i] !== b[i]) diff++;
  return diff <= 2;
}

// ── World Ranking ────────────────────────────────────────────────────────────

/**
 * Scrape the HLTV world ranking page.
 * @returns {Promise<Array<{rank:number, teamName:string, teamId:string, teamSlug:string, points:number}>>}
 */
export async function fetchWorldRanking() {
  try {
    const html = await fetchHTML('/ranking/teams');
    const doc = parseDOM(html);

    const teams = [];
    // HLTV ranking page uses .ranked-team blocks
    doc.querySelectorAll('.ranked-team').forEach(el => {
      const rankEl = el.querySelector('.position');
      const nameEl = el.querySelector('.teamLine .name, .header .teamLine .name');
      const pointsEl = el.querySelector('.points');
      const linkEl = el.querySelector('a.moreLink, .teamLine a, a[href*="/team/"]');

      if (!nameEl || !rankEl) return;

      const rank = parseInt(rankEl.textContent.replace('#', '').trim(), 10);
      const teamName = nameEl.textContent.trim();
      const pointsMatch = pointsEl?.textContent?.match(/(\d+)/);
      const points = pointsMatch ? parseInt(pointsMatch[1], 10) : 0;

      let teamId = '', teamSlug = '';
      if (linkEl) {
        const href = linkEl.getAttribute('href') || '';
        const m = href.match(/\/team\/(\d+)\/([^/?#]+)/);
        if (m) { teamId = m[1]; teamSlug = m[2]; }
      }

      teams.push({ rank, teamName, teamId, teamSlug, points });
    });

    console.log(`[hltv] fetched ${teams.length} ranked teams`);
    return teams;
  } catch (err) {
    console.warn('[hltv] fetchWorldRanking failed:', err.message);
    return [];
  }
}

// ── Team Lookup ──────────────────────────────────────────────────────────────

/**
 * Find an HLTV team entry by Polymarket team name.
 * @param {string} polyName
 * @param {Array} ranking – result of fetchWorldRanking()
 * @returns {object|null}
 */
export function findTeamByName(polyName, ranking) {
  if (!polyName || !ranking?.length) return null;
  return ranking.find(t => teamMatch(t.teamName, polyName)) ?? null;
}

// ── Team Stats ───────────────────────────────────────────────────────────────

/**
 * Fetch aggregate team stats (win rate, recent form) from HLTV.
 * @param {string} teamId
 * @param {string} teamSlug
 * @returns {Promise<{winRate:number|null, matchesPlayed:number, recentForm:string[]}>}
 */
export async function fetchTeamStats(teamId, teamSlug) {
  if (!teamId || !teamSlug) return null;
  try {
    const html = await fetchHTML(`/stats/teams/${teamId}/${teamSlug}`);
    const doc = parseDOM(html);

    // HLTV's team stats page has a .stats-row list with labels
    let winRate = null, matchesPlayed = 0;
    doc.querySelectorAll('.stats-row').forEach(row => {
      const spans = row.querySelectorAll('span');
      if (spans.length >= 2) {
        const label = spans[0].textContent.trim().toLowerCase();
        const value = spans[1].textContent.trim();
        if (label.includes('win rate')) {
          const m = value.match(/([\d.]+)%/);
          if (m) winRate = parseFloat(m[1]) / 100;
        }
        if (label.includes('total matches') || label.includes('maps played')) {
          const m = value.match(/(\d+)/);
          if (m) matchesPlayed = parseInt(m[1], 10);
        }
      }
    });

    // Recent form: last N match results — look for .recent-result or similar
    const recentForm = [];
    doc.querySelectorAll('.recent-result, .a-reset .result-score').forEach(el => {
      const txt = el.textContent.trim();
      if (/W|L/i.test(txt)) recentForm.push(txt.toUpperCase().includes('W') ? 'W' : 'L');
    });

    return { winRate, matchesPlayed, recentForm: recentForm.slice(0, 10) };
  } catch (err) {
    console.warn('[hltv] fetchTeamStats failed for', teamSlug, err.message);
    return null;
  }
}

// ── Per-Map Win Rates ────────────────────────────────────────────────────────

/**
 * Fetch per-map win rates for a team.
 * @param {string} teamId
 * @param {string} teamSlug
 * @returns {Promise<Record<string, {winRate:number, matches:number}>>}
 */
export async function fetchTeamMapStats(teamId, teamSlug) {
  if (!teamId || !teamSlug) return {};
  try {
    const html = await fetchHTML(`/stats/teams/maps/${teamId}/${teamSlug}`);
    const doc = parseDOM(html);

    const mapStats = {};
    // HLTV's map stats page has .stats-rows with map name + win rate columns
    doc.querySelectorAll('.stats-rows .stats-row, table.stats-table tbody tr').forEach(row => {
      const cells = row.querySelectorAll('span, td');
      if (cells.length < 2) return;

      // Find map name — first cell with a known CS2 map name
      let mapName = null;
      for (const c of cells) {
        const txt = c.textContent.trim().toLowerCase();
        if (/^(mirage|inferno|nuke|ancient|anubis|dust2|vertigo|overpass|train|cache|cobblestone)$/.test(txt)) {
          mapName = txt;
          break;
        }
      }
      if (!mapName) return;

      // Find win rate and matches count in remaining cells
      let winRate = null, matches = 0;
      for (const c of cells) {
        const txt = c.textContent.trim();
        const wrMatch = txt.match(/([\d.]+)%/);
        if (wrMatch && winRate === null) winRate = parseFloat(wrMatch[1]) / 100;
        const numMatch = txt.match(/^(\d+)$/);
        if (numMatch && matches === 0) matches = parseInt(numMatch[1], 10);
      }

      if (winRate !== null) mapStats[mapName] = { winRate, matches };
    });

    return mapStats;
  } catch (err) {
    console.warn('[hltv] fetchTeamMapStats failed for', teamSlug, err.message);
    return {};
  }
}

// ── High-level: fetch everything for one team ───────────────────────────────

/**
 * Fetch rank + stats + map stats for a team, merged into one object.
 * @param {string} polyName – team name as it appears on Polymarket
 * @param {Array} ranking   – cached ranking list from fetchWorldRanking()
 */
export async function getTeamProfile(polyName, ranking) {
  const hltvTeam = findTeamByName(polyName, ranking);
  if (!hltvTeam) {
    return { polyName, rank: null, teamName: polyName, winRate: null, mapStats: {}, recentForm: [] };
  }

  const [stats, mapStats] = await Promise.all([
    fetchTeamStats(hltvTeam.teamId, hltvTeam.teamSlug),
    fetchTeamMapStats(hltvTeam.teamId, hltvTeam.teamSlug),
  ]);

  return {
    polyName,
    rank: hltvTeam.rank,
    teamName: hltvTeam.teamName,
    teamId: hltvTeam.teamId,
    teamSlug: hltvTeam.teamSlug,
    points: hltvTeam.points,
    winRate: stats?.winRate ?? null,
    matchesPlayed: stats?.matchesPlayed ?? 0,
    recentForm: stats?.recentForm ?? [],
    mapStats: mapStats ?? {},
  };
}
