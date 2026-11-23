// Builds the Inworld Realtime session config for one call.
// It is sent from the server during signaling, so the prompt and tools
// never have to live in browser code.

export const MODEL = process.env.INWORLD_MODEL || 'openai/gpt-4o-mini';
export const VOICE = process.env.INWORLD_VOICE || 'Clive';
export const LANGUAGE = process.env.INWORLD_LANGUAGE || 'en';
export const TTS_MODEL = process.env.INWORLD_TTS_MODEL || 'inworld-tts-2';

// Kept deliberately flat (one string parameter), matching the shape shown in
// Inworld's tool-calling docs. Nested arrays of objects made replies fail.
export const SET_SCHEDULE_TOOL = {
  type: 'function',
  name: 'set_schedule',
  description:
    "Replace the user's on-screen schedule for the day. Call this every time the plan " +
    'changes (new blocks, moves, removals, renames). Always send the COMPLETE updated schedule, not just the change.',
  parameters: {
    type: 'object',
    properties: {
      schedule: {
        type: 'string',
        description:
          'The complete schedule, one block per line, in time order. Each line: ' +
          '"HH:MM-HH:MM | title | category | optional note", using 24-hour times. ' +
          'category is one of: work, meeting, health, personal, break, errand, other. ' +
          'Example line: "10:00-10:45 | Client call | meeting". Send an empty string to clear the schedule.'
      }
    },
    required: ['schedule']
  }
};

const MAX_EXISTING_BLOCKS = 40;

function describeExisting(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 'The schedule is currently empty.';
  const lines = blocks.slice(0, MAX_EXISTING_BLOCKS).map((b) => {
    const s = String(b?.start ?? '').slice(0, 5);
    const e = String(b?.end ?? '').slice(0, 5);
    const t = String(b?.title ?? '').slice(0, 80);
    return `- ${s}-${e} ${t}`;
  });
  return `The schedule already on screen (keep it unless the user changes it):\n${lines.join('\n')}`;
}

export function buildInstructions({ localTime, existingBlocks } = {}) {
  const now = typeof localTime === 'string' && localTime.length < 80 ? localTime : 'unknown';
  return `You are Plan, a warm, upbeat voice assistant that helps the user plan their day. You are on a live voice call, so talk like a person on the phone.

The user's current local date and time: ${now}.

How to plan:
- Find out the fixed commitments (meetings, calls, appointments) and the flexible tasks, then build a realistic time-blocked schedule.
- Ask a short follow-up only when something important is missing (for example how long a task takes, or when the workday ends). Ask one question at a time. If a detail is minor, pick a sensible default and say so.
- Add short breaks and a lunch block when the day is long. Do not schedule anything in the past unless the user asks.
- Whenever the plan changes, call set_schedule with the COMPLETE updated list of blocks before or while you describe the change. The screen only shows what you send in set_schedule.

How to talk:
- Keep replies short: one to three sentences. Do not read the whole schedule after every change; summarise what changed.
- When the user asks you to read the plan, read it aloud in order, naturally, for example "At nine, deep work on the proposal until eleven."
- Say times the way people speak them ("ten thirty", "two p.m."), never "14:00".
- No lists, markdown, emojis or symbols in what you say. Everything you say is spoken aloud.
- If the user interrupts, stop and respond to what they just said.

${describeExisting(existingBlocks)}`;
}

export function buildSession(opts = {}) {
  return {
    type: 'realtime',
    model: MODEL,
    instructions: buildInstructions(opts),
    output_modalities: ['audio', 'text'],
    audio: {
      input: {
        transcription: { model: 'inworld/inworld-stt-1', language: LANGUAGE },
        turn_detection: {
          type: 'semantic_vad',
          eagerness: 'medium',
          create_response: true,
          interrupt_response: true
        }
      },
      output: { model: TTS_MODEL, voice: VOICE }
    },
    tools: [SET_SCHEDULE_TOOL],
    tool_choice: 'auto'
  };
}
