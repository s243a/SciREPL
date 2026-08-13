#!/usr/bin/env node
/**
 * local-fetch-helper.mjs — a localhost companion server for SciREPL.
 *
 * Fetches HTTPS URLs on behalf of the browser app and re-serves them with
 * CORS headers, so a PWA (or Electron renderer) can install catalog items
 * from hosts that do not send Access-Control-Allow-Origin — most notably
 * GitHub Releases (github.com/.../releases/download/...) and other-repo
 * GitHub Pages origins.
 *
 * This is the same pattern as SciREPL's dev-server /proxy and UnifyWeaver's
 * HTTP CLI server: the browser delegates a cross-origin fetch to a local
 * process that is not bound by CORS. The user runs it themselves, on their
 * own machine, by choice. It is a convenience, never a requirement — the
 * built-in catalog and CORS-open sources (raw.githubusercontent.com,
 * cdn.jsdelivr.net) work without it.
 *
 * Usage:
 *   node local-fetch-helper.mjs            # listens on 127.0.0.1:8787
 *   PORT=9000 node local-fetch-helper.mjs
 *
 * Endpoints:
 *   GET /health          -> { ok: true }
 *   GET /fetch?url=...   -> proxied response (https:// URLs only)
 *
 * Security posture:
 *   - Binds to 127.0.0.1 only. Never reachable from the LAN.
 *   - HTTPS targets only; no credentials in URLs; max 5 redirects, and a
 *     redirect to a non-https URL is refused.
 *   - Response size capped (default 64 MB) to keep a hostile or broken
 *     upstream from exhausting memory/disk.
 *   - Sends Access-Control-Allow-Origin: * and answers Private Network
 *     Access preflights, because that is the entire point of the helper.
 *     Anything the machine can reach over HTTPS becomes readable by any
 *     web page open in the local browser while this runs. Run it only
 *     when you are installing packages, and stop it afterwards if that
 *     trade-off makes you uncomfortable.
 */

import http from 'node:http';
import https from 'node:https';

const PORT = Number(process.env.PORT) || 8787;
const MAX_BYTES = Number(process.env.MAX_BYTES) || 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    // Private Network Access: a public-https page (a hosted PWA) calling
    // http://127.0.0.1 triggers a preflight that requires this header.
    'Access-Control-Allow-Private-Network': 'true',
    ...extra,
  };
}

function send(res, status, body, extra = {}) {
  res.writeHead(status, corsHeaders(extra));
  res.end(body);
}

function isAllowedTarget(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url;
}

function fetchWithRedirects(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'scirepl-local-fetch-helper/1.0' } }, (upstream) => {
      const code = upstream.statusCode || 0;
      if (code >= 300 && code < 400 && upstream.headers.location) {
        upstream.resume(); // drain so the socket can be reused
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        const next = isAllowedTarget(new URL(upstream.headers.location, url).toString());
        if (!next) {
          reject(new Error('Refused redirect to a non-https or credential-bearing URL'));
          return;
        }
        resolve(fetchWithRedirects(next, redirectsLeft - 1));
        return;
      }
      resolve(upstream);
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('Upstream timed out')));
  });
}

const server = http.createServer(async (req, res) => {
  const here = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Preflight (including Private Network Access preflights).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (here.pathname === '/health') {
    send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json' });
    return;
  }

  if (here.pathname !== '/fetch') {
    send(res, 404, 'Not found. Try /health or /fetch?url=https://...');
    return;
  }

  const target = isAllowedTarget(here.searchParams.get('url') || '');
  if (!target) {
    send(res, 400, 'Only https:// URLs without embedded credentials are allowed.');
    return;
  }

  let upstream;
  try {
    upstream = await fetchWithRedirects(target, MAX_REDIRECTS);
  } catch (err) {
    send(res, 502, 'Helper fetch failed: ' + (err && err.message ? err.message : String(err)));
    return;
  }

  const declared = Number(upstream.headers['content-length'] || 0);
  if (declared > MAX_BYTES) {
    upstream.resume();
    send(res, 413, `Upstream is ${declared} bytes; helper cap is ${MAX_BYTES}.`);
    return;
  }

  res.writeHead(upstream.statusCode || 502, corsHeaders({
    'Content-Type': upstream.headers['content-type'] || 'application/octet-stream',
  }));

  let seen = 0;
  upstream.on('data', (chunk) => {
    seen += chunk.length;
    if (seen > MAX_BYTES) {
      upstream.destroy();
      res.destroy();
    }
  });
  upstream.pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`SciREPL local fetch helper: http://127.0.0.1:${PORT}/`);
  console.log(`Try:                        http://127.0.0.1:${PORT}/health`);
  console.log('Stop with Ctrl+C when you are done installing packages.');
});
