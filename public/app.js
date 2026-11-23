// Voice Planner client.
// Connects to the Inworld Realtime API over WebRTC:
//   - microphone audio goes out on a WebRTC audio track,
//   - the assistant's voice comes back on a WebRTC audio track,
//   - JSON events (transcripts, tool calls, status) travel on the "oai-events" data channel.
// The API key never touches this file: our server performs the handshake with Inworld.

import { sanitizeBlocks, parseScheduleText, formatTime, formatDuration, changedKeys, toMinutes } from './schedule.js';

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
const els = {
  call: $('call'), callLabel: $('call-label'), status: $('status'), caption: $('caption'), conn: $('conn'),
  schedule: $('schedule'), empty: $('empty'), summary: $('plan-summary'), readPlan: $('read-plan'), clearPlan: $('clear-plan'),
  transcript: $('transcript'), talkEmpty: $('talk-empty'), badge: $('badge'),
  tabPlan: $('tab-plan'), tabTalk: $('tab-talk'), panelPlan: $('panel-plan'), panelTalk: $('panel-talk'),
  toast: $('toast'), today: $('today'),
  passDialog: $('passcode-dialog'), passForm: $('passcode-form'), passInput: $('passcode-input')
};

const STATUS_TEXT = {
  idle: 'Tap Start to talk',
  connecting: 'Connecting…',
  listening: 'Listening',
  hearing: 'Hearing you…',
  thinking: 'Thinking…',
  speaking: 'Speaking'
};

const STORE_KEY = 'voice-planner.schedule.v1';
const PASS_KEY = 'voice-planner.passcode';

let call = null; // { pc, dc, mic, audio, wakeLock }
let state = 'idle';
let blocks = [];
let unseen = 0;
let sawAudioBufferEvents = false;
const bubbles = new Map(); // item_id -> element
const convo = []; // [{ role: 'user' | 'assistant', text }] for the plan backup
let toolCalledThisResponse = false;
let planTimer = 0;
const bubbleSource = new Map(); // item_id -> 'audio' | 'text'

// ---------- storage (per-device convenience only) ----------

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function loadSchedule() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && saved.date === todayKey()) return sanitizeBlocks(saved.blocks);
  } catch {}
  return [];
}
function saveSchedule() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ date: todayKey(), blocks })); } catch {}
}
function getPasscode() { try { return localStorage.getItem(PASS_KEY) || ''; } catch { return ''; } }
function setPasscode(v) { try { v ? localStorage.setItem(PASS_KEY, v) : localStorage.removeItem(PASS_KEY); } catch {} }

// ---------- UI state ----------

function setState(next) {
  state = next;
  app.dataset.state = next;
  els.status.textContent = STATUS_TEXT[next] || '';
  const live = next !== 'idle';
  els.callLabel.textContent = live ? 'End conversation' : 'Start';
  els.call.setAttribute('aria-label', live ? 'End conversation' : 'Start conversation');
  els.conn.textContent = next === 'idle' ? 'Offline' : next === 'connecting' ? 'Connecting' : 'Live';
  els.readPlan.disabled = !(live && next !== 'connecting' && blocks.length);
}

