export default async function handler(req, res) {
  const segments = req.query.path ?? [];
  const path = Array.isArray(segments) ? segments.join('/') : segments;

  const url = new URL(`https://api.pandascore.co/${path}`);
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== 'path') url.searchParams.set(k, v);
  }

  const auth = req.headers['authorization'] ?? '';

  try {
    const upstream = await fetch(url.toString(), {
      headers: auth ? { Authorization: auth } : {},
    });
    const body = await upstream.text();
    res.setHeader('Content-Type', upstream.headers.get('Content-Type') ?? 'application/json');
    res.status(upstream.status).send(body);
  } catch (err) {
    res.status(502).json({ error: 'PandaScore upstream error', detail: err.message });
  }
}
