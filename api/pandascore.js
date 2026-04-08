export default async function handler(req, res) {
  const { path, ...params } = req.query;
  if (!path) return res.status(400).json({ error: 'missing path' });

  const url = new URL(`https://api.pandascore.co${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const auth = req.headers['authorization'] ?? '';

  try {
    console.log('[pandascore] fetching:', url.toString(), 'auth:', auth ? 'present' : 'missing');
    const upstream = await fetch(url.toString(), {
      headers: auth ? { Authorization: auth } : {},
    });
    const body = await upstream.text();
    console.log('[pandascore] status:', upstream.status, 'body:', body.slice(0, 200));
    res.setHeader('Content-Type', upstream.headers.get('Content-Type') ?? 'application/json');
    res.status(upstream.status).send(body);
  } catch (err) {
    res.status(502).json({ error: 'PandaScore upstream error', detail: err.message });
  }
}
