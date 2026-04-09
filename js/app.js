// ── Main Application ─────────────────────────────────────────────────────────
import { loadConfig, saveConfig, POLYMARKET, CS2_MAPS } from './config.js';
import { getEnrichedEvents, parseTournamentName, setLiveMode, inferSeriesScore } from './polymarket.js';
import {
  setPandaKey, hasPandaKey,
  fetchLiveMatches, fetchUpcomingMatches,
  normalisePandaMatch, findPolymarketMatch,
} from './pandascore.js';
import {
  analyseEdge, analyseMapVeto, buildVetoFromPanda,
  removeVig, formatOdds, formatVolume, formatDate, timeUntil,
  toAmerican, toDecimal, toPercent,
} from './analysis.js';

// ── State ─────────────────────────────────────────────────────────────────

let cfg = loadConfig();
let _marketRefreshTimer  = null;  // full data refresh (view-dependent interval)
let _liveScoreTimer      = null;  // fast PandaScore score poll (live only, 5 s)
let _clockTimer          = null;  // 1-second UI clock for countdowns
let _loading = false;

// Cached data
let _polyEvents   = [];   // GameEvent[] from Polymarket
let _pandaMatches = [];   // NormPandaMatch[] from PandaScore

// ── Boot ──────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  applyConfig();
  if (cfg.pandaKey) setPandaKey(cfg.pandaKey);

  App.refresh();
  scheduleAutoRefresh();
});

function applyConfig() {
  // Odds format buttons
  document.querySelectorAll('.odds-fmt, .settings-odds-btn').forEach(btn => {
    const active = btn.dataset.fmt === cfg.oddsFormat;
    btn.classList.toggle('bg-surface-600', active);
    btn.classList.toggle('text-slate-200', active);
    btn.classList.toggle('text-slate-400', !active);
  });

  // Game tabs
  document.querySelectorAll('.game-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.game === cfg.game);
    t.classList.toggle('text-slate-400', t.dataset.game !== cfg.game);
  });

  // View tabs
  document.querySelectorAll('.view-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === cfg.view);
    t.classList.toggle('text-slate-400', t.dataset.view !== cfg.view);
  });

  // Auto-refresh
  const toggle = document.getElementById('auto-refresh-toggle');
  if (toggle) toggle.checked = cfg.autoRefresh;

  // Min volume select
  document.querySelectorAll('#min-volume-select, #settings-min-volume').forEach(el => {
    el.value = String(cfg.minVolume);
  });

  // Tournament filter
  const tf = document.getElementById('tournament-filter');
  if (tf) tf.value = cfg.tournamentFilter;

  // Settings PandaScore key
  const keyInput = document.getElementById('panda-key-input');
  if (keyInput && cfg.pandaKey) keyInput.value = cfg.pandaKey;
}

// ── Public API (called from inline onclick in HTML) ───────────────────────