let toastTimer;
function toast(message, kind = 'error', ms = 6000) {
  els.toast.textContent = message;
  els.toast.className = `toast ${kind === 'info' ? 'info' : ''}`;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function setCaption(text) { els.caption.textContent = text || ''; }

function selectTab(which) {
  const plan = which === 'plan';
  els.tabPlan.setAttribute('aria-selected', String(plan));
  els.tabTalk.setAttribute('aria-selected', String(!plan));
  els.panelPlan.hidden = !plan;
  els.panelTalk.hidden = plan;
  if (!plan) { unseen = 0; els.badge.hidden = true; scrollTranscript(); }
}

// ---------- schedule rendering ----------

function renderSchedule(changed = new Set()) {
  els.schedule.replaceChildren();
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  for (const b of blocks) {
    const li = document.createElement('li');
    const isNow = nowMin >= toMinutes(b.start) && nowMin < toMinutes(b.end);
    li.className = `block cat-${b.category}${isNow ? ' is-now' : ''}${changed.has(b.title.toLowerCase()) ? ' changed' : ''}`;

    const when = document.createElement('div');
    when.className = 'when';
    const [t, ap] = formatTime(b.start).split(' ');
    when.textContent = t;
    const small = document.createElement('small');
    small.textContent = ap;
    when.append(small);

    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = b.title;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const range = document.createElement('span');
    range.textContent = `${formatTime(b.start)} – ${formatTime(b.end)} · ${formatDuration(b.start, b.end)}`;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = b.category;
    meta.append(range, tag);
    if (isNow) {
      const now = document.createElement('span');
      now.className = 'now';
      now.textContent = 'NOW';
      meta.append(now);
    }
    card.append(title, meta);
    if (b.note) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = b.note;
      card.append(note);
    }
    li.append(when, card);
    els.schedule.append(li);
  }
  const has = blocks.length > 0;
  els.empty.hidden = has;
  els.clearPlan.hidden = !has;
  els.summary.textContent = has
    ? `${blocks.length} block${blocks.length === 1 ? '' : 's'} · ${formatTime(blocks[0].start)} – ${formatTime(blocks[blocks.length - 1].end)}`
    : 'No plan yet';
  els.readPlan.disabled = !(call && state !== 'connecting' && has);
  const first = els.schedule.querySelector('.changed');
  if (first && !els.panelPlan.hidden) first.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function applySchedule(next) {
  const changed = changedKeys(blocks, next);
  blocks = next;
  saveSchedule();
  renderSchedule(changed);
}

// ---------- transcript ----------

function scrollTranscript() {
  els.panelTalk.scrollTop = els.panelTalk.scrollHeight;
}

function bubble(id, role) {
  let el = id ? bubbles.get(id) : null;
  if (!el) {
    el = document.createElement('div');
    el.className = `msg ${role} pending`;
    els.transcript.append(el);
    if (id) bubbles.set(id, el);
    els.talkEmpty.hidden = true;
    if (els.panelTalk.hidden && role !== 'note') {
      unseen += 1;
      els.badge.textContent = String(unseen);
      els.badge.hidden = false;
    }
  }
  return el;
}

function setBubbleText(el, text, done) {
  el.textContent = text;
  if (done) el.classList.remove('pending');
  if (!els.panelTalk.hidden) scrollTranscript();
}

function note(text) {
  const el = bubble(null, 'note');
  setBubbleText(el, text, true);
}

// ---------- server calls ----------

async function api(path, init = {}, retried = false) {
  const res = await fetch(path, {
    ...init,
    cache: 'no-store',
    headers: { ...(init.headers || {}), 'X-Passcode': getPasscode() }
  });
  if (res.status === 401 && !retried) {
    const code = await askPasscode();
    if (!code) throw new Error('A passcode is needed to start a conversation.');
    setPasscode(code);
    return api(path, init, true);
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401) setPasscode('');
    throw new Error(data.error === 'passcode_required' ? 'That passcode did not work.' : data.error || `Server error (${res.status})`);
  }
  return data;
}

function askPasscode() {
  return new Promise((resolve) => {
    els.passInput.value = '';
    const onClose = () => {
      els.passDialog.removeEventListener('close', onClose);
      resolve(els.passDialog.returnValue === 'ok' ? els.passInput.value.trim() : '');
    };
    els.passDialog.addEventListener('close', onClose);
    els.passDialog.showModal();
    els.passInput.focus();
  });
}

function waitForIce(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    let settle;
    const done = () => { clearTimeout(settle); clearTimeout(cap); resolve(); };
    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) { clearTimeout(settle); settle = setTimeout(done, 500); }
    });
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') done(); });
    const cap = setTimeout(done, 3000);
  });
}

// ---------- call lifecycle ----------

