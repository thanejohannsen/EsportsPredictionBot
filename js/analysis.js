// ── Odds Analysis & Edge Detection ──────────────────────────────────────────
import { EDGE, CS2_MAPS } from './config.js';

// ── Odds Conversion ───────────────────────────────────────────────────────

/**
 * Remove the bookmaker's vig from a pair of raw probabilities.
 * Returns fair (vig-adjusted) probabilities that sum to 1.
 * @param {number} p0 raw probability for outcome 0
 * @param {number} p1 raw probability for outcome 1
 * @returns {[number, number]} fair probabilities
 */
export function removeVig(p0, p1) {
  const total = p0 + p1;
  if (total <= 0) return [0.5, 0.5];
  return [p0 / total, p1 / total];
}

/**
 * Convert a probability (0–1) to American odds.
 * e.g. 0.6 → -150, 0.4 → +150
 * @param {number} prob
 * @returns {string}
 */
export function toAmerican(prob) {
  if (prob <= 0 || prob >= 1) return '—';
  if (prob >= 0.5) {
    const odds = Math.round(-(prob / (1 - prob)) * 100);
    return odds.toString();     // negative, e.g. "-150"
  } else {
    const odds = Math.round(((1 - prob) / prob) * 100);
    return `+${odds}`;
  }
}

/**
 * Convert a probability to European decimal odds.
 * e.g. 0.4 → "2.50"
 * @param {number} prob
 * @returns {string}
 */
export function toDecimal(prob) {
  if (prob <= 0) return '—';
  return (1 / prob).toFixed(2);
}

/**
 * Format a probability as a percentage string.
 * @param {number} prob
 * @returns {string}
 */
export function toPercent(prob) {
  return `${Math.round(prob * 100)}%`;
}

/**
 * Format odds in the user's preferred format.
 * @param {number} prob
 * @param {'american'|'decimal'|'prob'} format
 * @returns {string}
 */
export function formatOdds(prob, format) {
  switch (format) {
    case 'decimal': return toDecimal(prob);
    case 'prob':    return toPercent(prob);
    default:        return toAmerican(prob);
  }
}

// ── Edge Detection ────────────────────────────────────────────────────────

/**
 * Classify how the Polymarket implied probability compares to an estimated
 * "fair" probability. Returns an edge object.
 *
 * If PandaScore team stats are available, we use win-rate derived probabilities.
 * Otherwise, we use the Polymarket probabilities themselves and look for
 * market structure signals (vig, volume, liquidity).
 *
 * @param {NormMarket} market     – the ML market
 * @param {TeamStats|null} stats1 – PandaScore stats for team 1
 * @param {TeamStats|null} stats2 – PandaScore stats for team 2
 * @returns {EdgeResult}
 */
export function analyseEdge(market, stats1 = null, stats2 = null) {
  const [rawP1, rawP2] = market.probs;
  const [fairP1, fairP2] = removeVig(rawP1, rawP2);

  // Vig (overround): how much the market maker takes
  const vig = (rawP1 + rawP2) - 1;

  if (stats1 && stats2 && stats1.recentWinRate !== null && stats2.recentWinRate !== null) {
    // ── Model-based edge ──────────────────────────────────────────────────
    // Normalise stats win rates to sum to 1 (as a relative strength ratio)
    const total = stats1.recentWinRate + stats2.recentWinRate;
    const modelP1 = total > 0 ? stats1.recentWinRate / total : 0.5;
    const modelP2 = 1 - modelP1;

    const edge1 = modelP1 - fairP1;   // positive → market undervaluing team 1
    const edge2 = modelP2 - fairP2;

    return buildEdgeResult(edge1, edge2, fairP1, fairP2, vig, market);
  }

  // ── Market-structure signals (no external stats) ──────────────────────
  // Check for common market inefficiencies:
  //  1. Low liquidity relative to volume → less efficient pricing
  //  2. Large spread between bid/ask (if available)
  //  3. Extreme favourite (e.g. >80%) in a low-volume market

  const liquidityRatio = market.volume > 0 ? market.liquidity / market.volume : 1;
  const isExtremeFavourite = fairP1 > 0.8 || fairP2 > 0.8;
  const isLowLiquidity = market.liquidity < 5_000;

  let edge1 = 0;
  if (isExtremeFavourite && isLowLiquidity) {
    // Underdog might have slight value in low-liquidity markets
    edge1 = fairP1 > 0.8 ? 0.03 : -0.03;  // slight edge on underdog
  }

  return buildEdgeResult(edge1, -edge1, fairP1, fairP2, vig, market);
}

