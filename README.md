# EsportsPM — Polymarket Esports Tracker

A clean, dark-themed website that tracks **CS2** and **League of Legends** Polymarket prediction markets in real time. Shows upcoming game odds with edge analysis and live game map picks with per-map odds.

## Features

- **Upcoming Games tab** — Polymarket odds for every CS2/LoL match with volume >$20K, American/decimal/% formats, edge indicator, and sub-market chips (Map 1, 2.5+ maps, etc.)
- **Live Games tab** — Series score, map-by-map veto with CT/T bias notes, per-map scores, and a side-by-side Polymarket odds panel (ML · Map 1 · Maps 2.5+)
- **Edge detection** — Compares vig-adjusted Polymarket probability against PandaScore team stats when a key is configured
- **PandaScore enrichment** (optional) — Adds live scores, map veto details, and team win-rate data for better analysis
- Auto-refreshes every 60 seconds; configurable in Settings

---

## Quick Start (local)

No build step required. Open `index.html` via a local HTTP server:

```
# Option A: VS Code → open index.html → click "Go Live" in the bottom bar
# Option B: Python (if installed)
python -m http.server 8080
# then open http://localhost:8080
```

> **Do not** open `index.html` directly as `file://` — ES modules require HTTP.

---

## Deploy to GitHub Pages

1. Create a new **public** GitHub repository (e.g. `esportspm`).
2. Push all files:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/<YOUR_USERNAME>/esportspm.git
   git push -u origin main
   ```
3. Go to **Settings → Pages** in your repo.
4. Under *Source*, select **Deploy from a branch → main → / (root)**.
5. Click **Save**. Your site will be live at `https://<YOUR_USERNAME>.github.io/esportspm/` within ~60 seconds.

---

## PandaScore API Key (optional but recommended)

PandaScore provides live scores, map veto data, and team stats. The free tier allows 100 requests/hour.

1. Sign up at [pandascore.co](https://pandascore.co) — free plan, no credit card required.
2. Copy your API token from the dashboard.
3. On the website, click the **⚙️ Settings** icon → paste the key → **Save**.

The key is stored in `localStorage` and never leaves your browser.

---

## Data Sources

| Source | What it provides | Auth |
|--------|-----------------|------|
| [Polymarket Gamma API](https://gamma-api.polymarket.com) | Market odds, volume, outcomes | None |
| [PandaScore API](https://api.pandascore.co) | Live scores, map picks, team stats | Free API key |

---

## Project Structure

```
EsportsPredictionBot/
├── index.html          ← Entry point (Tailwind CDN, tab layout, settings modal)
├── js/
│   ├── config.js       ← Constants, tag slugs, map metadata, edge thresholds
│   ├── polymarket.js   ← Gamma API client, event/market normalisation
│   ├── pandascore.js   ← PandaScore API client, match normalisation
│   ├── analysis.js     ← Vig removal, odds formatting, edge detection, map analysis
│   └── app.js          ← State management, rendering, all UI logic
└── README.md
```

---

## Customisation

### Change minimum volume threshold
Settings gear → **Minimum Market Volume** — or edit the default in `js/config.js`:
```js
minVolume: 20_000,   // USD
```

### Add more tournaments to the filter dropdown
Edit the `<select id="tournament-filter">` in `index.html` and add `<option>` entries.

### Adjust edge thresholds
In `js/config.js`:
```js
export const EDGE = {
  STRONG: 0.07,   // ≥7% edge vs model = "Strong Edge"
  SLIGHT: 0.03,   // ≥3% edge = "Slight Edge"
};
```

### Track different games
The app currently supports `cs2` and `lol`. To add Dota 2:
1. Add a `dota2` entry to `POLYMARKET.TAGS` and `POLYMARKET.GAME_KEYWORDS` in `config.js`.
2. Add a button in the `<nav>` in `index.html` calling `App.switchGame('dota2')`.
3. Add the PandaScore slug in `pandascore.js → gameSlug()`.
