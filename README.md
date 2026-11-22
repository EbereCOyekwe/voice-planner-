# Voice Planner

A voice-first daily planner. Tap **Start**, talk about your day, and it talks back, asks follow-ups, and builds a time-blocked schedule on screen that updates live as you change your mind. Built on the [Inworld Realtime API](https://docs.inworld.ai/realtime/overview.md) over WebRTC.

## How it's wired (plain English)

**Three pieces:** your phone's browser, a small server that you host on Render, and Inworld.

1. **Tapping Start.** The page asks for your microphone and gets ready to make a WebRTC call. WebRTC is the same technology video-call apps use to stream live audio.
2. **The handshake goes through the server.** Before audio can flow, the phone and Inworld exchange a short technical "offer" and "answer". The phone sends its offer to *our* server. The server adds the Inworld API key and the planner's instructions, forwards it to Inworld, and passes Inworld's answer back to the phone. **The key lives only on the server**, as an environment variable on Render. It is never sent to the phone and never written to the logs.
3. **Audio flows directly.** Once the handshake is done, your voice streams straight from the phone to Inworld, and the assistant's voice streams straight back. The audio never touches our server, which keeps it fast.
4. **Inworld does the thinking.** It turns your speech into text, sends that to a language model with the planner instructions, and turns the reply back into a natural voice. It also detects when you start talking, so if you interrupt, it stops and listens.
5. **The schedule updates through a "tool".** Alongside the audio there's a small data channel carrying messages. When the plan changes, the model calls a tool named `set_schedule` with the full updated schedule. The page draws it on screen, saves it on your phone for today, and tells the model it's done. The same channel carries the live transcript and the listening, thinking, and speaking signals that drive the animated orb.

```
Phone ──offer──▶ Our server (adds the key) ──▶ Inworld
Phone ◀─answer── Our server ◀──────────────── Inworld
Phone ◀════════ live audio + data channel ════════▶ Inworld
```

## Deploy for free from your phone (Render)

You need a GitHub account (you have one) and a free [Render](https://render.com) account.

1. On your phone, open **render.com** and tap **Get Started**. Choose **Sign in with GitHub**.
2. In the Render dashboard, tap **New +**, then **Blueprint**.
3. Connect your GitHub account if asked, then pick the **voice-planner-** repository.
4. Render reads `render.yaml` and shows one free web service called **voice-planner**. It asks for two values:
   - `INWORLD_API_KEY`: paste your full Inworld key (the long one ending in `==`).
   - `APP_PASSCODE`: make up a passcode, for example a few words. Anyone who opens the app has to enter it, so strangers can't use up your Inworld credits.
5. Tap **Apply** (or **Deploy Blueprint**). Wait for the deploy log to say **Live**, which takes about 2–4 minutes.
6. At the top of the service page, copy your app's address. It looks like `https://voice-planner-xxxx.onrender.com`.

> Free Render services go to sleep after about 15 minutes without use. The first visit afterwards takes about a minute to wake up. That's normal.

To change a setting later: open the service, then **Environment**, then edit the value and **Save**. Render redeploys by itself.

## Test it on your phone

1. Open your `onrender.com` address in **Safari** (iPhone) or **Chrome** (Android).
2. Enter your passcode when asked. It's remembered on that phone.
3. Tap **Start**, then **Allow** the microphone.
4. Wait for the greeting, then say something like: *"Help me plan my day. I have a client call at 10, gym after work, and a proposal to finish."*
5. Watch the **Plan** tab fill in. Then try:
   - "Move the gym to the morning." The block moves and briefly glows.
   - Interrupt it mid-sentence. It should stop and listen.
   - Tap **Read it aloud**, or just ask "Read me my plan."
   - Open the **Transcript** tab to see the conversation.
6. Tap **End conversation** when you're done.

**Tips:** use headphones or keep the volume moderate. On speakerphone, the assistant can sometimes hear itself. Optionally, add the app to your home screen: on iPhone, **Share** then **Add to Home Screen**; on Android, **⋮** then **Add to Home screen**.

**If something goes wrong:**
- *"Microphone access was blocked"*: allow the microphone for the site in your browser's settings, then reload.
- *"Inworld rejected the API key"*: check `INWORLD_API_KEY` on Render. It must be the full key, with Realtime permission.
- *"Could not connect the audio"*: switch between Wi-Fi and mobile data and try again. Some work or school Wi-Fi blocks live calls.
- To see server errors: on Render, open the service and then **Logs**.

## Settings

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `INWORLD_API_KEY` | yes | none | Full Base64 key from the Inworld Portal |
| `APP_PASSCODE` | recommended | none | Passcode needed to start a conversation |
| `INWORLD_VOICE` | no | `Clive` | Assistant voice ([voice library](https://platform.inworld.ai/voice-library)) |
| `INWORLD_MODEL` | no | `openai/gpt-4o-mini` | Language model used by the Realtime session |
| `INWORLD_TTS_MODEL` | no | `inworld-tts-2` | Text-to-speech model |

## Project layout

```
server.js               Web server: serves the app, relays the handshake with the key
lib/session-config.js   Planner instructions, voice/model and the set_schedule tool
public/index.html       The page
public/app.js           WebRTC call, live events, transcript, schedule
public/schedule.js      Schedule validation and formatting
public/styles.css       Black-and-blue mobile design
render.yaml             One-tap Render deploy
test/                   Tests (npm test)
```

Running on a computer, if you ever have one: `cp .env.example .env`, add your key, then run `npm run dev` and open http://localhost:3000.
