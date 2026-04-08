export default async function handler(req, res) {
  const { path, ...params } = req.query;
  if (!path) return res.status(400).json({ error: 'missing path' });

  const url = new URL(`https://gamma-api.polymarket.com${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
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
