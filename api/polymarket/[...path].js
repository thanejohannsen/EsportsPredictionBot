export default async function handler(req, res) {
  const segments = req.query.path ?? [];
  const path = Array.isArray(segments) ? segments.join('/') : segments;

  const url = new URL(`https://gamma-api.polymarket.com/${path}`);
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== 'path') url.searchParams.set(k, v);
  }

  try {
    const upstream = await fetch(url.toString());
    const body = await upstream.text();
    res.setHeader('Content-Type', upstream.headers.get('Content-Type') ?? 'application/json');
    res.status(upstream.status).send(body);
  } catch (err) {
    res.status(502).json({ error: 'Polymarket upstream error', detail: err.message });
  }
}
