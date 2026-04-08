// ── Configuration ──────────────────────────────────────────────────────────
// All user-adjustable settings are persisted in localStorage.

export const DEFAULTS = {
  minVolume: 20_000,
  oddsFormat: 'american',   // 'american' | 'decimal' | 'prob'
  autoRefresh: true,
  refreshInterval: 900_000,      // 15 min — upcoming games
  liveRefreshInterval: 5_000,    // 5 sec  — live market prices (Polymarket)
  liveScoreInterval: 5_000,      // 5 sec  — live scores (Polymarket / UI clock)
  pandaKey: '',
  game: 'cs2',              // 'cs2' | 'lol'
  view: 'upcoming',         // 'upcoming' | 'live'
  tournamentFilter: 'all',
};

export const POLYMARKET = {
  BASE: '/api/polymarket',   // → api/polymarket.js serverless function
  // Tag slugs that Polymarket uses for each game
  TAGS: {
    cs2: ['cs2', 'counter-strike', 'esports'],
    lol: ['lol', 'league-of-legends', 'esports'],
  },
  // Keywords to detect each game in market questions / event titles
  GAME_KEYWORDS: {
    cs2: ['cs2', 'counter-strike', 'csgo', 'cs:go'],
    lol: ['lol', 'league of legends', 'lck', 'lcs', 'lec', 'ljl'],
  },
  // Known major CS2 tournament organizers / keywords (for "relevance" filtering)
  MAJOR_TOURNAMENTS_CS2: [
    'blast', 'esl', 'pgl', 'iem', 'major', 'pro league', 'faceit',
    'dreamhack', 'ecs', 'cologne', 'katowice', 'rio', 'paris',
    'copenhagen', 'austin', 'dallas', 'opener', 'qualifier',
  ],
  MAJOR_TOURNAMENTS_LOL: [
    'worlds', 'msi', 'lck', 'lcs', 'lec', 'cblol', 'ljl',
    'lco', 'pcs', 'lcl', 'summer', 'spring', 'playoffs',
  ],
};

export const PANDASCORE = {
  BASE: '/api/pandascore',   // → api/pandascore.js serverless function
};

// ── Map metadata ────────────────────────────────────────────────────────────
// Rough CT/T advantage and character description for the map analysis pane.
export const CS2_MAPS = {
  mirage:   { label: 'Mirage',   bias: 'Balanced',   desc: 'Classic tactical map. Slight CT advantage. Strong for structured teams.' },
  inferno:  { label: 'Inferno',  bias: 'CT-sided',   desc: 'Very CT-favoured. Rewards positional play and utility usage.' },
  nuke:     { label: 'Nuke',     bias: 'CT-sided',   desc: 'Heavy CT advantage. Industrial layout rewards disciplined teams.' },
  ancient:  { label: 'Ancient',  bias: 'Balanced',   desc: 'Balanced with some T pressure on B. Favours fast executes.' },
  anubis:   { label: 'Anubis',   bias: 'T-sided',    desc: 'Slightly T-favoured. Fast-aggressive teams exploit open areas well.' },
  dust2:    { label: 'Dust2',    bias: 'Balanced',   desc: 'Iconic open map. Rewards individual aim and mid control.' },
  vertigo:  { label: 'Vertigo',  bias: 'CT-sided',   desc: 'Vertical map. Aggressive rushes and window control are key.' },
  overpass: { label: 'Overpass', bias: 'CT-sided',   desc: 'Large map rewarding slow, methodical setups.' },
  train:    { label: 'Train',    bias: 'CT-sided',   desc: 'Site-to-site quick game. Strong for disciplined rifle teams.' },
};

// ── Edge thresholds ─────────────────────────────────────────────────────────
// When we compare Polymarket prob vs our derived model, how big a gap = an edge?
export const EDGE = {
  STRONG: 0.07,   // ≥7% edge → "Strong Edge"
  SLIGHT: 0.03,   // ≥3% edge → "Slight Edge"
  // below SLIGHT → "Fair"
};

// ── Helpers ─────────────────────────────────────────────────────────────────
export function loadConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem('esportspm_config') || '{}');
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(partial) {
  try {
    const current = loadConfig();
    const next = { ...current, ...partial };
    localStorage.setItem('esportspm_config', JSON.stringify(next));
    return next;
  } catch {
    return loadConfig();
  }
}
