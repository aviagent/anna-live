# Mic / voice capture — build notes

This is the canonical reference for how voice capture works in lead-demo-site.
Read this before changing anything in `voice.js`, `chat.js`, or the mic UI in
`index.html`. Most of what's documented here came from real failures on iOS
Safari and Chrome — undoing any of it will likely break the mic again.

## High-level architecture

The mic flow is split between three files:

| File | Job |
|---|---|
| `chat.js` (`initStartButton`) | Get the mic stream from the user gesture (the "Get Started" click) and store it on `G._heldMicStream`. Kicks off `voice.start()`. |
| `voice.js` | Owns the recording lifecycle: `startListening` / `stopListening`, MediaRecorder, the audio level meter, VAD silence detection, and the transcribe call. |
| `index.html` + `style.css` | Renders the level meter (`#hg-mic-meter-wrap` + `#hg-mic-level`). The `#hg-mic-btn` exists in the DOM but is hidden — the mic is fully automatic, no tap required. |

The user clicks **Get Started** once. The browser asks for mic permission. From
that point until the form completes, the mic stream stays alive and the level
meter animates continuously.

---

## Why MediaRecorder, not SpeechRecognition

`webkitSpeechRecognition` (SR) was tried as the primary capture path and
**caused most of the bugs**. We now use MediaRecorder + Whisper (via the
Cloudflare Worker `/transcribe` endpoint) and treat SR as opt-in only.

Reasons:

1. **SR has flaky permission UX** — on iOS it sometimes fires `not-allowed`
   from non-gesture context even when mic permission is granted. There's no
   way to "request permission" for SR cleanly; it just runs and either works
   or errors out asynchronously.
2. **SR has no audio-level callback** — we can't drive the level meter from
   it. The meter is a critical UX cue ("the mic is on and hearing me"), so we
   need the AudioContext analyser, which only the MediaRecorder path uses.
3. **Whisper transcribes more accurately** than browser SR, especially for
   spelled-out emails ("L-I-T-T-F-zero-two at gmail dot com").

`startListening({ useSR: true })` exists if you ever want SR back, but the
default is MediaRecorder.

---

## The held-stream pattern

**Problem:** On iOS, `navigator.mediaDevices.getUserMedia()` must be initiated
from a direct user gesture. Once you `await` something else first, the gesture
context is lost and the call fails with `NotAllowedError`, even if permission
was granted before.

`startListening` is `async` and runs after Anna's greeting clip finishes (a
6-second wait). That's well outside the gesture context — `getUserMedia` from
inside it would fail on iOS.

**Solution:** We grab the stream *during* the "Get Started" click handler
(while gesture context is active) and stash it on the global `G._heldMicStream`.
Later, `startListening` reads it back without ever calling `getUserMedia`
again.

```js
// chat.js — inside the Get Started click handler, BEFORE any await
navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
}).then((stream) => { G._heldMicStream = stream; })
  .catch((e) => console.warn('[chat] initial mic prompt failed:', e?.name || e));
```

```js
// voice.js — startListening, async context, no getUserMedia call
const held = window.AIHostGen?._heldMicStream;
if (held && held.getTracks().some(t => t.readyState === 'live')) {
  mediaStream = held;
  window.AIHostGen._heldMicStream = null;  // consumed
}
```

**Critical rule:** the `getUserMedia` call in `chat.js` must happen *before*
any `await` in the Get Started handler. If you move it after an await,
gesture context is lost on iOS and the call fails.

---

## The continuous-meter pattern

Originally, between recordings we called `audioCtx.close()` and tore down the
analyser. The mic looked "dead" between questions — the meter went flat,
which made users think the mic wasn't working.

Now:
- The `AudioContext` and `AnalyserNode` are created **once** (`ensureAudioCtx`)
  and stay alive for the entire conversation.
- `startMeterLoop` runs an animation-frame loop that always reads `analyser`
  and updates `#hg-mic-level.style.width`, regardless of whether MediaRecorder
  is currently recording.
- Speech-detection (the "you stopped talking, time to transcribe" logic) is
  gated by `vadActive`. It only runs while a recording is active. The meter
  draws regardless.