function buildEdgeResult(edge1, edge2, fairP1, fairP2, vig, market) {
  // The team with the largest positive edge is the recommended pick
  const bestEdge = Math.max(edge1, edge2);
  const favouredTeam = edge1 >= edge2 ? market.team1 : market.team2;
  const favouredProb = edge1 >= edge2 ? fairP1 : fairP2;

  let label, cssClass;
  if (bestEdge >= EDGE.STRONG) {
    label = 'Strong Edge';
    cssClass = 'edge-strong';
  } else if (bestEdge >= EDGE.SLIGHT) {
    label = 'Slight Edge';
    cssClass = 'edge-slight';
  } else if (bestEdge <= -EDGE.STRONG) {
    label = 'Avoid';
    cssClass = 'edge-negative';
  } else {
    label = 'Fair Market';
    cssClass = 'edge-fair';
  }

  return {
    team1Edge: edge1,
    team2Edge: edge2,
    bestEdge,
    favouredTeam,
    favouredProb,
    label,
    cssClass,
    fairP1,
    fairP2,
    vig,
    hasModelData: false,
  };
}

/**
 * Compute a team's recent win rate from their last N PandaScore matches.
 * @param {NormPandaMatch[]} recentMatches
 * @param {string} teamName
 * @returns {number|null}
 */
export function computeWinRate(recentMatches, teamName) {
  if (!recentMatches?.length) return null;

  let wins = 0, total = 0;
  for (const match of recentMatches) {
    if (match.status !== 'finished') continue;
    const score = match.seriesScore?.[teamName];
    if (score === undefined) continue;
    total++;
    const opponentScores = Object.values(match.seriesScore).filter(s => s !== score);
    if (opponentScores.length && score > opponentScores[0]) wins++;
  }

  return total >= 3 ? wins / total : null;
}

// ── Map Analysis ──────────────────────────────────────────────────────────

/**
 * Analyse a CS2 match's map picks/bans and return a summary.
 *
 * mapVeto format (from PandaScore or constructed manually):
 *   [{ team: 'G2' | 'NaVi', action: 'pick'|'ban', map: 'mirage' }, ...]
 *
 * @param {VetoEntry[]} veto
 * @param {string} team1
 * @param {string} team2
 * @returns {MapAnalysis}
 */
export function analyseMapVeto(veto, team1, team2) {
  if (!veto?.length) return { entries: [], summary: '', pickedMaps: [] };

  const entries = veto.map((v, i) => {
    const mapMeta = CS2_MAPS[v.map?.toLowerCase()] ?? { label: v.map, bias: 'Unknown', desc: '' };
    const isTeam1 = normaliseTeamName(v.team ?? '') === normaliseTeamName(team1);
    return {
      order: i + 1,
      team: v.team,
      action: v.action,        // 'pick' | 'ban'
      map: v.map,
      mapLabel: mapMeta.label,
      mapBias: mapMeta.bias,
      mapDesc: mapMeta.desc,
      isTeam1Pick: isTeam1 && v.action === 'pick',
      isTeam2Pick: !isTeam1 && v.action === 'pick',
    };
  });

  const picks = entries.filter(e => e.action === 'pick');
  const bans  = entries.filter(e => e.action === 'ban');

  // Which team picked maps that suit their style (based on bias matching)?
  const team1Picks = picks.filter(e => e.isTeam1Pick);
  const team2Picks = picks.filter(e => e.isTeam2Pick);

  const summaryParts = [];
  if (team1Picks.length) summaryParts.push(`${team1} picked ${team1Picks.map(e => e.mapLabel).join(', ')}`);
  if (team2Picks.length) summaryParts.push(`${team2} picked ${team2Picks.map(e => e.mapLabel).join(', ')}`);

  return {
    entries,
    picks,
    bans,
    pickedMaps: picks.map(e => e.map),
    team1Picks,
    team2Picks,
    summary: summaryParts.join(' · ') || 'Veto in progress',
  };
}

/**
 * Build a veto array from a PandaScore normalised match's games array.
 * PandaScore records picks/bans in the games array in order.
 *
 * Note: PandaScore's free tier may not include detailed veto data.
 * If map data is missing, games will only have the played maps.
 *
 * @param {NormPandaMatch} match
 * @returns {VetoEntry[]}
 */
export function buildVetoFromPanda(match) {
  if (!match?.games?.length) return [];

  return match.games
    .filter(g => g.mapName)
    .map(g => ({
      team: g.winner ?? match.opponents[0]?.name ?? '',
      action: 'pick',   // PandaScore free tier doesn't always include bans
      map: g.mapSlug ?? g.mapName?.toLowerCase(),
    }));
}

// ── Formatting helpers ────────────────────────────────────────────────────

export function formatVolume(n) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

export function formatDate(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (isNaN(d)) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function timeUntil(isoString) {
  if (!isoString) return null;
  const ms = new Date(isoString) - Date.now();
  if (ms < 0) return null;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function normaliseTeamName(name) {
  return name.toLowerCase().replace(/\s+esports?$/i, '').replace(/\s+gaming$/i, '').replace(/\s+/g, '').trim();
}
