export default async function handler(req, res) {
  const { path, ...params } = req.query;
  if (!path) return res.status(400).json({ error: 'missing path' });

  const url = new URL(`https://www.hltv.org${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  try {
    const upstream = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const body = await upstream.text();
    // Cache for 1 hour at the edge — HLTV data rarely changes within an hour
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(upstream.status).send(body);
  } catch (err) {
    res.status(502).json({ error: 'HLTV upstream error', detail: err.message });
  }
}
