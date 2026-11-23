// Voice Planner server.
// - Serves the web app from /public.
// - Relays the WebRTC handshake (SDP offer/answer) to Inworld using the API key,
//   so the key never reaches the browser. Audio itself flows directly between the
//   browser and Inworld over WebRTC; it never passes through this server.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { buildSession } from './lib/session-config.js';

const INWORLD = 'https://api.inworld.ai';
const API_KEY = (process.env.INWORLD_API_KEY || '').trim();
const PASSCODE = (process.env.APP_PASSCODE || '').trim();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const MAX_BODY_BYTES = 64 * 1024;
const MAX_SDP_CHARS = 20 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

// ---------- small helpers ----------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// Fixed-window rate limiter, per IP and bucket. In memory is fine for one instance.
const hits = new Map();
function rateLimited(req, bucket, limit, windowMs) {
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now - entry.start > windowMs) {
    hits.set(key, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
}, 60 * 1000).unref();

// Requests to /api must come from this same site (blocks other websites from using it).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function passcodeOk(req) {
  if (!PASSCODE) return true;
  const given = Buffer.from(String(req.headers['x-passcode'] || ''));
  const want = Buffer.from(PASSCODE);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
}

function inworld(path, init = {}) {
  return fetch(`${INWORLD}${path}`, {
    ...init,
    headers: { Authorization: `Basic ${API_KEY}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(15000)
  });
}

// ---------- API routes ----------

async function handleConfig(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
  if (rateLimited(req, 'config', 60, 60_000)) return send(res, 429, { error: 'Too many requests' });
  if (!passcodeOk(req)) return send(res, 401, { error: 'passcode_required' });

  let iceServers = [];
  try {
    const r = await inworld('/v1/realtime/ice-servers');
    if (r.ok) iceServers = (await r.json()).ice_servers || [];
    else console.warn(`[config] ICE servers request failed: HTTP ${r.status}`);
  } catch (e) {
    console.warn(`[config] ICE servers request error: ${e.name}`);
  }
  send(res, 200, { ice_servers: iceServers });
}

async function handleCall(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
  if (rateLimited(req, 'call', 10, 60_000)) return send(res, 429, { error: 'Too many calls, wait a minute' });
  if (!passcodeOk(req)) return send(res, 401, { error: 'passcode_required' });

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return send(res, e.status || 400, { error: 'Invalid request' });
  }
  const { sdp, localTime, schedule } = body || {};
  if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > MAX_SDP_CHARS) {
    return send(res, 400, { error: 'Invalid SDP offer' });
  }

  const session = buildSession({ localTime, existingBlocks: schedule });

  let r;
  try {
    // Same as Inworld's reference WebRTC example: the body is the raw SDP offer.
    // The session config is applied afterwards with session.update over the data channel.
    r = await inworld('/v1/realtime/calls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: sdp
    });
  } catch (e) {
    console.error(`[call] Inworld request error: ${e.name}`);
    return send(res, 502, { error: 'Could not reach Inworld' });
  }

  if (!r.ok) {
    // Log only the status and Inworld's short message. Never the key or headers.
    let msg = '';
    try {
      const t = await r.text();
      try { msg = String(JSON.parse(t)?.message || ''); } catch { msg = t; }
      msg = msg.slice(0, 200);
    } catch {}
    console.error(`[call] Inworld rejected the call: HTTP ${r.status} ${msg}`);
    const hint =
      r.status === 401 || r.status === 403
        ? 'Inworld rejected the API key. Check INWORLD_API_KEY and its Realtime permission.'
        : 'Inworld could not start the call. Try again in a moment.';
    return send(res, 502, { error: hint });
  }

  const raw = await r.text();
  let answer = raw;
  let callId = null;
  if (!raw.trimStart().startsWith('v=0')) {
    try { const data = JSON.parse(raw); answer = data?.sdp; callId = data?.id || null; } catch { answer = null; }
  }
  if (typeof answer !== 'string' || !answer.trimStart().startsWith('v=0')) {
    return send(res, 502, { error: 'Unexpected reply from Inworld' });
  }
  send(res, 200, { sdp: answer, callId, session });
}

// ---------- static files ----------

async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = normalize(join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
    return send(res, 403, 'Forbidden');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    send(res, 404, 'Not found');
  }
}

// ---------- server ----------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'X-Frame-Options': 'DENY'
};

export const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const path = (req.url || '/').split('?')[0];
  try {
    if (path === '/healthz') return send(res, 200, { ok: true });
    if (path.startsWith('/api/')) {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Forbidden' });
      if (!API_KEY) return send(res, 500, { error: 'Server is missing INWORLD_API_KEY' });
      if (path === '/api/config') return await handleConfig(req, res);
      if (path === '/api/call') return await handleCall(req, res);
      return send(res, 404, { error: 'Not found' });
    }
    return await serveStatic(req, res);
  } catch (e) {
    console.error(`[server] Unhandled error: ${e.name}`);
    if (!res.headersSent) send(res, 500, { error: 'Server error' });
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  server.listen(PORT, HOST, () => {
    console.log(`Voice Planner running on http://localhost:${PORT}`);
    if (!API_KEY) console.warn('INWORLD_API_KEY is not set. Calls will fail until it is.');
    if (!PASSCODE) console.warn('APP_PASSCODE is not set. Anyone with the link can start calls.');
  });
}