```
startListening  → ensureAudioCtx → startMeterLoop  (continuous)
                                 → MediaRecorder.start
                                 → vadActive = true  (silence-detect active)
mediaRecorder.onstop → vadActive = false  (silence-detect off; meter keeps going)
releaseMicFinal → _meterLoopRunning = false; audioCtx.close  (full teardown)
```

**Critical rule:** Don't close `audioCtx` in `mediaRecorder.onstop` or
`releaseMic`. Only `releaseMicFinal` (form complete / page unload) tears it
down.

---

## VAD (voice activity detection)

Constants live at the top of `voice.js`:

```js
const SILENCE_THRESHOLD = 0.003;   // RMS below this counts as silence
const SILENCE_DURATION  = 1500;    // ms of silence after speech → auto-stop
const MAX_RECORD_MS     = 12000;   // hard cap (never run forever)
```

Tuning notes:
- `SILENCE_THRESHOLD` too high → cuts off quiet speakers mid-word.
- `SILENCE_THRESHOLD` too low → never auto-stops in noisy rooms.
- `SILENCE_DURATION` too short → cuts the user off when they pause to think.
- `SILENCE_DURATION` too long → user waits forever after they finish.

The 150ms startup window (`Date.now() - recordingStartedAt < 150`) ignores
the brief echo from Anna's audio bleeding into the mic at the start.

---

## Whisper hallucinations

Short / silent / ambient audio makes Whisper invent phrases. The `HALLUCINATIONS`
regex list in `voice.js` filters these out (e.g. "Thank you.", "Subtitles by",
"[Music]", standalone "you", "so", "right"). If you see a phrase being treated
as a real answer when the user clearly didn't speak, add it to that list.

---

## File-pick double dialog

`#menu-opt-upload` and `#menu-opt-camera` are `<label>` elements wrapping a
hidden `<input type="file">`. Labels natively trigger their wrapped input on
click — adding a JS `click()` handler on top fires the dialog twice.

**Don't add `addEventListener('click', () => fileInput.click())`** to a label
that already wraps the input. Just listen for the `change` event on the input.

---

## Pre-baked Anna clips (greeting, prompt-email)

Anna's voice for some prompts is a pre-recorded MP4 instead of live TTS:

| Clip | File | Used for |
|---|---|---|
| Greeting | `assets/greeting.mp4` | First step (`prospect_name`) — dispatched from `chat.js` immediately on Get Started |
| Email prompt | `assets/prompt-email.mp4` | `prospect_email` step — dispatched from `voice.js askStep` |

The clips are sent to the iframe via
`postMessage({ type: 'anna-clip-blob', blob })`. The iframe handler in
`simpledemo-preview.html` plays them as a full-frame overlay above the idle
loop.

**Critical:** the overlay uses `object-fit: contain` (not `cover`) and **no**
`transform: scale` or `clip-path` mask. Earlier code masked the overlay to a
38%×36% ellipse and scaled it 1.03x to use as a lipsync mouth-only overlay —
that's wrong for full talking-head clips and made Anna's head look bloated.
If you re-add lipsync via Wav2Lip/F5 later, gate that styling behind a
`msg.lipsync === true` flag instead of applying it to all clips.

Clip duration is probed at load time in `chat.js` (`probeClipDuration`) and
stored on `G.greetingClipDuration` / `G.staticPromptDurations[stepKey]`.
`askStep` waits `durMs + 600ms` before opening the mic so we don't race the
end of the clip. **Don't** estimate duration from blob size — video bitrates
make the math wildly wrong.

---

## TTS timeout

Line ~162 of `voice.js`:

```js
const timer = setTimeout(() => ctrl.abort(), 100);
```

100ms is testing mode — it forces the live TTS fetch to abort and falls back
to browser `speechSynthesis`. Set this to 8000ms to use Anna's real voice
(Modal F5-TTS via `https://anna-avatar-worker.littf02.workers.dev/tts`).

When raising it back to 8000, also expect:
- ~5s cold start on the first call (Modal container spinning up)
- ~1s per call once warm
- A 90s keep-alive ping is already wired in `voice.start()`

---

## What NOT to do

