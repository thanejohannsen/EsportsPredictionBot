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
export function analyseEdge(market, profile1 = null, profile2 = null, pickedMaps = []) {
  const [rawP1, rawP2] = market.probs;
  const [fairP1, fairP2] = removeVig(rawP1, rawP2);
  const vig = (rawP1 + rawP2) - 1;

  // Need at least one ranked team for a real model
  if (profile1?.rank && profile2?.rank) {
    const model = computeModelProbability(profile1, profile2, pickedMaps);
    const edge1 = model.p1 - fairP1;
    const edge2 = model.p2 - fairP2;
    return buildEdgeResult(edge1, edge2, fairP1, fairP2, vig, market, {
      hasModelData: true,
      modelP1: model.p1,
      modelP2: model.p2,
      breakdown: model.breakdown,
    });
  }

  // No ranking data → don't fake an edge, just report Fair Market
  return buildEdgeResult(0, 0, fairP1, fairP2, vig, market, {
    hasModelData: false,
    insufficientData: true,
  });
}

/**
 * Derive a fair probability for team1 winning using HLTV data.
 * Combines:
 *   1. Elo-style rank delta (base probability)
 *   2. Per-map win rate advantage on picked maps
 *   3. Recent form momentum
 *
 * @param {object} p1 – HLTV profile for team1
 * @param {object} p2 – HLTV profile for team2
 * @param {string[]} pickedMaps – lowercase map slugs already picked/confirmed
 * @returns {{p1:number, p2:number, breakdown:object}}
 */
export function computeModelProbability(p1, p2, pickedMaps = []) {
  // ── 1. Rank delta (Elo-ish) ──────────────────────────────────────────
  // Smaller rank number = better team. Use points if available for a finer signal.
  const rank1 = p1.rank ?? 30, rank2 = p2.rank ?? 30;
  const rankDelta = rank2 - rank1;  // positive → team1 is better
  // 16-rank gap ≈ ~64/36 split
  const baseP1 = 1 / (1 + Math.pow(10, -rankDelta / 16));

  // ── 2. Map advantage ─────────────────────────────────────────────────
  let mapAdjustment = 0;
  const mapDetails = [];
  if (pickedMaps.length) {
    let deltaSum = 0, count = 0;
    for (const map of pickedMaps) {
      const wr1 = p1.mapStats?.[map]?.winRate;
      const wr2 = p2.mapStats?.[map]?.winRate;
      if (wr1 != null && wr2 != null) {
        const delta = wr1 - wr2;
        deltaSum += delta;
        count++;
        mapDetails.push({ map, wr1, wr2, delta });
      }
    }
    if (count > 0) {
      // Scale: a 20-point win-rate gap moves probability ~8%
      mapAdjustment = (deltaSum / count) * 0.4;
    }
  }

  // ── 3. Recent form adjustment ────────────────────────────────────────
  const form1 = formWinRate(p1.recentForm);
  const form2 = formWinRate(p2.recentForm);
  let formAdjustment = 0;
  if (form1 != null && form2 != null) {
    // Scale: 20pt form gap = ±4% probability swing
    formAdjustment = (form1 - form2) * 0.2;
  }

  // ── Combine and clamp ────────────────────────────────────────────────
  let p1Final = baseP1 + mapAdjustment + formAdjustment;
  p1Final = Math.max(0.05, Math.min(0.95, p1Final));
  const p2Final = 1 - p1Final;

  return {
    p1: p1Final,
    p2: p2Final,
    breakdown: {
      rank1, rank2, rankDelta, baseP1,
      mapAdjustment, mapDetails,
      form1, form2, formAdjustment,
    },
  };
}

function formWinRate(form) {
  if (!Array.isArray(form) || form.length === 0) return null;
  const wins = form.filter(x => x === 'W').length;
  return wins / form.length;
}

function buildEdgeResult(edge1, edge2, fairP1, fairP2, vig, market, extras = {}) {
  const bestEdge = Math.max(edge1, edge2);
  const favouredTeam = edge1 >= edge2 ? market.team1 : market.team2;
  const favouredProb = edge1 >= edge2 ? fairP1 : fairP2;

  let label, cssClass;
  if (extras.insufficientData) {
    label = 'Insufficient Data';
    cssClass = 'edge-fair';
  } else if (bestEdge >= EDGE.STRONG) {
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
    hasModelData: extras.hasModelData ?? false,
    modelP1: extras.modelP1 ?? null,
    modelP2: extras.modelP2 ?? null,
    breakdown: extras.breakdown ?? null,
    insufficientData: extras.insufficientData ?? false,
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