const App = {
  async refresh() {
    if (_loading) return;
    await loadData();
    renderCards();
  },

  switchGame(game) {
    cfg = saveConfig({ game });
    applyConfig();
    App.refresh();
  },

  switchView(view) {
    cfg = saveConfig({ view });
    applyConfig();
    renderCards();
  },

  setOddsFormat(fmt) {
    cfg = saveConfig({ oddsFormat: fmt });
    applyConfig();
    renderCards();   // re-render to show new format
  },

  setMinVolume(val) {
    cfg = saveConfig({ minVolume: Number(val) });
    applyConfig();
    renderCards();
  },

  setTournamentFilter(val) {
    cfg = saveConfig({ tournamentFilter: val });
    applyConfig();
    renderCards();
  },

  toggleAutoRefresh(checked) {
    cfg = saveConfig({ autoRefresh: checked });
    scheduleAutoRefresh();
  },

  savePandaKey() {
    const val = document.getElementById('panda-key-input')?.value?.trim() ?? '';
    cfg = saveConfig({ pandaKey: val });
    setPandaKey(val);
    const status = document.getElementById('panda-key-status');
    if (status) {
      status.textContent = val ? '✓ Saved. Refreshing data…' : 'Key cleared.';
      status.className = val ? 'mt-1.5 text-xs text-green-400' : 'mt-1.5 text-xs text-slate-400';
    }
    App.refresh();
  },

  openSettings() {
    document.getElementById('settings-modal').style.display = 'flex';
    const input = document.getElementById('panda-key-input');
    if (input && cfg.pandaKey) {
      input.value = cfg.pandaKey;
    }
  },

  closeSettings() {
    document.getElementById('settings-modal').style.display = 'none';
  },

  dismissError() {
    document.getElementById('error-banner').classList.add('hidden');
  },

  // Toggle expand/collapse of sub-markets panel
  toggleSubmarkets(btn) {
    const panel = btn.closest('.game-card').querySelector('.submarkets-panel');
    const arrow = btn.querySelector('.arrow-icon');
    if (panel) {
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
      if (arrow) arrow.style.transform = open ? '' : 'rotate(180deg)';
      btn.textContent = open ? '▼ Sub-markets' : '▲ Hide';
      btn.innerHTML = `<svg class="arrow-icon w-3 h-3 mr-1 transition-transform ${open ? '' : 'rotate-180'}" style="display:inline-block; transition:transform 0.2s" fill="none" stroke="currentColor" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>${open ? 'Sub-markets' : 'Hide sub-markets'}`;
    }
  },
};

window.App = App;

// ── Auto-refresh ──────────────────────────────────────────────────────────

function scheduleAutoRefresh() {
  clearInterval(_marketRefreshTimer);
  clearInterval(_liveScoreTimer);
  clearInterval(_clockTimer);

  if (!cfg.autoRefresh) return;

  const isLive = cfg.view === 'live';

  // Full market data refresh — 5 s on live tab, 15 min on upcoming tab
  const marketInterval = isLive ? cfg.liveRefreshInterval : cfg.refreshInterval;
  _marketRefreshTimer = setInterval(() => loadData(true).then(renderCards), marketInterval);

  // 1-second clock: just updates countdown text without any API call
  _clockTimer = setInterval(updateCountdowns, 1_000);
}

/** Update only the countdown <span> elements in place — no re-render. */
function updateCountdowns() {
  document.querySelectorAll('[data-countdown]').forEach(el => {
    const iso = el.dataset.countdown;
    const until = timeUntil(iso);
    el.textContent = until ? `⏱ ${until}` : '';
  });
}

// ── Data Loading ──────────────────────────────────────────────────────────

