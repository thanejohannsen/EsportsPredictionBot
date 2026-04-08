"""
EsportsPM — local dev server with API proxy.
Serves static files and proxies Polymarket + PandaScore requests to avoid CORS.

Usage:
    pip install flask requests
    python Main_site.py
Then open http://localhost:8000
"""

import requests
from flask import Flask, request, Response, send_from_directory

app = Flask(__name__, static_folder='.', static_url_path='')

POLYMARKET_BASE = 'https://gamma-api.polymarket.com'
PANDASCORE_BASE = 'https://api.pandascore.co'

# ── Static files ──────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/js/<path:filename>')
def js_files(filename):
    return send_from_directory('js', filename)

# ── Polymarket proxy ──────────────────────────────────────────────────────────

@app.route('/proxy/polymarket/<path:path>')
def polymarket_proxy(path):
    url = f'{POLYMARKET_BASE}/{path}'
    resp = requests.get(url, params=request.args, timeout=10)
    return Response(
        resp.content,
        status=resp.status_code,
        content_type=resp.headers.get('Content-Type', 'application/json'),
    )

# ── PandaScore proxy ──────────────────────────────────────────────────────────

@app.route('/proxy/pandascore/<path:path>')
def pandascore_proxy(path):
    auth = request.headers.get('Authorization', '')
    url = f'{PANDASCORE_BASE}/{path}'
    resp = requests.get(
        url,
        params=request.args,
        headers={'Authorization': auth},
        timeout=10,
    )
    return Response(
        resp.content,
        status=resp.status_code,
        content_type=resp.headers.get('Content-Type', 'application/json'),
    )

# ─────────────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print('EsportsPM running at http://localhost:8000')
    app.run(port=8000, debug=True)