async function startCall() {
  if (call) return;
  if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
    toast('This browser cannot do live voice. Try Safari on iPhone or Chrome on Android.');
    return;
  }
  setState('connecting');
  setCaption('');
  sawAudioBufferEvents = false;

  // Create the speaker element inside the tap so mobile browsers allow playback.
  const audio = new Audio();
  audio.autoplay = true;
  audio.playsInline = true;
  audio.setAttribute('playsinline', '');
  document.body.append(audio);
  // Audio context for the speaking meter. Created inside the tap so mobile browsers allow it.
  let meterCtx = null;
  try { meterCtx = new (window.AudioContext || window.webkitAudioContext)(); meterCtx.resume?.(); } catch {}
  call = { pc: null, dc: null, mic: null, audio, wakeLock: null, meterCtx, meterRaf: 0 };
  const thisCall = call;

  try {
    thisCall.mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch {
    endCall();
    toast('Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.');
    return;
  }

  try {
    const cfg = await api('/api/config');
    if (call !== thisCall) return;

    const pc = new RTCPeerConnection({ iceServers: cfg.ice_servers || [] });
    thisCall.pc = pc;
    const dc = pc.createDataChannel('oai-events', { ordered: true });
    thisCall.dc = dc;
    thisCall.mic.getAudioTracks().forEach((t) => pc.addTrack(t, thisCall.mic));

    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] || new MediaStream([e.track]);
      audio.play().catch(() => toast('Tap anywhere to turn on the sound.', 'info'));
      startSpeakingMeter(thisCall, audio.srcObject);
    };
    pc.onconnectionstatechange = () => {
      if (call !== thisCall) return;
      if (pc.connectionState === 'failed') { endCall(); toast('The connection dropped. Check your signal and tap Start again.'); }
    };
    dc.onopen = () => onChannelOpen(thisCall);
    dc.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch {} };
    dc.onclose = () => { if (call === thisCall) { endCall(); note('Conversation ended'); } };

    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc);
    if (call !== thisCall) return;

    const answer = await api('/api/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sdp: pc.localDescription.sdp,
        localTime: new Date().toLocaleString(undefined, {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit'
        }),
        schedule: blocks
      })
    });
    if (call !== thisCall) return;
    thisCall.session = answer.session || null;
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });

    setTimeout(() => {
      if (call === thisCall && state === 'connecting') {
        endCall();
        toast('Could not connect the audio. Try again, or switch between Wi-Fi and mobile data.');
      }
    }, 15000);
  } catch (err) {
    if (call === thisCall) endCall();
    toast(err?.message || 'Could not start the conversation.');
  }
}

async function onChannelOpen(thisCall) {
  if (call !== thisCall) return;
  // Apply the planner's settings (voice, model, instructions, tool, English) first,
  // exactly like Inworld's reference example does.
  if (thisCall.session) send({ type: 'session.update', session: thisCall.session });
  setState('listening');
  note('Conversation started');
  try { thisCall.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  // Ask the assistant to say hello first. This text is never shown in the transcript.
  send({
    type: 'conversation.item.create',
    item: {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: blocks.length
        ? '(The call just connected. Greet me in one short sentence, mention I already have a plan on screen, and ask what I want to change.)'
        : '(The call just connected. Greet me in one short sentence and ask what my day looks like.)' }]
    }
  });
  send({ type: 'response.create' });
}

// ---------- plan backup ----------
// The voice model is asked to call set_schedule, but it doesn't always do it.
// After any reply without that call, the server reads the conversation and
// writes out the plan, so the Plan tab always matches what was said.
function schedulePlanBackup() {
  if (!convo.some((m) => m.role === 'user')) return;
  clearTimeout(planTimer);
  planTimer = setTimeout(runPlanBackup, 800);
}

async function runPlanBackup() {
  const thisCall = call;
  try {
    const data = await api('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation: convo.slice(-30),
        schedule: blocks,
        localTime: new Date().toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' })
      })
    });
    if (thisCall && call !== thisCall) return;
    const text = typeof data.schedule === 'string' ? data.schedule.trim() : '';
    if (!text || text.toUpperCase() === 'NONE') return;
    const next = parseScheduleText(text);
    if (!next.length) {
      note(`Plan text couldn't be read: ${text.slice(0, 140)}`);
      return;
    }
    if (JSON.stringify(next) === JSON.stringify(blocks)) return;
    applySchedule(next);
    selectTab('plan');
    toast('Plan updated', 'info', 2500);
  } catch (err) {
    toast(`Couldn't update the plan: ${err?.message || 'unknown error'}`, 'error', 10000);
  }
}

// ---------- speaking meter ----------
// Measures how loud the assistant's incoming voice is, so the screen shows
// "Plan is speaking" exactly when voice audio is arriving from Inworld.