async function loadData(silent = false) {
  _loading = true;
  if (!silent) showLoading(true);
  setRefreshSpinner(true);

  try {
    // Tell polymarket client whether we're in live mode (shorter cache TTL)
    setLiveMode(cfg.view === 'live');

    // Always fetch Polymarket events
    const polyPromise = getEnrichedEvents(cfg.game, 0);   // filter by volume in renderCards

    // Optionally fetch PandaScore matches
    let pandaPromise = Promise.resolve([]);
    if (hasPandaKey()) {
      const view = cfg.view;
      pandaPromise = view === 'live'
        ? fetchLiveMatches(cfg.game).then(arr => arr.map(normalisePandaMatch))
        : fetchUpcomingMatches(cfg.game).then(arr => arr.map(normalisePandaMatch));
    }

    [_polyEvents, _pandaMatches] = await Promise.all([polyPromise, pandaPromise]);

    // Link PandaScore matches to Polymarket events
    for (const panda of _pandaMatches) {
      const ev = findPolymarketMatch(panda, _polyEvents);
      if (ev) ev.pandaMatch = panda;
    }

    updateLastUpdated();
    clearError();
  } catch (err) {
    showError(err.message || 'Failed to load data.');
    console.error('EsportsPM load error:', err);
  } finally {
    _loading = false;
    if (!silent) showLoading(false);
    setRefreshSpinner(false);
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderCards() {
  const container = document.getElementById('cards-container');
  if (!container) return;

  // For Live tab: use ev.live directly — ignore volume filter (live games often have low volume)
  let events;
  if (cfg.view === 'live') {
    events = _polyEvents.filter(isLikelyLive);
    console.log(`[renderCards] live view: ${events.length} events`);
    updateLiveBadge(events.length);
  } else {
    events = filterEvents(_polyEvents).filter(ev => !ev.live); // hide live ones from upcoming
    updateLiveBadge(_polyEvents.filter(isLikelyLive).length);
  }

  if (events.length === 0) {
    container.innerHTML = '';
    showEmpty(true);
    return;
  }

  showEmpty(false);

  container.innerHTML = events
    .map(ev => cfg.view === 'live'
      ? renderLiveCard(ev)
      : renderUpcomingCard(ev)
    )
    .join('');

  // Animate cards in
  container.querySelectorAll('.game-card').forEach((el, i) => {
    el.style.animationDelay = `${i * 0.04}s`;
    el.classList.add('animate-fadein');
  });
}

// ── Event filtering ───────────────────────────────────────────────────────

function filterEvents(events) {
  return events.filter(ev => {
    // Volume filter
    if (ev.totalVolume < cfg.minVolume) return false;

    // Tournament filter
    if (cfg.tournamentFilter !== 'all') {
      const title = ev.title.toLowerCase();
      if (!title.includes(cfg.tournamentFilter)) return false;
    }

    return true;
  });
}

function isLikelyLive(ev) {
  // Polymarket sets live=true on events that are actually in progress
  return ev.live === true && !ev.closed && !ev.ended;
}

// ── Card Renderers ────────────────────────────────────────────────────────

function renderUpcomingCard(ev) {
  const ml = ev.markets.find(m => m.subtype === 'ml');
  const totalMaps = ev.markets.find(m => m.subtype === 'total_maps');
  const map1 = ev.markets.find(m => m.subtype === 'map1');
  const otherMarkets = ev.markets.filter(m => !['ml'].includes(m.subtype) && m.subtype !== 'other');

  const tournament = parseTournamentName(ev.title);
  const startTime = ev.startDate ?? ev.endDate;
  const countdown = timeUntil(startTime);
  const dateStr = formatDate(startTime);

  if (!ml) return renderTournamentCard(ev);

  const [rawP1, rawP2] = ml.probs;
  const [fp1, fp2] = removeVig(rawP1, rawP2);
  const edge = analyseEdge(ml, null, null);

  const t1Name = ml.team1;
  const t2Name = ml.team2;
  const t1IsWinner = fp1 > fp2;

  const pandaMatch = ev.pandaMatch;

  return `
<div class="game-card card rounded-2xl overflow-hidden" data-event-id="${ev.id}">
  <!-- Top bar -->
  <div class="flex items-center justify-between px-5 pt-4 pb-2">
    <div class="flex items-center gap-2">
      ${tournamentBadge(tournament)}
      ${pandaMatch?.league?.imageUrl ? `<img src="${pandaMatch.league.imageUrl}" class="h-4 w-4 object-contain opacity-70" alt="" />` : ''}
    </div>
    <div class="flex items-center gap-3 text-xs text-slate-500">
      ${countdown ? `<span class="text-brand-cs2 font-semibold">⏱ ${countdown}</span>` : ''}
      <span>${dateStr}</span>
      ${volumeBadge(ev.totalVolume)}
    </div>
  </div>

  <!-- Teams & Odds -->
  <div class="px-5 pb-4">
    <div class="flex items-center gap-4">

      <!-- Team 1 -->
      <div class="flex-1 text-right">
        <div class="text-base font-bold ${t1IsWinner ? 'text-slate-100' : 'text-slate-400'} mb-1 truncate">${escHtml(t1Name)}</div>
        <div class="text-2xl font-extrabold font-mono ${t1IsWinner ? 'text-slate-100' : 'text-slate-500'}">
          ${formatOdds(fp1, cfg.oddsFormat)}
        </div>
        ${rawOddsRow(fp1, cfg.oddsFormat)}
      </div>

      <!-- Middle -->
      <div class="flex flex-col items-center gap-2 w-20 flex-shrink-0">
        <!-- Odds bar -->
        <div class="w-full h-2 rounded-full bg-surface-500 overflow-hidden flex">
          <div class="odds-bar-fill h-full rounded-full" style="width:${Math.round(fp1*100)}%; background: linear-gradient(90deg, #00d4ff, #22d972);"></div>
        </div>
        <span class="text-xs text-slate-500 font-medium">VS</span>
        <div class="text-center">
          ${edgeBadge(edge)}
        </div>
      </div>

      <!-- Team 2 -->
      <div class="flex-1">
        <div class="text-base font-bold ${!t1IsWinner ? 'text-slate-100' : 'text-slate-400'} mb-1 truncate">${escHtml(t2Name)}</div>
        <div class="text-2xl font-extrabold font-mono ${!t1IsWinner ? 'text-slate-100' : 'text-slate-500'}">
          ${formatOdds(fp2, cfg.oddsFormat)}
        </div>
        ${rawOddsRow(fp2, cfg.oddsFormat)}
      </div>

    </div>

    <!-- Pick recommendation -->
    ${renderPickRecommendation(edge, t1Name, t2Name, fp1, fp2)}

  </div>

  <!-- Sub-markets row (Map 1, total maps, etc.) -->
  ${otherMarkets.length > 0 || totalMaps || map1 ? `
  <div class="border-t border-white/5 px-5 py-3">
    <button
      class="flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors mb-0"
      onclick="App.toggleSubmarkets(this)"
    >
      <svg class="arrow-icon w-3 h-3 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
      Sub-markets
    </button>
    <div class="submarkets-panel hidden mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
      ${[...otherMarkets, totalMaps, map1].filter(Boolean).map(m => subMarketChip(m)).join('')}
    </div>
  </div>` : ''}
</div>`;
}

function renderLiveCard(ev) {
  const ml = ev.markets.find(m => m.subtype === 'ml');
  const totalMaps = ev.markets.find(m => m.subtype === 'total_maps');
  const mapMarkets = ev.markets.filter(m => ['map1','map2','map3','map_winner'].includes(m.subtype));

  const tournament = parseTournamentName(ev.title);
  const panda = ev.pandaMatch;

  if (!ml) return renderTournamentCard(ev);

  const [rawP1, rawP2] = ml.probs;
  const [fp1, fp2] = removeVig(rawP1, rawP2);

  const t1Name = ml.team1;
  const t2Name = ml.team2;

  // Map veto / game progress from PandaScore (if key provided)
  const veto = panda ? buildVetoFromPanda(panda) : [];
  const mapAnalysis = analyseMapVeto(veto, t1Name, t2Name);

  // Series + round scores — parsed from Polymarket's "000-000|1-0|Bo3" format
  let score1 = 0, score2 = 0;
  let round1 = null, round2 = null, bestOf = null;
  if (ev.scoreParsed) {
    [score1, score2] = ev.scoreParsed.seriesScore;
    [round1, round2] = ev.scoreParsed.roundScore;
    bestOf = ev.scoreParsed.bestOf;
  } else {
    ({ score1, score2 } = inferSeriesScore(ev.markets, t1Name, t2Name));
  }

  return `
<div class="game-card card rounded-2xl overflow-hidden border-l-2 border-brand-red" data-event-id="${ev.id}">

  <!-- Header -->
  <div class="flex items-center justify-between px-5 pt-4 pb-2">
    <div class="flex items-center gap-2">
      <span class="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-bold" style="background:rgba(255,70,85,0.15); color:#ff4655;">
        <span class="w-1.5 h-1.5 rounded-full bg-brand-red animate-live inline-block"></span>LIVE
      </span>
      ${tournamentBadge(tournament)}
    </div>
    <div class="flex items-center gap-3">
      ${volumeBadge(ev.totalVolume)}
    </div>
  </div>

  <!-- Teams & Series Score -->
  <div class="px-5 pb-3">
    <div class="flex items-center justify-between gap-4">
      <div class="flex-1 text-right">
        <div class="font-bold text-base text-slate-100 truncate">${escHtml(t1Name)}</div>
        <div class="text-3xl font-extrabold text-slate-100 mt-1">${score1}</div>
        ${round1 !== null ? `<div class="text-sm text-brand-cyan font-mono mt-0.5">${round1} rounds</div>` : ''}
      </div>
      <div class="flex flex-col items-center gap-1 w-16 flex-shrink-0">
        <span class="text-slate-500 text-xs font-semibold uppercase tracking-wider">Maps${bestOf ? ` (Bo${bestOf})` : ''}</span>
        <span class="text-slate-300 text-sm">:</span>
      </div>
      <div class="flex-1">
        <div class="font-bold text-base text-slate-100 truncate">${escHtml(t2Name)}</div>
        <div class="text-3xl font-extrabold text-slate-100 mt-1">${score2}</div>
        ${round2 !== null ? `<div class="text-sm text-brand-cyan font-mono mt-0.5">${round2} rounds</div>` : ''}
      </div>
    </div>
  </div>

  <!-- Map Veto Section -->
  ${panda || veto.length > 0 ? `
  <div class="border-t border-white/5 px-5 py-3">
    <div class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Map Veto</div>
    ${renderMapVeto(mapAnalysis, panda, t1Name, t2Name)}
    ${mapAnalysis.summary ? `<p class="text-xs text-slate-500 mt-2 italic">${escHtml(mapAnalysis.summary)}</p>` : ''}
  </div>` : ''}

  <!-- Polymarket Odds -->
  <div class="border-t border-white/5 px-5 py-3">
    <div class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Polymarket Odds</div>
    <div class="grid grid-cols-3 gap-2 mb-3">
      <!-- ML -->
      <div class="bg-surface-700 rounded-xl p-3 text-center">
        <div class="text-xs text-slate-500 mb-1 font-medium">Match ML</div>
        <div class="font-bold text-sm">${escHtml(t1Name.split(' ')[0])}</div>
        <div class="font-extrabold text-lg font-mono text-slate-100">${formatOdds(fp1, cfg.oddsFormat)}</div>
        <div class="w-full h-1 rounded-full bg-surface-500 mt-2 overflow-hidden">
          <div class="h-full rounded-full" style="width:${Math.round(fp1*100)}%; background:linear-gradient(90deg,#00d4ff,#22d972);"></div>
        </div>
        <div class="text-xs text-slate-500 mt-1">${escHtml(t2Name.split(' ')[0])} ${formatOdds(fp2, cfg.oddsFormat)}</div>
      </div>

      <!-- Map markets -->
      ${mapMarkets.slice(0, 1).map(m => `
      <div class="bg-surface-700 rounded-xl p-3 text-center">
        <div class="text-xs text-slate-500 mb-1 font-medium">${subtypeLabel(m.subtype)}</div>
        <div class="font-bold text-sm">${escHtml(m.team1.split(' ')[0])}</div>
        <div class="font-extrabold text-lg font-mono text-slate-100">${formatOdds(removeVig(m.probs[0], m.probs[1])[0], cfg.oddsFormat)}</div>
        <div class="text-xs text-slate-500 mt-1">${escHtml(m.team2.split(' ')[0])} ${formatOdds(removeVig(m.probs[0], m.probs[1])[1], cfg.oddsFormat)}</div>
      </div>
      `).join('')}

      <!-- 2.5+ maps -->
      ${totalMaps ? `
      <div class="bg-surface-700 rounded-xl p-3 text-center">
        <div class="text-xs text-slate-500 mb-1 font-medium">Maps 2.5+</div>
        <div class="font-bold text-sm text-slate-300">Over</div>
        <div class="font-extrabold text-lg font-mono text-slate-100">${formatOdds(totalMaps.probs[0], cfg.oddsFormat)}</div>
        <div class="text-xs text-slate-500 mt-1">Under ${formatOdds(totalMaps.probs[1], cfg.oddsFormat)}</div>
      </div>` : `
      <div class="bg-surface-700 rounded-xl p-3 text-center opacity-40">
        <div class="text-xs text-slate-500 mb-1">Maps 2.5+</div>
        <div class="text-slate-400 text-sm mt-3">—</div>
      </div>`}
    </div>

    <!-- Map analysis note -->
    ${renderMapAnalysisNote(mapAnalysis, t1Name, t2Name)}
  </div>

  <!-- Additional sub-markets -->
  ${mapMarkets.length > 1 ? `
  <div class="border-t border-white/5 px-5 py-3">
    <button class="flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors" onclick="App.toggleSubmarkets(this)">
      <svg class="arrow-icon w-3 h-3 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
      More map markets
    </button>
    <div class="submarkets-panel hidden mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
      ${mapMarkets.slice(1).map(m => subMarketChip(m)).join('')}
    </div>
  </div>` : ''}
</div>`;
}

// Tournament winner card (no ML market)
function renderTournamentCard(ev) {
  const topMarkets = ev.markets
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 5);

  return `
<div class="game-card card rounded-2xl overflow-hidden" data-event-id="${ev.id}">
  <div class="px-5 pt-4 pb-2 flex items-center justify-between">
    <div class="font-bold text-base text-slate-100 truncate flex-1 mr-4">${escHtml(ev.title)}</div>
    ${volumeBadge(ev.totalVolume)}
  </div>
  <div class="px-5 pb-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
    ${topMarkets.map(m => `
    <div class="bg-surface-700 rounded-xl p-3">
      <div class="text-xs text-slate-400 mb-1 truncate">${escHtml(m.outcomes[0] ?? m.question.slice(0, 30))}</div>
      <div class="font-extrabold text-lg font-mono">${formatOdds(m.probs[0], cfg.oddsFormat)}</div>
      <div class="text-xs text-slate-500">${formatVolume(m.volume)}</div>
    </div>`).join('')}
  </div>
</div>`;
}

// ── Sub-components ────────────────────────────────────────────────────────

function tournamentBadge(name) {
  const short = name.length > 28 ? name.slice(0, 28) + '…' : name;
  return `<span class="text-xs font-medium text-slate-400 bg-surface-600 px-2 py-0.5 rounded">${escHtml(short)}</span>`;
}

function volumeBadge(vol) {
  return `<span class="text-xs font-semibold text-slate-500 whitespace-nowrap">${formatVolume(vol)}</span>`;
}

function edgeBadge(edge) {
  return `<span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${edge.cssClass}">${edge.label}</span>`;
}

function subMarketChip(m) {
  const [fp1, fp2] = removeVig(m.probs[0], m.probs[1]);
  return `
<div class="bg-surface-700 rounded-lg p-2.5 text-xs">
  <div class="text-slate-500 font-medium mb-1">${subtypeLabel(m.subtype)}</div>
  <div class="flex items-center justify-between gap-2">
    <span class="truncate font-semibold text-slate-200">${escHtml((m.team1 || m.outcomes[0] || '').slice(0, 12))}</span>
    <span class="font-mono font-bold text-slate-100">${formatOdds(fp1, cfg.oddsFormat)}</span>
  </div>
  <div class="flex items-center justify-between gap-2 mt-0.5">
    <span class="truncate text-slate-400">${escHtml((m.team2 || m.outcomes[1] || '').slice(0, 12))}</span>
    <span class="font-mono text-slate-400">${formatOdds(fp2, cfg.oddsFormat)}</span>
  </div>
  <div class="text-slate-600 mt-1">${formatVolume(m.volume)}</div>
</div>`;
}

function subtypeLabel(subtype) {
  const MAP = {
    map1: 'Map 1', map2: 'Map 2', map3: 'Map 3',
    map_winner: 'Map Winner', total_maps: 'Maps 2.5+',
    ml: 'Moneyline', handicap: 'Handicap', other: 'Market',
  };
  return MAP[subtype] ?? 'Market';
}

function rawOddsRow(prob, format) {
  // Show a secondary line with the "raw" probability for context
  const pct = toPercent(prob);
  return `<div class="text-xs text-slate-500 mt-0.5">${pct} implied</div>`;
}

function renderPickRecommendation(edge, t1Name, t2Name, fp1, fp2) {
  if (edge.label === 'Fair Market') return '';

  const pickedTeam = fp1 > fp2 ? t1Name : t2Name;
  const pickedProb = fp1 > fp2 ? fp1 : fp2;
  const icon = edge.cssClass === 'edge-strong' ? '🔥' : edge.cssClass === 'edge-slight' ? '✅' : '⚠️';

  return `
<div class="mt-3 flex items-center gap-2 p-2.5 rounded-lg" style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06);">
  <span class="text-base">${icon}</span>
  <div class="text-sm">
    <span class="font-semibold text-slate-200">${escHtml(pickedTeam)}</span>
    <span class="text-slate-400"> is the market favourite at </span>
    <span class="font-mono font-bold text-slate-100">${toPercent(pickedProb)}</span>
    <span class="text-slate-400"> — </span>
    <span class="${edge.cssClass} font-medium">${edge.label}</span>
  </div>
</div>`;
}

function renderMapVeto(mapAnalysis, panda, t1Name, t2Name) {
  if (!panda?.games?.length && !mapAnalysis.entries.length) {
    return '<p class="text-xs text-slate-500 italic">Map veto data unavailable.</p>';
  }

  // Use PandaScore games array to show map-by-map status
  const games = panda?.games ?? [];
  const bestOf = panda?.numberOfGames ?? 3;

  if (games.length > 0) {
    return games.map((g, i) => {
      const mapInfo = CS2_MAPS[g.mapSlug] ?? {};
      const statusIcon = g.status === 'finished' ? '✓' :
                         g.status === 'running'  ? '▶' : '•';
      const colorClass = g.status === 'finished' ? 'text-green-400' :
                         g.status === 'running'  ? 'text-brand-cyan' : 'text-slate-500';
      const borderClass = g.status === 'running' ? 'map-current' : g.status === 'finished' ? 'map-pick' : 'map-remaining';

      return `
<div class="flex items-center gap-3 py-2 px-3 rounded-lg bg-surface-700 mb-1.5 ${borderClass}">
  <span class="text-xs font-bold w-4 ${colorClass}">${statusIcon}</span>
  <div class="flex-1 min-w-0">
    <div class="flex items-center gap-2">
      <span class="font-semibold text-sm text-slate-200">${escHtml(g.mapName ?? `Map ${i+1}`)}</span>
      ${mapInfo.bias ? `<span class="text-xs text-slate-500">${mapInfo.bias}</span>` : ''}
      ${g.status === 'running' ? '<span class="text-xs px-1.5 py-0.5 rounded" style="background:rgba(0,212,255,0.15); color:#00d4ff; font-weight:600;">LIVE</span>' : ''}
    </div>
    ${mapInfo.desc ? `<div class="text-xs text-slate-500 mt-0.5">${mapInfo.desc}</div>` : ''}
  </div>
  ${g.status === 'finished' && g.winner ? `
  <div class="text-right flex-shrink-0">
    <div class="text-xs font-semibold text-green-400">${escHtml(g.winner)}</div>
    <div class="text-xs text-slate-500">won</div>
  </div>` : ''}
  ${g.teams?.length >= 2 ? `
  <div class="text-right flex-shrink-0 font-mono text-sm font-bold text-slate-200">
    ${g.teams[0]?.score ?? '—'} – ${g.teams[1]?.score ?? '—'}
  </div>` : ''}
</div>`;
    }).join('');
  }

  // Fallback: show analysis entries (no PandaScore data)
  return mapAnalysis.entries.map(e => `
<div class="flex items-center gap-2 py-1.5 px-3 rounded bg-surface-700 mb-1 ${e.action === 'pick' ? 'map-pick' : 'map-ban'}">
  <span class="text-xs ${e.action === 'pick' ? 'text-green-400' : 'text-red-400'}">${e.action === 'pick' ? 'PICK' : 'BAN'}</span>
  <span class="text-sm font-semibold text-slate-200">${escHtml(e.mapLabel ?? e.map)}</span>
  <span class="text-xs text-slate-400 ml-auto">by ${escHtml(e.team)}</span>
</div>`).join('');
}

function renderMapAnalysisNote(mapAnalysis, t1Name, t2Name) {
  if (!mapAnalysis?.picks?.length) return '';

  const notes = [];

  for (const pick of mapAnalysis.picks) {
    const info = CS2_MAPS[pick.map?.toLowerCase()];
    if (!info) continue;

    const picker = pick.isTeam1Pick ? t1Name : t2Name;
    notes.push(`${escHtml(picker)} picked <strong>${info.label}</strong> (${info.bias}): ${info.desc}`);
  }

  if (!notes.length) return '';

  return `
<div class="mt-2 p-3 rounded-lg text-xs text-slate-400 space-y-1.5" style="background:rgba(0,212,255,0.04); border:1px solid rgba(0,212,255,0.1);">
  <div class="font-semibold text-brand-cyan mb-1.5">📊 Map Analysis</div>
  ${notes.map(n => `<div>• ${n}</div>`).join('')}
</div>`;
}

// ── UI Helpers ────────────────────────────────────────────────────────────

function showLoading(on) {
  document.getElementById('loading-state').style.display = on ? 'block' : 'none';
  document.getElementById('cards-container').style.display = on ? 'none' : 'block';
}

function showEmpty(on) {
  document.getElementById('empty-state').style.display = on ? 'flex' : 'none';
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  document.getElementById('error-text').textContent = msg;
  banner.classList.remove('hidden');
  banner.style.display = 'flex';
}

function clearError() {
  const banner = document.getElementById('error-banner');
  banner.classList.add('hidden');
  banner.style.display = 'none';
}

function setRefreshSpinner(on) {
  const icon = document.getElementById('refresh-icon');
  if (icon) icon.style.animation = on ? 'spin 0.7s linear infinite' : '';
}

function updateLastUpdated() {
  const el = document.getElementById('last-updated');
  if (el) {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }
}

function updateLiveBadge(count) {
  const badge = document.getElementById('live-badge');
  const countEl = document.getElementById('live-count');
  const tabCountEl = document.getElementById('live-count-tab');

  if (count > 0) {
    if (badge) { badge.classList.remove('hidden'); badge.style.display = 'flex'; }
    if (countEl) countEl.textContent = count;
    if (tabCountEl) { tabCountEl.style.display = 'inline-flex'; tabCountEl.textContent = count; }
  } else {
    if (badge) { badge.classList.add('hidden'); }
    if (tabCountEl) tabCountEl.style.display = 'none';
  }
}

// ── Security ──────────────────────────────────────────────────────────────

function escHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Add CSS for spinner
const style = document.createElement('style');
style.textContent = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
document.head.appendChild(style);
