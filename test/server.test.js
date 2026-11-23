import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.INWORLD_API_KEY = 'test-key-not-real';
process.env.APP_PASSCODE = 'letmein';
const { server } = await import('../server.js');
const { buildSession } = await import('../lib/session-config.js');

let base;
const realFetch = globalThis.fetch;
const upstream = [];

before(async () => {
  // Fake Inworld: record what the server sends and reply like the real API.
  globalThis.fetch = async (url, init = {}) => {
    if (typeof url === 'string' && url.startsWith('https://api.inworld.ai')) {
      upstream.push({ url, init });
      if (url.endsWith('/ice-servers')) return Response.json({ ice_servers: [{ urls: ['stun:example'] }] });
      if (url.endsWith('/v1/realtime/calls')) return new Response('v=0\r\nanswer', { headers: { 'Content-Type': 'application/sdp' } });
    }
    return realFetch(url, init);
  };
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { globalThis.fetch = realFetch; server.close(); });

const call = (path, init = {}) => realFetch(base + path, init);

test('serves the app', async () => {
  const r = await call('/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Voice Planner/);
});

test('blocks path traversal', async () => {
  const r = await call('/..%2fserver.js');
  assert.ok([403, 404].includes(r.status));
});

test('requires the passcode', async () => {
  assert.equal((await call('/api/config')).status, 401);
  assert.equal((await call('/api/config', { headers: { 'X-Passcode': 'wrong' } })).status, 401);
});

test('rejects other websites', async () => {
  const r = await call('/api/config', { headers: { 'X-Passcode': 'letmein', Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('config returns ICE servers and never the key', async () => {
  const r = await call('/api/config', { headers: { 'X-Passcode': 'letmein' } });
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(text), { ice_servers: [{ urls: ['stun:example'] }] });
  assert.ok(!text.includes('test-key-not-real'));
});

test('call relays the SDP with the key server-side', async () => {
  upstream.length = 0;
  const r = await call('/api/call', {
    method: 'POST',
    headers: { 'X-Passcode': 'letmein', 'Content-Type': 'application/json' },
    body: JSON.stringify({ sdp: 'v=0\r\noffer', localTime: 'Monday 9:00 AM', schedule: [{ start: '10:00', end: '11:00', title: 'Client call' }] })
  });
  const text = await r.text();
  assert.equal(r.status, 200);
  const out = JSON.parse(text);
  assert.equal(out.sdp, 'v=0\r\nanswer');
  assert.equal(out.session.tools[0].name, 'set_schedule');
  assert.match(out.session.instructions, /Monday 9:00 AM/);
  assert.match(out.session.instructions, /10:00-11:00 Client call/);
  assert.equal(out.session.audio.input.transcription.language, 'en');
  assert.ok(!text.includes('test-key-not-real'));

  const sent = upstream.find((u) => u.url.endsWith('/v1/realtime/calls'));
  assert.equal(sent.init.headers.Authorization, 'Basic test-key-not-real');
  assert.equal(sent.init.headers['Content-Type'], 'application/sdp');
  assert.equal(sent.init.body, 'v=0\r\noffer');
});

test('call rejects a bad offer', async () => {
  const r = await call('/api/call', {
    method: 'POST',
    headers: { 'X-Passcode': 'letmein', 'Content-Type': 'application/json' },
    body: JSON.stringify({ sdp: 'hello' })
  });
  assert.equal(r.status, 400);
});

test('session config matches the documented shape', () => {
  const s = buildSession({ localTime: 'now' });
  assert.equal(s.type, 'realtime');
  assert.deepEqual(s.output_modalities, ['audio', 'text']);
  assert.equal(s.audio.input.turn_detection.type, 'semantic_vad');
  assert.equal(s.audio.input.turn_detection.interrupt_response, true);
  assert.equal(s.audio.output.model, 'inworld-tts-2');
});