function setVoice(on, level) {
  if (on) app.dataset.voice = 'on'; else delete app.dataset.voice;
  app.style.setProperty('--lvl', level.toFixed(3));
}

function startSpeakingMeter(thisCall, stream) {
  const ctx = thisCall.meterCtx;
  if (!ctx || !stream || thisCall.meterRaf) return;
  let analyser;
  try {
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser); // analysis only: playback stays on the <audio> element
  } catch { return; }
  const buf = new Uint8Array(analyser.fftSize);
  let smooth = 0;
  let lastLoud = 0;
  let wasOn = false;
  const tick = () => {
    if (call !== thisCall) return;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now();
    if (rms > 0.015) lastLoud = now;
    const on = now - lastLoud < 400; // short hold so it doesn't flicker between words
    smooth += (Math.min(1, rms * 5) - smooth) * 0.35;
    setVoice(on, on ? smooth : 0);
    if (on && !wasOn && state !== 'hearing' && state !== 'speaking') setState('speaking');
    wasOn = on;
    thisCall.meterRaf = requestAnimationFrame(tick);
  };
  ctx.resume?.().catch(() => {});
  thisCall.meterRaf = requestAnimationFrame(tick);
}

function endCall() {
  const c = call;
  call = null;
  setVoice(false, 0);
  if (c) {
    if (c.meterRaf) cancelAnimationFrame(c.meterRaf);
    c.meterCtx?.close?.().catch(() => {});
    try { c.dc?.close(); } catch {}
    try { c.pc?.close(); } catch {}
    c.mic?.getTracks().forEach((t) => t.stop());
    if (c.audio) { c.audio.srcObject = null; c.audio.remove(); }
    c.wakeLock?.release?.().catch(() => {});
  }
  for (const el of els.transcript.querySelectorAll('.msg.pending')) {
    if (!el.textContent) el.remove(); else el.classList.remove('pending');
  }
  bubbles.clear();
  setState('idle');
  setCaption('');
}

function send(event) {
  if (call?.dc?.readyState === 'open') call.dc.send(JSON.stringify(event));
}

// ---------- Realtime events ----------

function handleEvent(ev) {
  switch (ev.type) {
    case 'input_audio_buffer.speech_started': {
      setState('hearing');
      setCaption('');
      // A user turn interrupts any reply in progress.
      for (const el of els.transcript.querySelectorAll('.msg.ai.pending')) { el.classList.remove('pending'); el.classList.add('cut'); }
      bubble(ev.item_id, 'user');
      break;
    }
    case 'input_audio_buffer.speech_stopped':
      setState('thinking');
      break;

    case 'conversation.item.input_audio_transcription.delta': {
      const el = bubble(ev.item_id, 'user');
      setBubbleText(el, el.textContent + (ev.delta || ''), false);
      setCaption(el.textContent);
      break;
    }
    case 'conversation.item.input_audio_transcription.completed': {
      const el = bubble(ev.item_id, 'user');
      const text = (ev.transcript || '').trim();
      if (!text) { el.remove(); bubbles.delete(ev.item_id); break; }
      setBubbleText(el, text, true);
      convo.push({ role: 'user', text });
      if (state !== 'speaking') setCaption(text);
      break;
    }

    case 'response.created':
      toolCalledThisResponse = false;
      if (state !== 'hearing') setState('thinking');
      break;

    case 'output_audio_buffer.started':
      sawAudioBufferEvents = true;
      if (state !== 'hearing') setState('speaking');
      break;
    case 'output_audio_buffer.stopped':
    case 'output_audio_buffer.cleared':
      sawAudioBufferEvents = true;
      if (state === 'speaking') setState('listening');
      break;

    case 'response.output_audio_transcript.delta':
      aiText(ev.item_id, ev.delta, 'audio', false);
      break;
    case 'response.output_audio_transcript.done':
      aiText(ev.item_id, ev.transcript, 'audio', true);
      if (ev.transcript) { convo.push({ role: 'assistant', text: ev.transcript }); schedulePlanBackup(); }
      break;
    case 'response.output_text.delta':
      aiText(ev.item_id, ev.delta, 'text', false);
      break;
    case 'response.output_text.done':
      aiText(ev.item_id, ev.text, 'text', true);
      break;

    case 'response.function_call_arguments.done':
      handleToolCall(ev);
      break;

    case 'response.done': {
      const r = ev.response || {};
      if (r.status !== 'failed' && r.status !== 'cancelled') schedulePlanBackup();
      if (r.status === 'failed' || r.status === 'incomplete') {
        const d = r.status_details || {};
        const why = [d.error?.type, d.error?.code, d.error?.message, d.reason].filter(Boolean).join(' · ') || r.status;
        console.warn('Response not completed:', r.status, JSON.stringify(d));
        toast(`The reply could not be spoken: ${why}`, 'error', 12000);
      }
      if (!sawAudioBufferEvents && (state === 'thinking' || state === 'speaking')) {
        setTimeout(() => { if (call && (state === 'thinking' || state === 'speaking')) setState('listening'); }, 700);
      }
      break;
    }

    case 'error': {
      const code = ev.error?.code || '';
      const message = ev.error?.message || 'Something went wrong.';
      if (code === 'token_expired' || ev.error?.type === 'authentication_error') {
        endCall();
        toast('The session expired. Tap Start to continue.');
      } else if (code !== 'conversation_already_has_active_response' && code !== 'response_cancel_not_active') {
        console.warn('Realtime error:', code, message);
        toast(`Inworld error: ${message}${code ? ` (${code})` : ''}`, 'error', 12000);
      }
      break;
    }
  }
}