| Anti-pattern | Why it breaks |
|---|---|
| `async` Get Started handler with `getUserMedia` after an `await` | Loses iOS gesture context → `NotAllowedError` |
| Calling `getUserMedia` recursively from `recognition.onerror` | That callback is async context, not gesture → fails on iOS |
| Closing `audioCtx` in `mediaRecorder.onstop` | Meter goes flat between questions; users think mic is off |
| `object-fit: cover` + scale + ellipse mask on full-frame Anna clips | Bloated/zoomed-in head |
| Adding a JS `click()` handler on a `<label>` that wraps the file input | File picker opens twice |
| Estimating clip duration from `blob.size / 50000` | Off by 1000x for video — mic opens mid-clip and SR captures Anna's voice |
| Removing the `_heldMicStream` and going back to async `getUserMedia` | iOS users get `NotAllowedError` after the greeting |

---

## The "Get Started" → mic-on flow, step by step

1. User clicks **Get Started** (real user gesture).
2. `chat.js` initStartButton runs synchronously inside the click:
   - Hides the info card, shows `#hg-chat-side`.
   - Forwards `user-unlock` + `hostgen-start` to the iframe.
   - **Calls `getUserMedia()`** (still in gesture context). The browser shows
     the permission dialog. On allow, the stream lands on `G._heldMicStream`.
   - Pre-warms `webkitSpeechRecognition` permission (legacy — left in case we
     ever flip `useSR: true`).
   - Dispatches `assets/greeting.mp4` to the iframe (Anna says her line).
   - Calls `voice.start()`.
3. `voice.start()` sets `stepIndex = 0` and calls `askStep()`.
4. `askStep()` for step 0 sees `G._greetingPlayed === true`, skips `speak()`,
   and `await G.wait(greetingClipDuration + 600)`.
5. After the wait, `startListening()` is called.
6. `startListening()` reads `_heldMicStream`, hands it to `MediaRecorder`,
   calls `startVAD()` → `startMeterLoop()` (the meter starts animating now).
7. User speaks. VAD detects speech, then 1.5s of silence, then triggers
   `stopListening()`.
8. `mediaRecorder.onstop` blobs the audio, posts to Whisper, gets a transcript.
9. `handleAnswer(text, true)` cleans / commits / advances → `askStep()` again
   for step 1. Mic stays armed (stream + audioCtx still alive).

If anything breaks, work back from this list — the failure point is almost
always one of these steps.

---

## Mic UI

The DOM still has `<button id="hg-mic-btn">` for backwards compatibility, but
it's hidden via CSS:

```css
#hg-mic-btn { display: none !important; }
```

The user-visible mic indicator is `#hg-mic-meter-wrap` — a 14px-tall
gold-bordered rounded bar. The inner `#hg-mic-level` div has its `width`
animated 0–100% by `startMeterLoop`. `#hg-mic-hint` shows the current state
text ("Listening… speak now", "Transcribing…", etc).

If you ever want the tap-to-talk button back, just remove the `display: none`
rule. The click handler in `voice.js initUI` is still wired.

---

## Cloning / rebuilding checklist

If you copy this app to a new project and the mic doesn't work:

1. Confirm `_heldMicStream` is being acquired in the Get Started click handler
   (check console for `[chat] initial mic prompt failed`).
2. Confirm `<iframe ... allow="autoplay; microphone">` is set (without it,
   the iframe's audio playback will be muted on mobile).
3. Confirm the Cloudflare Pages domain has mic permission in the browser.
4. Confirm `pickMimeType()` returns a non-empty string on the target browser
   (`audio/mp4` for iOS Safari, `audio/webm;codecs=opus` for Chrome).
5. Confirm `audioCtx.state` is `running` (not `suspended`). The
   `audioCtx.resume()` call inside `ensureAudioCtx` should handle this, but
   some browsers gate AudioContext on a user gesture.
6. Open DevTools → Application → Permissions → ensure microphone is
   "Allow" for the site origin.

If audio is captured but transcribe fails: check that the Worker
(`anna-avatar-worker.littf02.workers.dev/transcribe`) is up and that the
`GROQ_KEY` secret is set in Worker env. The browser console will surface the
HTTP error.

---

_Last updated: 2026-05-03._