// Spoken transcript is preferred; plain text deltas are used only if no transcript arrives.
function aiText(itemId, chunk, source, done) {
  if (!itemId) return;
  const owner = bubbleSource.get(itemId);
  if (owner && owner !== source) return;
  bubbleSource.set(itemId, source);
  const el = bubble(itemId, 'ai');
  if (done) {
    if (typeof chunk === 'string' && chunk) setBubbleText(el, chunk, true);
    else el.classList.remove('pending');
  } else {
    setBubbleText(el, el.textContent + (chunk || ''), false);
    if (state !== 'hearing') { if (!sawAudioBufferEvents) setState('speaking'); }
  }
  setCaption(el.textContent);
}

function handleToolCall(ev) {
  let output;
  if (ev.name === 'set_schedule') {
    toolCalledThisResponse = true;
    let args = {};
    try { args = JSON.parse(ev.arguments || '{}'); } catch {}
    const next = args.schedule !== undefined ? parseScheduleText(args.schedule) : sanitizeBlocks(args.blocks);
    applySchedule(next);
    output = { ok: true, blocks_on_screen: next.length };
  } else {
    output = { ok: false, error: `Unknown tool ${ev.name}` };
  }
  // Inworld continues the conversation automatically after this result (auto_tool_response).
  send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(output) } });
}

// ---------- version tag (shows which deploy is live) ----------
fetch('/healthz', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
  if (d?.version) els.today.textContent += ` · v${d.version}`;
}).catch(() => {});

// ---------- wiring ----------

els.call.addEventListener('click', () => { call ? (endCall(), note('Conversation ended')) : startCall(); });
els.tabPlan.addEventListener('click', () => selectTab('plan'));
els.tabTalk.addEventListener('click', () => selectTab('talk'));

els.readPlan.addEventListener('click', () => {
  if (!call || !blocks.length) return;
  const el = bubble(null, 'user');
  setBubbleText(el, 'Read my plan out loud.', true);
  send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Please read my whole plan out loud, in order.' }] } });
  send({ type: 'response.create' });
});

els.clearPlan.addEventListener('click', () => {
  if (!confirm('Clear today’s plan?')) return;
  applySchedule([]);
  send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '(I cleared the schedule on screen. It is empty now.)' }] } });
});

document.addEventListener('click', () => { if (call?.audio?.paused && call.audio.srcObject) call.audio.play().catch(() => {}); });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && call && (!call.wakeLock || call.wakeLock.released)) {
    try { call.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  }
});
window.addEventListener('pagehide', () => { if (call) endCall(); });

els.today.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
blocks = loadSchedule();
renderSchedule();
setState('idle');
setInterval(() => { if (blocks.length) renderSchedule(); }, 60_000);
