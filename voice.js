(function (G) {
  const CARTESIA_KEY   = 'sk_car_uYjUXbPhRXncyjAW7411TZ';
  const CARTESIA_VOICE = 'd8955cfc-7f79-4d3f-a460-87c56ba0c76b';
  const CARTESIA_URL   = 'https://api.cartesia.ai/tts/bytes';

  // Conversation state
  let prospectName   = '';
  let restaurantName = '';
  let pendingConfirm  = false;
  let confirmRejects  = 0;    // "no" count for current field; 2 → type fallback
  let lastAttempt     = '';   // previous cleaned value, passed to LLM on corrections
  let menuItems       = [];   // extracted items [{name, price, desc, cat}]

  const EMAIL_RX = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

  // Flow:
  //  0. prospect_name  → "what should I call you?"
  //  1. business_name  → "what's the name of your restaurant?" + voice confirm
  //  2. prospect_email → "let me grab your email so we don't lose your edits"
  //  3. cuisine_type   → "what type of cuisine?"
  //  4. menu           → upload widget / URL / 5 items
  //  5. [finish]       → "give me a few minutes…"
  const STEPS = [
    {
      key:   'prospect_name',
      speak: "Great, it looks like you're ready to get started, can I get your name?",
      hint:  'Say your name…',
    },
    {
      key:   'business_name',
      speak: (s) => `Nice to meet you, ${s.prospectName}. What's the name of your restaurant?`,
      hint:  'Say your restaurant name…',
    },
    {
      key:   'prospect_email',
      speak: "Let me just grab your email so we don't lose your edits — and I can send your demo to you.",
      hint:  'Speak your email address…',
    },
    {
      key:   'cuisine_type',
      speak: (s) => `And what type of cuisine does ${s.restaurantName} serve?`,
      hint:  'e.g. Italian, BBQ, Mexican…',
    },
    {
      key:   'menu',
      speak: "What about your menu? You can upload a photo or PDF, take a picture, or paste a link to your website. Don't have anything handy? Just tell me five items and I'll build the rest.",
      hint:  'Upload, link, or describe your menu…',
    },
  ];

  let stepIndex      = -1;
  let recognition    = null;
  let srUnavailable  = false;   // set true after permission denied so we stop retrying SR
  let elBtn, elHint, elShell, elMenuWidget;
  let inReview = false;  // true when the final review form is open
  let _keepAliveTimer = null;

  // Form helpers
  const FIELD_KEYS = ['prospect_name', 'business_name', 'prospect_email', 'cuisine_type', 'menu'];
  const FIELD_LABELS = {
    prospect_name: 'name',
    business_name: 'restaurant name',
    prospect_email: 'email',
    cuisine_type: 'cuisine',
    menu: 'menu',
  };
  function $field(key) { return document.getElementById('field-' + key); }
  function $row(key)   { return document.querySelector('.form-row[data-key="' + key + '"]'); }
  function setActiveStepUI(key) {
    document.querySelectorAll('.form-row').forEach((r) => {
      r.removeAttribute('data-active');
    });
    const row = $row(key);
    if (row) row.setAttribute('data-active', 'true');
    const num = (FIELD_KEYS.indexOf(key) + 1) || 1;
    const numEl = document.getElementById('hg-step-num');
    if (numEl) numEl.textContent = String(num);
  }
  function setFieldValue(key, value) {
    const el = $field(key);
    if (el) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = value || '';
      else el.textContent = value || '—';
    }
    const row = $row(key);
    if (row && value) row.setAttribute('data-filled', 'true');
  }
  function makeFieldsEditable(editable) {
    document.querySelectorAll('.form-row').forEach((r) => {
      const inputs = r.querySelectorAll('input.form-a, textarea.form-a');
      inputs.forEach((i) => {
        if (editable) { i.removeAttribute('readonly'); r.classList.add('editable'); }
        else          { i.setAttribute('readonly', ''); r.classList.remove('editable'); }
      });
    });
    // Also handle the dynamically-created menu item inputs
    document.querySelectorAll('#field-menu .mi-name, #field-menu .mi-price').forEach((i) => {
      if (editable) i.removeAttribute('readonly');
      else i.setAttribute('readonly', '');
    });
    const menuEl = document.getElementById('field-menu');
    if (menuEl) {
      if (editable) menuEl.classList.add('editable');
      else menuEl.classList.remove('editable');
    }
  }
  function readField(key) {
    const el = $field(key);
    if (!el) return '';
    return (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : el.textContent || '').trim();
  }

  // Estimate WAV playback duration from blob size.
  // F5-TTS always outputs 24kHz mono 16-bit = 48000 bytes/sec.
  // Subtract 44-byte header; cap at 20s so a garbage value never hangs the mic.
  function wavDurationMs(blob) {
    const dur = Math.round(Math.max(0, blob.size - 44) / 48);
    return (dur > 0 && dur < 20000) ? dur : null;
  }

  // ── TTS — Anna voice via Modal F5-TTS (worker /tts proxy) ────────────────
  const TTS_URL      = 'https://anna-avatar-worker.littf02.workers.dev/tts';
  const RENDERER_URL = window.AIHostGenConfig?.rendererUrl || '';

  let _currentAudio = null;
  let _utteranceCounter = 0;

  function stopCurrentAudio() {
    if (_currentAudio) {
      try { _currentAudio.pause(); _currentAudio.src = ''; } catch(e) {}
      _currentAudio = null;
    }
  }

  // Update the status text under Anna's name
  function setAnnaStatus(text, cls) {
    const el = document.getElementById('anna-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'anna-status' + (cls ? ' ' + cls : '');
  }

  // Show/hide the speaking ring on the avatar frame
  function setAvatarSpeaking(on) {
    const frame = document.getElementById('avatar-frame');
    if (!frame) return;
    if (on) frame.classList.add('speaking');
    else    frame.classList.remove('speaking');
  }

  async function speak(text) {
    _annaSpeaking = true;
    stopCurrentAudio();
    G.chat?.sendToShell({ type: 'pause-videos' });
    setShellState('speaking');
    setAnnaStatus('Anna is speaking…', 'speaking');
    setAvatarSpeaking(true);

    try {
      const ctrl = new AbortController();
      // 8000ms = re-enable Anna's voice. 100ms = browser TTS (testing mode).
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let resp;
      try {
        resp = await fetch(TTS_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ transcript: text, speed: 0.75 }),
          signal:  ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) throw new Error('tts ' + resp.status);
      const audioBlob = await resp.blob();
      // A valid WAV is at least ~500 bytes. If Modal billing limit is hit it
      // returns a short error text with content-type audio/wav — catch that here.
      if (audioBlob.size < 500) throw new Error('tts response too small (' + audioBlob.size + 'b) — Modal billing limit?');

      // ── Fizzy-clover live lipsync ─────────────────────────────────────────
      // If the GPU pod is up (rendererPodUrl set), POST the WAV and wait for
      // the clip. Render takes ~330ms for a 2s clip — fast enough to add vs
      // playing audio cold. Falls back to audio-only if pod is down/slow.
      let vidBlob = null;
      const podUrl = window.AIHostGenConfig?.rendererPodUrl;
      if (podUrl) {
        try {
          // Snapshot clip_id before we start so we can detect when OUR clip is ready
          const prevCidResp = await fetch(podUrl + '/clip_id', { signal: AbortSignal.timeout(3000) });
          const { clip_id: prevCid = 0 } = await prevCidResp.json();

          // Fire the animation request
          const animResp = await fetch(podUrl + '/animate', {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav' },
            body: audioBlob,
            signal: AbortSignal.timeout(5000),
          });
          const animData = await animResp.json();

          if (animData.ok && animData.has_avatar) {
            // Poll for the new clip (max 12s for long utterances, check every 150ms for faster response)
            const deadline = Date.now() + 12000;
            while (Date.now() < deadline) {
              await G.wait(150);
              const cidResp = await fetch(podUrl + '/clip_id', { signal: AbortSignal.timeout(2000) });
              const { clip_id } = await cidResp.json();
              if (clip_id > prevCid) {
                const clipResp = await fetch(podUrl + '/latest_clip?cid=' + clip_id, { signal: AbortSignal.timeout(8000) });
                if (clipResp.ok) vidBlob = await clipResp.blob();
                break;
              }
            }
          }
        } catch (e) {
          console.warn('[voice] renderer error, using audio-only:', e?.message);
        }
      }

      G.avatar?.startTalkLoop();

      let playRejected = false;
      if (vidBlob) {
        // Lipsync arrived — play it (with audio) inside the iframe. No parent
        // audio. Wait roughly the video's duration so handleAnswer doesn't
        // race ahead.
        try { G.chat?.sendToShell({ type: 'anna-clip-blob', blob: vidBlob, withAudio: true }); } catch(_) {}
        // Wait for clip duration. F5-TTS outputs 24kHz 16-bit mono = 48000 bytes/sec.
        const durMs = wavDurationMs(audioBlob) ?? Math.min(8000, audioBlob.size / 48);
        await G.wait(Math.max(2000, durMs + 400));
      } else {
        // Lipsync missed — fall back to audio-only.
        const audioUrl = URL.createObjectURL(audioBlob);
        const audioPromise = new Promise((resolve, reject) => {
          const audio = new Audio(audioUrl);
          _currentAudio = audio;
          const done = () => {
            URL.revokeObjectURL(audioUrl);
            _currentAudio = null;
            resolve();
          };
          audio.onended = done;
          audio.onerror = (e) => {
            URL.revokeObjectURL(audioUrl);
            _currentAudio = null;
            reject(new Error('audio decode error'));
          };
          const p = audio.play();
          if (p && typeof p.catch === 'function') {
            p.catch((e) => {
              console.warn('[voice] audio.play() rejected:', e?.name, e?.message);
              playRejected = true;
              done();
            });
          }
        });
        try {
          await audioPromise;
        } catch(audioErr) {
          console.warn('[voice] audio error, falling back to browser TTS:', audioErr.message);
          playRejected = true;
        }
      }

      // If audio.play() was rejected or audio decode failed, fall back to browser TTS.
      if (playRejected) {
        G.avatar?.stopTalkLoop();
        await browserSpeak(text);
      }

    } catch (e) {
      console.warn('[voice] F5-TTS error, falling back to browser TTS:', e.message);
      await browserSpeak(text);
    }

    G.avatar?.stopTalkLoop();
    G.avatar?.idle();
    _annaSpeaking = false;
    setAvatarSpeaking(false);
    setShellState('idle');
    setAnnaStatus('Anna is listening', '');
  }

  function browserSpeak(text) {
    return new Promise((resolve) => {
      const ss = window.speechSynthesis;
      if (!ss) return resolve();

      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };

      // Poll `speechSynthesis.speaking` every 80ms — onend is unreliable on
      // the first utterance after cancel() in Chrome/Brave. Cap at the natural
      // speech duration: ~290 ms per word at rate 1.15, plus a 400 ms tail.
      const wordCount = (text.match(/\S+/g) || []).length;
      const naturalMs = Math.max(900, wordCount * 290 + 400);
      const startTs = Date.now();
      let pollSawSpeaking = false;
      const poll = setInterval(() => {
        if (done) { clearInterval(poll); return; }
        const speaking = !!ss.speaking;
        if (speaking) pollSawSpeaking = true;
        // Resolve when speech has begun and then stopped
        if (pollSawSpeaking && !speaking) { clearInterval(poll); finish(); return; }
        // Hard cap so we never wait longer than the natural duration
        if (Date.now() - startTs > naturalMs) { clearInterval(poll); finish(); }
      }, 80);

      function go() {
        ss.cancel();
        setTimeout(function () {
          const u = new SpeechSynthesisUtterance(text);
          u.lang  = 'en-US';
          u.rate  = 1.15;
          const vv = ss.getVoices();
          const v  = vv.find(x => x.lang.startsWith('en-') && x.localService)
                  || vv.find(x => x.lang.startsWith('en'))
                  || vv[0];
          if (v) u.voice = v;
          u.onend   = finish;
          u.onerror = finish;
          ss.speak(u);
        }, 60);
      }

      let started = false;
      function once() { if (started) return; started = true; go(); }

      if (ss.getVoices().length > 0) {
        once();
      } else {
        ss.addEventListener('voiceschanged', once, { once: true });
        setTimeout(once, 400);
      }
    });
  }

  // ── Shell visual state ─────────────────────────────────────────────────────
  function setShellState(state) {
    if (!elShell) elShell = document.querySelector('.shell-wrap');
    elShell?.classList.remove('anna-speaking', 'anna-listening');
    if (state !== 'idle') elShell?.classList.add('anna-' + state);
  }

  // ── STT + LLM via the deployed Cloudflare Worker ─────────────────────────
  // Worker at anna-avatar-worker proxies:
  //   /transcribe → Groq Whisper STT (server-side GROQ_KEY)
  //   /chat       → Groq Llama for cleaning ambiguous answers + corrections
  const TRANSCRIBE_URL = 'https://anna-avatar-worker.littf02.workers.dev/transcribe';
  const CHAT_URL       = 'https://anna-avatar-worker.littf02.workers.dev/chat';
  const VISION_URL     = 'https://anna-avatar-worker.littf02.workers.dev/vision';
  const IMAGE_URL      = 'https://anna-avatar-worker.littf02.workers.dev/generate-menu-image';

  // Look up a real food photo for a menu item. Uses the free stock-photo
  // proxy on aihostgen-checkout-worker (TheMealDB / Unsplash). Returns a
  // direct image URL on success, '' on miss.
  const STOCK_IMAGE_URL = 'https://aihostgen-checkout-worker.littf02.workers.dev/menu-image';
  async function generateMenuImage(item, cuisine) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(STOCK_IMAGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: item.name, cuisine }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) return '';
      const data = await r.json();
      return data.url || '';
    } catch (e) {
      console.warn('[voice] image lookup failed for', item.name, e.message);
      return '';
    }
  }

  // Generate images for all menu items in parallel. Mutates the array in place.
  async function generateMenuImages(items, cuisine) {
    if (!Array.isArray(items) || !items.length) return items;
    const results = await Promise.all(items.map((it) => generateMenuImage(it, cuisine)));
    results.forEach((dataUrl, i) => { if (dataUrl) items[i].imgUrl = dataUrl; });
    return items;
  }

  // Ask Llama to extract / correct a value from messy speech.
  // Returns the cleaned value (string), or '' on any failure.
  async function llmExtract(field, raw, priorAttempt) {
    const sys = 'You normalise restaurant onboarding answers. Reply with ONLY the cleaned value, no quotes, no explanation, no greeting. If you cannot tell, reply with the input unchanged.';
    let user;
    if (field === 'prospect_name') {
      user = `Extract the speaker's first name from: "${raw}". If they are spelling it out letter by letter (e.g. "K I T A", "K-I-T-A", "Capital O Capital G"), join the letters into the name (e.g. "Kita", "OG"). Return ONLY the name itself — a single word or two. If you cannot find a real name, return the input unchanged.`;
    } else if (field === 'business_name') {
      user = priorAttempt
        ? `The user previously said the restaurant name was "${priorAttempt}" but that was wrong. They are now correcting it. Their new utterance: "${raw}". Return the corrected restaurant name (apply spellings they call out, like "capital O capital G").`
        : `Extract just the restaurant name from: "${raw}"`;
    } else if (field === 'cuisine_type') {
      user = `Extract just the cuisine type (e.g. Italian, BBQ, Mexican) from: "${raw}"`;
    } else if (field === 'prospect_email') {
      user = `The user is reading their email out loud. They may pronounce each letter separately (e.g. "L I T T F zero two at gmail dot com" → "littf02@gmail.com"). They may also use whole words. "at" means @, "dot" means . . Concatenate spelled letters/digits with no spaces. Convert digits like "zero" to 0, "one" to 1, etc. Spoken text: "${raw}"\n\nReturn ONLY the email address, lowercase, no spaces, no quotes.`;
    } else {
      return '';
    }
    try {
      const r = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          stream: false,
          temperature: 0.1,
          max_tokens: 50,
          messages: [
            { role: 'system', content: sys },
            { role: 'user',   content: user },
          ],
        }),
      });
      if (!r.ok) return '';
      const data = await r.json();
      const out = data?.choices?.[0]?.message?.content || '';
      return out.replace(/^["'`\s]+|["'`\s.!?,;:]+$/g, '').trim();
    } catch (e) {
      console.warn('[voice] llmExtract failed:', e.message);
      return '';
    }
  }

  let mediaRecorder = null;
  let mediaStream   = null;
  let recordedChunks = [];
  let audioCtx = null;
  let analyser = null;
  let vadActive = false;
  let isRecording = false;
  let speechWasDetected = false;
  let recordingStartedAt = 0;
  let maxRecordTimer = null;
  let _annaSpeaking = false;  // true while TTS audio is playing — blocks mic from opening

  const SILENCE_THRESHOLD = 0.003;   // RMS below this counts as silence (low = sensitive)
  const SILENCE_DURATION  = 550;     // ms of silence after speech → auto-stop (lower = faster Anna)
  const MAX_RECORD_MS     = 12000;   // hard cap — 6s + 6s grace → Anna re-asks

  // Whisper "hallucinations" on silence + Anna's TTS bleed-through phrases.
  // These are short outputs that should NOT be treated as a user reply.
  const HALLUCINATIONS = [
    /^thank\s*you\.?$/i,
    /^thanks?\s+for\s+watching/i,
    /^you\s*\.?$/i,
    /^\[?\s*music\s*\]?\.?$/i,
    /^\[?\s*silence\s*\]?\.?$/i,
    /^\[?\s*background\s*noise\s*\]?\.?$/i,
    /^bye\.?$/i,
    // Very common Whisper hallucinations on ambient/short audio
    /^so\.?$/i,
    /^so,?\s+/i,        // "So, ..." — Whisper prefixes short clips with this
    /^i\s+see\.?$/i,
    /^i\s+think\.?$/i,
    /^you\s+know\.?$/i,
    /^yeah\.?$/i,
    /^sure\.?$/i,
    /^right\.?$/i,
    /^subtitles\s+by/i,
    /^\[.*\]$/,         // any bracketed annotation like [Music], [Laughter]
    // Common bleed-through fragments of Anna's prompts
    /^what\??$/i,
    /^name\??$/i,
    /^restaurant\??$/i,
    /^email\??$/i,
    /^cuisine\??$/i,
    /^menu\??$/i,
    /^\.$/,
    /^\.{2,}$/,
    /^okay?\.?$/i,
    /^uh+\.?$/i,
    /^um+\.?$/i,
  ];
  function isHallucination(text) {
    const t = (text || '').trim();
    if (!t) return true;
    if (t.length < 2) return true;  // single character is never a real answer
    return HALLUCINATIONS.some((rx) => rx.test(t));
  }

  // ── Answer cleaners — strip natural-language prefixes per step ────────────
  // The mic transcribes whole sentences ("My name is Kita") but we only want
  // the value ("Kita"). These regexes peel off the common conversational wrap.
  function titleCase(s) {
    return s.replace(/\b\w[\w']*/g, (w) => {
      if (/^[A-Z]{2,}$/.test(w)) return w;  // preserve BBQ, OG, NYC, etc.
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
  }

  // Detect spelled-out letters: "K-I-T-A", "K I T A", "Capital O Capital G" → join.
  // Handles: dashes, spaces, commas, periods, and "capital/uppercase/lower" spoken modifiers.
  function unspellLetters(t) {
    if (!t) return t;
    // Normalise all Unicode dashes/hyphens to ASCII '-' so the regex below
    // catches Whisper output that uses en-dash, non-breaking hyphen, etc.
    let s = t.replace(/[‐‑‒–—―−﹘﹣－]/g, '-');
    // Strip spoken case modifiers — "Capital O" → "O"
    s = s.replace(/\b(?:capital|uppercase|upper\s+case|lower(?:case)?|lower\s+case)\s+([A-Za-z])\b/gi, '$1');
    // Join any sequence of single letters separated by whitespace/dash/comma/period
    // e.g. "K-I-T-A", "K I T A", "K–I–T–A" → "KITA"
    s = s.replace(
      /\b([A-Za-z])(?:[\s\-,.]+[A-Za-z]\b)+/g,
      (match) => match.match(/[A-Za-z]/g).join('')
    );
    return s;
  }

  function cleanName(text) {
    let t = String(text || '').trim().replace(/[.!?,;:]+$/g, '');
    t = t.replace(/^(uh+|um+|hi|hello|hey|so|well|okay?|alright)[,\s]+/i, '');
    t = t.replace(/^(my\s+name\s+is|the\s+name\s+is|name\s+is|i\s*['']?\s*m|i\s+am|it\s*['']?\s*s|this\s+is|call\s+me|you\s+can\s+call\s+me|they\s+call\s+me|name\s*[:\-]?)\s+/i, '');
    t = t.replace(/\s+(by\s+the\s+way|thanks|thank\s+you).*$/i, '');
    t = t.trim().replace(/[.!?,;:]+$/g, '').trim();
    t = unspellLetters(t);
    return titleCase(t);
  }

  function cleanBusinessName(text) {
    let t = String(text || '').trim().replace(/[.!?,;:]+$/g, '');
    t = t.replace(/^(uh+|um+|so|well|okay?)[,\s]+/i, '');
    t = t.replace(/^(my\s+restaurant\s+is\s+(called\s+)?|the\s+(name\s+of\s+)?(my\s+|our\s+)?restaurant\s+is\s+(called\s+)?|it\s*['']?\s*s\s+called\s+|it\s*['']?\s*s\s+|we\s*['']?\s*re\s+called\s+|we\s+are\s+called\s+|the\s+name\s+is\s+|name\s+is\s+|called\s+|named\s+)/i, '');
    t = t.trim().replace(/[.!?,;:]+$/g, '').trim();
    t = unspellLetters(t);
    return titleCase(t);
  }

  function cleanCuisine(text) {
    let t = String(text || '').trim().replace(/[.!?,;:]+$/g, '');
    t = t.replace(/^(uh+|um+|so|well|okay?)[,\s]+/i, '');
    t = t.replace(/^(we\s+serve\s+|we\s+make\s+|we\s+have\s+|we\s*['']?\s*re\s+(a\s+|an\s+)?|we\s+are\s+(a\s+|an\s+)?|i\s+serve\s+|it\s*['']?\s*s\s+(a\s+|an\s+)?|it\s+is\s+(a\s+|an\s+)?|mostly\s+|primarily\s+)/i, '');
    t = t.replace(/\s+(food|cuisine|restaurant|place)\.?$/i, '');
    t = t.trim().replace(/[.!?,;:]+$/g, '').trim();
    return titleCase(t);
  }

  function cleanEmail(text) {
    let t = String(text || '').trim().toLowerCase();
    // Spoken email normalisation: "at" → @, "dot" → .
    t = t.replace(/\s+at\s+/g, '@').replace(/\s+dot\s+/g, '.');
    t = t.replace(/[\s,;:]/g, '');
    const m = t.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
    return m ? m[0] : t;
  }

  // ── Menu extraction helpers ───────────────────────────────────────────────
  // Resize + base64-encode an image File before sending to vision API.
  function fileToBase64(file, maxDim) {
    maxDim = maxDim || 1024;
    return new Promise(function(resolve, reject) {
      const reader = new FileReader();
      reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // Parse a JSON array of menu items from LLM output (handles code fences).
  function dedupeItems(arr) {
    const seen = new Set();
    return arr.filter((it) => {
      const key = (it.name || '').toLowerCase().trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function parseMenuItems(text) {
    let t = (text || '').trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const m = t.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (m) {
      try {
        const arr = JSON.parse(m[0]);
        if (Array.isArray(arr) && arr.length) return dedupeItems(arr).slice(0, 8);
      } catch(e) {}
    }
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr) && arr.length) return dedupeItems(arr).slice(0, 8);
    } catch(e) {}
    return [];
  }

  const MENU_PROMPT_SUFFIX = `Each item: {"name": string, "price": string (with $ sign, e.g. "$14"), "desc": string (1-2 appetizing sentences, 70-120 chars, highlight what makes the dish special — texture, key ingredients, flavour), "cat": string (MUST be exactly one of: "Feature Today", "Menu Highlights", "Chef's Picks")}. Distribute exactly 2 items per category. Return ONLY the JSON array, no explanation.`;

  // Convert a plain-text list ("Item Name - $14\nItem 2 - $12\n...") to item objects.
  function parseMenuLines(text) {
    return (text || '').split('\n').map(function(line) {
      line = line.trim().replace(/^\d+[.)]\s*/, '');
      if (!line || line.length < 2) return null;
      const m = line.match(/^(.+?)\s*[-–]\s*(\$?[\d.]+[^\s]*)(.*)$/);
      if (m) return { name: m[1].trim(), price: m[2].trim(), desc: (m[3] || '').trim(), cat: 'Menu Highlights' };
      return { name: line, price: '', desc: '', cat: 'Menu Highlights' };
    }).filter(Boolean).filter(function(it) { return it.name.length > 1; }).slice(0, 25);
  }

  async function extractMenuFromImage(file) {
    let b64;
    try { b64 = await fileToBase64(file); }
    catch(e) { console.warn('[menu] fileToBase64 failed:', e); return []; }
    // fileToBase64 always converts to JPEG via canvas — use image/jpeg regardless of input
    try {
      const r = await fetch(VISION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'image', image: 'data:image/jpeg;base64,' + b64 }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        console.warn('[menu] vision error:', data?.error || r.status);
        return [];
      }
      const lines = parseMenuLines(data.items || '').slice(0, 6);
      console.log('[menu] vision extracted', lines.length, 'items');
      return lines;
    } catch(e) {
      console.warn('[menu] extractMenuFromImage error:', e);
      return [];
    }
  }

  async function extractMenuFromUrl(url) {
    // Worker fetches the URL server-side to avoid CORS, then runs Llama extraction.
    try {
      const r = await fetch(VISION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'url', url }),
      });
      if (!r.ok) { console.warn('[menu] url vision HTTP', r.status); return []; }
      const data = await r.json();
      if (data.error) { console.warn('[menu] url vision error:', data.error); return []; }
      return parseMenuLines(data.items || '').slice(0, 6);
    } catch(e) {
      console.warn('[menu] extractMenuFromUrl error:', e);
      return [];
    }
  }

  async function extractMenuFromText(text) {
    try {
      const r = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          stream: false,
          temperature: 0.1,
          max_tokens: 700,
          messages: [
            { role: 'system', content: 'You organise restaurant menu items into structured JSON. Reply with ONLY a JSON array.' },
            { role: 'user', content: 'The restaurant owner described these menu items: "' + text + '". Format them as exactly 6 DISTINCT items — each must have a unique name, no repeats allowed. If fewer than 6 are provided, invent creative plausible additions in the same style and price range — do NOT repeat any item already listed. ' + MENU_PROMPT_SUFFIX },
          ],
        }),
      });
      if (!r.ok) return [];
      const data = await r.json();
      return parseMenuItems(data?.choices?.[0]?.message?.content || '');
    } catch(e) {
      console.warn('[menu] extractMenuFromText error:', e);
      return [];
    }
  }

  // Populate the menu textarea with an editable text list + push items to shell.
  function applyMenuItems(items) {
    if (!items || !items.length) return;
    menuItems = items;

    // Format as plain text: "Item Name - $Price" one per line
    const text = items.map(function(it) {
      let line = (it.name || '').trim();
      if (it.price) line += ' - ' + String(it.price).trim();
      return line;
    }).join('\n');

    setFieldValue('menu', text);
    sendMenuToShell(items);

    // Fire image generation in the background — cuisine may not be known yet so
    // we pass whatever is in the cuisine field at this moment (often empty at this
    // stage; that's fine, Flux still produces reasonable results).
    const cuisineNow = $field('cuisine_type')?.value?.trim() || '';
    generateMenuImages(items, cuisineNow).then(() => sendMenuToShell(items)).catch(() => {});
  }

  function sendMenuToShell(items) {
    if (!items || !items.length) return;
    const bycat = {};
    items.forEach(function(it) {
      const c = it.cat || 'Menu Highlights';
      if (!bycat[c]) bycat[c] = [];
      bycat[c].push({ name: it.name, price: it.price, desc: it.desc || '', imgUrl: it.imgUrl || '' });
    });
    const menu = Object.keys(bycat).map(function(cat) { return { cat: cat, items: bycat[cat] }; });
    G.chat?.sendToShell({ type: 'set-menu', value: menu });
  }

  function pickMimeType() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    for (const t of candidates) if (MediaRecorder.isTypeSupported(t)) return t;
    return '';
  }

  // ── MIC LIFECYCLE — DO NOT BREAK THIS ────────────────────────────────────
  // The mic stream is acquired ONCE on the first startListening() call and
  // held alive across every question in the flow. Only the MediaRecorder and
  // VAD analyser tear down between questions; the underlying MediaStream
  // stays open. This is intentional:
  //
  //   • One getUserMedia per session = no repeat permission prompts.
  //   • No track restart = no device-init races between questions.
  //   • Same stream means consistent input device across the whole form.
  //
  // releaseMic()      → per-question teardown. Closes audioCtx/analyser only.
  //                     Stream stays alive for the next startListening().
  // releaseMicFinal() → full teardown. Stops every track, closes audioCtx.
  //                     Call ONLY when the form is complete or the page is
  //                     navigating away. NEVER call between questions.
  //
  // If you need to "reset" the mic mid-flow because something glitched, prefer
  // restarting the MediaRecorder over releasing the stream. Releasing forces
  // a permission re-prompt on some browsers.
  // ──────────────────────────────────────────────────────────────────────────
  // Try to start listening via the browser's SpeechRecognition API.
  // Returns true if SR started successfully (caller should skip MediaRecorder path).
  // Returns false if SR is unavailable or permission was denied.
  function startListeningSR() {
    if (srUnavailable) return false;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return false;
    try {
      recognition = new SR();
      recognition.lang = 'en-US';
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      let srGotResult = false;

      recognition.onstart = () => {
        isRecording = true;
        setShellState('listening');
        setBtn('listening');
        setAnnaStatus('Listening…', 'listening');
        setHint('Listening… speak now (tap mic to stop)');
      };

      recognition.onresult = (event) => {
        srGotResult = true;
        const text = (event.results[0][0].transcript || '').trim();
        console.log('[voice] SR transcript:', JSON.stringify(text));
        setShellState('idle'); setBtn('idle');
        if (isHallucination(text)) {
          setHint("Didn't catch that — speak a bit louder and try again, or type below ↓");
          isRecording = false;
          return;
        }
        setAnnaStatus('Anna is thinking…', 'thinking');
        handleAnswer(text, true);
      };

      recognition.onerror = (event) => {
        if (!isRecording && event.error === 'aborted') return; // intentional stop
        console.warn('[voice] SR error:', event.error);
        isRecording = false;
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          srUnavailable = true;
          recognition = null;
          // SR denied — try MediaRecorder path (getUserMedia) as fallback
          startListening();
          return;
        }
        if (event.error === 'no-speech') {
          setHint("Didn't hear you — tap the mic and try again, or type below ↓");
          setShellState('idle'); setBtn('idle');
          return;
        }
        setHint("Didn't catch that — try again or type below ↓");
        setShellState('idle'); setBtn('idle');
      };

      recognition.onend = () => {
        isRecording = false;
      };

      recognition.start();
      return true;
    } catch(e) {
      console.warn('[voice] SR start failed:', e);
      recognition = null;
      return false;
    }
  }

  async function startListening(opts) {
    if (isRecording) return;
    if (_annaSpeaking) return;  // don't open mic while TTS is playing
    stopCurrentAudio();  // make sure Anna's voice is silent before we listen

    // SR is skipped by default — we always use MediaRecorder so the live audio
    // level meter (#hg-mic-meter-wrap) animates while the user speaks. SR has
    // no microphone-amplitude callback. Pass { useSR: true } to opt in.
    if (opts && opts.useSR && startListeningSR()) return;

    // Use the stream held from the Get Started gesture if available —
    // avoids needing getUserMedia in async context (fails on iOS Safari).
    const streamLive = !!(mediaStream && mediaStream.getTracks().some(t => t.readyState === 'live'));
    if (!streamLive) {
      const held = window.AIHostGen?._heldMicStream;
      if (held && held.getTracks().some(t => t.readyState === 'live')) {
        mediaStream = held;
        window.AIHostGen._heldMicStream = null;
      } else {
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
          });
        } catch (e) {
          console.warn('[voice] mic permission denied:', e?.name || e);
          setHint('🎙 Mic blocked — allow microphone in the URL bar, or type below ↓');
          setBtn('idle');
          return;
        }
      }
    }

    const mime = pickMimeType();
    if (!mime) {
      setHint('Recording not supported in this browser — type below ↓');
      setBtn('idle'); return;
    }

    recordedChunks = [];
    try {
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime });
    } catch (e) {
      console.warn('[voice] MediaRecorder init failed:', e);
      setHint('Recording error — type below ↓');
      setBtn('idle'); return;
    }

    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) recordedChunks.push(ev.data);
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordedChunks, { type: mime });
      const captured = speechWasDetected;
      recordedChunks = [];
      // Keep the mic stream + audioCtx alive across questions so the level
      // meter stays animated the entire conversation. Only the VAD speech-
      // detect logic pauses; the meter keeps drawing levels.
      vadActive = false;
      console.log('[voice] recorded blob:', blob.size, 'bytes,', blob.type, 'speechDetected:', captured);
      // Reject if VAD never detected speech — prevents Whisper from being
      // fed silent / ambient audio and hallucinating a phrase that advances
      // the flow without any user input. Auto re-ask the current step.
      if (!captured) {
        if (stepIndex >= 0 && STEPS[stepIndex] && !inReview) {
          setHint("I didn't hear you — let me ask again…");
          setShellState('idle'); setBtn('idle');
          await G.wait(300);
          await speak("I didn't hear you. Let me ask again.");
          await askStep();
        } else {
          setHint("Didn't hear you speak — tap the mic and try again, or type below ↓");
          setShellState('idle'); setBtn('idle');
        }
        return;
      }
      if (blob.size < 600) {
        setHint("Mic captured no audio — check your system mic input or type below ↓");
        setShellState('idle'); setBtn('idle');
        return;
      }
      setHint('Transcribing…');
      try {
        const filename = mime.includes('mp4') ? 'audio.mp4'
                        : mime.includes('ogg') ? 'audio.ogg'
                        : 'audio.webm';
        const text = await transcribe(blob, filename);
        console.log('[voice] transcript:', JSON.stringify(text));
        if (isHallucination(text)) {
          setHint("Didn't catch that — speak a bit louder and try again, or type below ↓");
          setShellState('idle'); setBtn('idle');
          return;
        }
        setAnnaStatus('Anna is thinking…', 'thinking');
        handleAnswer(text, true);
      } catch (e) {
        console.warn('[voice] transcribe failed:', e.message);
        setHint('Transcription error: ' + e.message + ' — type below ↓');
        setShellState('idle'); setBtn('idle');
      }
    };

    speechWasDetected = false;
    recordingStartedAt = Date.now();
    isRecording = true;
    mediaRecorder.start();
    setShellState('listening');
    setBtn('listening');
    setAnnaStatus('Listening…', 'listening');
    setHint('Listening… speak now (tap mic to stop)');
    startVAD();

    // 6-second "still listening" cue — if user hasn't spoken yet, reassure
    // them we're still waiting (we give them another 6 seconds before re-ask).
    setTimeout(() => {
      if (isRecording && !speechWasDetected) {
        setHint('Still listening… take your time');
      }
    }, 6000);

    // Hard timeout — at 12s with no speech we trigger the re-ask flow in onstop
    clearTimeout(maxRecordTimer);
    maxRecordTimer = setTimeout(() => {
      if (isRecording) {
        console.log('[voice] max-record timeout reached');
        stopListening();
      }
    }, MAX_RECORD_MS);
  }

  function stopListening() {
    if (!isRecording) return;
    isRecording = false;
    vadActive = false;
    clearTimeout(maxRecordTimer);
    try { if (recognition) { recognition.abort(); recognition = null; } } catch(e) {}
    try { mediaRecorder?.state === 'recording' && mediaRecorder.stop(); } catch(e) {}
  }

  function releaseMic() {
    // Per-question teardown is now a no-op — audioCtx + analyser + meter loop
    // stay alive for the entire conversation. VAD speech-detect logic pauses
    // via vadActive=false in mediaRecorder.onstop.
  }
  function releaseMicFinal() {
    // Full teardown — call only on flow end (form complete, page hide, etc).
    _meterLoopRunning = false;
    vadActive = false;
    try { mediaStream?.getTracks().forEach((t) => t.stop()); } catch(e) {}
    mediaStream = null;
    try { audioCtx?.close(); } catch(e) {}
    audioCtx = null; analyser = null;
  }

  // Per-recording silence-detection state. Reset every time recording starts.
  let _vadSilenceStart = null;
  let _vadSpeechDetected = false;
  let _vadPeakRms = 0;
  let _meterLoopRunning = false;

  function ensureAudioCtx() {
    if (audioCtx && analyser) return true;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch((e) => console.warn('[voice] audioCtx resume failed:', e));
      }
      const src = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      return true;
    } catch (e) {
      console.warn('[voice] audioCtx setup failed:', e);
      return false;
    }
  }

  function startMeterLoop() {
    if (_meterLoopRunning) return;
    if (!ensureAudioCtx()) return;
    _meterLoopRunning = true;
    const meter = document.getElementById('hg-mic-level');
    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      if (!_meterLoopRunning || !analyser) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      if (meter) {
        const pct = Math.min(100, Math.round(rms * 1500));
        meter.style.width = pct + '%';
      }
      // Speech detection — only active during a recording window.
      if (vadActive) {
        if (rms > _vadPeakRms) _vadPeakRms = rms;
        const inStartupWindow = Date.now() - recordingStartedAt < 150;
        if (rms > SILENCE_THRESHOLD && !inStartupWindow) {
          _vadSpeechDetected = true;
          speechWasDetected = true;
          _vadSilenceStart = null;
        } else if (_vadSpeechDetected) {
          if (!_vadSilenceStart) _vadSilenceStart = Date.now();
          else if (Date.now() - _vadSilenceStart > SILENCE_DURATION) {
            console.log('[voice] VAD auto-stop. peak RMS:', _vadPeakRms.toFixed(4));
            stopListening();
          }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function startVAD() {
    _vadSilenceStart = null;
    _vadSpeechDetected = false;
    _vadPeakRms = 0;
    vadActive = true;
    startMeterLoop();
  }

  async function transcribe(blob, filename) {
    const fd = new FormData();
    fd.append('file', blob, filename || 'audio.webm');
    fd.append('model', 'whisper-large-v3-turbo');
    fd.append('language', 'en');
    fd.append('response_format', 'json');
    const r = await fetch(TRANSCRIBE_URL, { method: 'POST', body: fd });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error('transcribe HTTP ' + r.status + ' ' + errText);
    }
    const data = await r.json();
    if (data?.error) throw new Error(data.error.message || 'transcribe error');
    return (data.text || '').trim();
  }

  // ── Menu widget ────────────────────────────────────────────────────────────
  function showMenuWidget() {
    if (!elMenuWidget) elMenuWidget = document.getElementById('hg-menu-widget');
    if (!elMenuWidget) return;
    elMenuWidget.hidden = false;
    // Pulse-highlight + scroll into view so the user notices it
    elMenuWidget.classList.add('menu-widget-pulse');
    setTimeout(() => elMenuWidget.classList.remove('menu-widget-pulse'), 1800);
    try { elMenuWidget.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {}
    setBtn('idle');
  }

  function hideMenuWidget() {
    if (!elMenuWidget) elMenuWidget = document.getElementById('hg-menu-widget');
    if (elMenuWidget) elMenuWidget.hidden = true;
  }

  async function advanceFromMenu() {
    hideMenuWidget();
    await finish();
  }

  function initMenuWidget() {
    elMenuWidget = document.getElementById('hg-menu-widget');
    if (!elMenuWidget) return;

    const fileInput   = document.getElementById('menu-file-input');
    const cameraInput = document.getElementById('menu-camera-input');

    // Shared handler for both file upload and camera capture
    async function handleMenuFile(file) {
      if (!file) return;
      hideMenuWidget();

      if (file.type === 'application/pdf') {
        await speak(`I can't read PDFs directly — can you type a few menu items instead?`);
        elMenuWidget.hidden = false;
        document.getElementById('menu-text-row').hidden = false;
        document.getElementById('menu-skip-btn').hidden = true;
        return;
      }

      setHint('Reading your menu…');
      let items = [];
      try { items = await extractMenuFromImage(file); } catch(e) { console.warn('[menu] image err:', e); }

      if (!items.length) {
        await speak(`I had trouble reading that photo — can you type a few items instead?`);
        elMenuWidget.hidden = false;
        document.getElementById('menu-text-row').hidden = false;
        document.getElementById('menu-skip-btn').hidden = true;
        return;
      }

      applyMenuItems(items);
      await G.session?.patch({ menu_source: 'image', menu_filename: file.name, menu_items: JSON.stringify(items) });
      await speak(`Found ${items.length} items from your menu. Take a look and hit Looks good when you're ready.`);
      await advanceFromMenu();
    }

    // Inputs are inside <label> elements, so the label handles the click natively.
    // Don't add a JS click handler — that double-fires and reopens the file dialog.
    fileInput?.addEventListener('change', () => handleMenuFile(fileInput.files?.[0]));
    cameraInput?.addEventListener('change', () => handleMenuFile(cameraInput.files?.[0]));

    document.getElementById('menu-url-submit')?.addEventListener('click', async () => {
      const url = document.getElementById('menu-url-input')?.value?.trim();
      if (!url) return;
      hideMenuWidget();
      setHint('Fetching menu from that URL…');

      let items = [];
      try { items = await extractMenuFromUrl(url); } catch(e) { console.warn('[menu] url err:', e); }

      if (!items.length) {
        await speak(`I couldn't pull menu items from that link — want to type a few instead?`);
        elMenuWidget.hidden = false;
        document.getElementById('menu-text-row').hidden = false;
        document.getElementById('menu-skip-btn').hidden = true;
        return;
      }

      applyMenuItems(items);
      await G.session?.patch({ menu_source: 'url', menu_url: url, menu_items: JSON.stringify(items) });
      await speak(`Got ${items.length} items from your menu. Take a look and hit Looks good when you're ready.`);
      await advanceFromMenu();
    });

    document.getElementById('menu-skip-btn')?.addEventListener('click', async () => {
      document.getElementById('menu-text-row').hidden = false;
      document.getElementById('menu-skip-btn').hidden = true;
      await speak(`No problem — type five or six items from your menu and I'll fill in the rest.`);
      setHint('Type your menu items below…');
    });

    document.getElementById('menu-text-submit')?.addEventListener('click', async () => {
      const text = document.getElementById('menu-text-input')?.value?.trim();
      if (!text) return;
      hideMenuWidget();
      setHint('Organising your menu…');

      let items = [];
      try { items = await extractMenuFromText(text); } catch(e) { console.warn('[menu] text err:', e); }

      if (!items.length) {
        setFieldValue('menu', text);
        await G.session?.patch({ menu_source: 'text', menu_text: text });
        await speak(`Got it. I'll build the full menu from those items.`);
        await advanceFromMenu();
        return;
      }

      applyMenuItems(items);
      await G.session?.patch({ menu_source: 'text', menu_text: text, menu_items: JSON.stringify(items) });
      await speak(`I've got ${items.length} items. Check them over and hit Looks good when ready.`);
      await advanceFromMenu();
    });
  }

  // ── Step execution ─────────────────────────────────────────────────────────
  async function askStep() {
    const step = STEPS[stepIndex];
    if (!step) { await finish(); return; }

    // Reset confirmation state for each fresh step
    confirmRejects = 0;
    lastAttempt = '';

    setActiveStepUI(step.key);

    const text = typeof step.speak === 'function'
      ? step.speak({ prospectName, restaurantName })
      : step.speak;

    setHint(step.hint);
    // If the greeting clip was pre-rendered and dispatched on the Get Started
    // click, skip the first speak() so we don't double-play it.
    if (stepIndex === 0 && G._greetingPlayed) {
      G._greetingPlayed = false;
      // Use probed duration from chat.js; fall back to 7s if not ready yet.
      const durMs = G.greetingClipDuration || 7000;
      await G.wait(durMs + 200);
    } else if (G.staticPromptClips && G.staticPromptClips[step.key]) {
      // Pre-baked clip available for this step — dispatch directly to the
      // iframe (lipsync + audio in one), skip the live TTS+animate roundtrip.
      const blob = G.staticPromptClips[step.key];
      try { G.chat?.sendToShell({ type: 'anna-clip-blob', blob, withAudio: true }); } catch(_) {}
      // Use probed duration; fall back to 8s if not ready yet.
      const durMs = G.staticPromptDurations?.[step.key] || 8000;
      await G.wait(durMs + 200);
    } else {
      await speak(text);
    }

    if (step.key === 'menu') {
      showMenuWidget();
      // Keep the typed input visible so users without a mic can type menu items directly
      showInputArea();
      setHint('Speak your menu items, type below, or upload / link above…');
      // Also open the mic so the prospect can SAY their items out loud
      startListening();
      return;
    }
    showInputArea();

    startListening();
  }

  function showInputArea() {
    const el = document.getElementById('hg-input-area');
    if (el) el.style.display = '';
  }
  function hideInputArea() {
    const el = document.getElementById('hg-input-area');
    if (el) el.style.display = 'none';
  }

  // Save a confirmed field value to session + handle side effects.
  // PB write is fire-and-forget so the next prompt doesn't wait on the network.
  function commitField(key) {
    const value = readField(key);
    const patch = {};
    patch[key] = value;
    G.session?.patch(patch).catch((e) => console.warn('[voice] PB patch failed:', e?.message));
    // Brand name needs a final push to the shell after confirm
    if (key === 'business_name') G.chat?.sendToShell({ type: 'set-brand', value });
  }

  async function handleAnswer(text, isVoice) {
    if (!text) return;
    stopListening();

    const step = STEPS[stepIndex];
    if (!step) return;

    // ── Universal confirmation branch ──────────────────────────────────────
    if (pendingConfirm) {
      pendingConfirm = false;
      const yes = /\b(yes|yeah|correct|right|yep|sure|looks?\s+good|that\s*['']?\s*s\s+(right|correct)|spelled\s+right)\b/i.test(text);
      const no  = /\b(no|nope|wrong|incorrect|not\s+right|change|different|redo)\b/i.test(text);
      if (yes && !no) {
        confirmRejects = 0;
        lastAttempt = '';
        await commitField(step.key);
        stepIndex++;
        await askStep();
      } else {
        // Check if the correction is already in the same utterance: "no, it's John Smith"
        const correctionText = text
          .replace(/^\s*(?:no|nope|wrong|incorrect|not\s+right|change|different|redo)[,.]?\s*/i, '')
          .replace(/^(?:it[''']?s|its|the|a|actually|should\s+be|i\s+(?:said|mean|meant)|make\s+it|change\s+it\s+to|the\s+correct\s+(?:one\s+is|answer\s+is)?)\s*/i, '')
          .trim();

        if (correctionText.length >= 2) {
          setFieldValue(step.key, '');
          if (step.key === 'business_name') { restaurantName = ''; G.chat?.sendToShell({ type: 'set-brand', value: '' }); }
          await handleAnswer(correctionText, isVoice);
          return;
        }

        confirmRejects++;
        // Clear the field so the user knows it wasn't accepted
        setFieldValue(step.key, '');
        if (step.key === 'business_name') { restaurantName = ''; G.chat?.sendToShell({ type: 'set-brand', value: '' }); }
        if (confirmRejects >= 2) {
          confirmRejects = 0;
          showInputArea();
          await speak(`No worries — type your ${FIELD_LABELS[step.key]} in the box below.`);
          setHint('Type it below ↓');
          document.getElementById('hg-typed-input')?.focus();
          setShellState('idle'); setBtn('idle');
        } else {
          await speak(`Let's try that again.`);
          setHint('Say it again…');
          startListening();
        }
      }
      return;
    }

    // ── Menu step: voice answers are spoken menu items, not a one-word answer.
    // Route through extractMenuFromText (same as the typed-input path) instead
    // of the regular field-confirm flow.
    if (step.key === 'menu') {
      hideMenuWidget();
      setHint('Organising your menu…');
      let items = [];
      try { items = await extractMenuFromText(text); } catch (e) { console.warn('[menu] voice err:', e); }
      if (!items.length) {
        setFieldValue('menu', text);
        G.session?.patch({ menu_source: 'voice', menu_text: text }).catch(() => {});
        await speak("Got it. I'll build the full menu from those items.");
        await advanceFromMenu();
      } else {
        applyMenuItems(items);
        G.session?.patch({ menu_source: 'voice', menu_text: text, menu_items: JSON.stringify(items) }).catch(() => {});
        await speak(`I've got ${items.length} items. Check them over and hit Looks good when ready.`);
        await advanceFromMenu();
      }
      return;
    }

    // ── Noise / background-audio guard ─────────────────────────────────────
    // If voice input is way too long for the field, it's ambient audio — discard it.
    const MAX_WORDS = { prospect_name: 5, business_name: 10, cuisine_type: 6, prospect_email: 8 };
    const wordCount = text.trim().split(/\s+/).length;
    const maxWords = MAX_WORDS[step.key] || 12;
    if (isVoice && wordCount > maxWords) {
      setHint('Didn\'t catch that — try again…');
      await G.wait(300);
      startListening();
      return;
    }

    // ── Process the raw answer ──────────────────────────────────────────────
    let cleaned = text;
    if (step.key === 'prospect_name')       cleaned = cleanName(text);
    else if (step.key === 'business_name')  cleaned = cleanBusinessName(text);
    else if (step.key === 'cuisine_type')   cleaned = cleanCuisine(text);
    else if (step.key === 'prospect_email') cleaned = cleanEmail(text);
    if (!cleaned || cleaned.length < 2) cleaned = text;
    // Run LLM cleanup ONLY when the regex cleaner clearly didn't get a tidy
    // result. If the cleaner already produced a short value, trust it and
    // skip the Groq round-trip (~500-1500 ms saved per answer).
    const cleanedWords = cleaned.split(/\s+/).length;
    const hasCorrectionSignals = /\b(no|not|wrong|spell|capital|lowercase|uppercase)\b/i.test(text);
    const looksMessy = (hasCorrectionSignals && cleanedWords > 2) || cleanedWords > 4;
    if (looksMessy) {
      setHint('Thinking…');
      const llmResult = await llmExtract(step.key, text, lastAttempt);
      // Guard: reject LLM responses that indicate it couldn't find a real value
      const llmIsUseless = !llmResult || llmResult.length < 2
        || /^(no\s+(name|restaurant|cuisine|email)|not\s+mentioned|cannot|unable|n\/a|none|unknown|unclear)/i.test(llmResult)
        || /no\s+\w+\s+mentioned/i.test(llmResult);
      if (!llmIsUseless) {
        // Llama sometimes echoes spelled letters verbatim ("K-I-T-A").
        // Re-run the same cleaner the voice path uses so we don't undo our work.
        if (step.key === 'prospect_name')       cleaned = cleanName(llmResult);
        else if (step.key === 'business_name')  cleaned = cleanBusinessName(llmResult);
        else if (step.key === 'cuisine_type')   cleaned = cleanCuisine(llmResult);
        else                                    cleaned = llmResult;
      }
    }

    // Email always needs a Llama pass (spelled letters + digits) + format validation
    if (step.key === 'prospect_email') {
      if (isVoice) {
        setHint('Working out your email…');
        const llm = await llmExtract('prospect_email', text, lastAttempt);
        if (llm) cleaned = cleanEmail(llm);
      }
      if (!EMAIL_RX.test(cleaned)) {
        if (isVoice) {
          await speak(`I didn't quite catch that — say or spell your email again. Use "at" for the at-sign and "dot" for the period.`);
          setHint('Say or spell your email again…');
        } else {
          await speak(`That doesn't look like a valid email — try again.`);
          setHint('Type it like: name@example.com');
          document.getElementById('hg-typed-input')?.focus();
        }
        if (isVoice) startListening();
        else { setShellState('idle'); setBtn('idle'); }
        return;
      }
      cleaned = cleaned.toLowerCase();
    }

    lastAttempt = cleaned;

    // Apply live preview updates before confirmation
    if (step.key === 'prospect_name')      prospectName = cleaned;
    else if (step.key === 'business_name') { restaurantName = cleaned; G.chat?.sendToShell({ type: 'set-brand', value: cleaned }); }

    // Show value in the form field
    setFieldValue(step.key, cleaned);
    setHint(`"${cleaned}" — does that look right?`);

    // ── Ask for confirmation ────────────────────────────────────────────────
    // Shorter text = shorter F5-TTS audio = faster generation
    let confirmLine;
    if (step.key === 'business_name') {
      confirmLine = `${cleaned}. Spelled right?`;
    } else if (step.key === 'prospect_email') {
      confirmLine = `${cleaned}. Look right?`;
    } else {
      confirmLine = `${cleaned}. Right?`;
    }

    pendingConfirm = true;
    await speak(confirmLine);
    startListening();
  }

  async function finish() {
    // Enter review state — show all fields editable, ask user to confirm/edit
    inReview = true;
    document.querySelectorAll('.form-row').forEach((r) => r.removeAttribute('data-active'));
    makeFieldsEditable(true);
    hideMenuWidget();
    hideInputArea();
    const reviewActions = document.getElementById('hg-review-actions');
    if (reviewActions) reviewActions.hidden = false;
    setHint('Edit anything, then click "Looks good" →');

    await speak(`Here's everything I caught. Click any field to make changes, then hit Looks good when you're ready.`);
  }

  // Build the shareable preview URL. imgUrl is now a permanent R2 URL (~80 chars)
  // so it's safe to include in the encoded menu — the email link shows real images.
  function buildPreviewUrl(brandName, items) {
    const groups = {};
    (items || []).forEach(function(it) {
      const c = it.cat || 'Menu Highlights';
      if (!groups[c]) groups[c] = [];
      groups[c].push({ name: it.name, price: it.price, desc: it.desc || '', imgUrl: it.imgUrl || '' });
    });
    const menuArr = Object.keys(groups).map(function(c) { return { cat: c, items: groups[c] }; });
    const base = 'https://demobuild-7bv.pages.dev/simpledemo-preview.html';
    const params = new URLSearchParams();
    params.set('brand', brandName || '');
    if (menuArr.length) {
      try { params.set('menu', btoa(unescape(encodeURIComponent(JSON.stringify(menuArr))))); } catch(e) {}
    }
    // Tell the full-screen preview where to send the user when they want to
    // come back to the demo page (so they can hit the pay button).
    params.set('back', location.origin + '/?canceled=1');
    return base + '?' + params.toString();
  }

  async function confirmAndBuild() {
    inReview = false;
    makeFieldsEditable(false);
    document.getElementById('hg-review-actions').hidden = true;

    // Collect edited field values
    const final = {
      prospect_name:  readField('prospect_name'),
      business_name:  readField('business_name'),
      prospect_email: readField('prospect_email'),
      cuisine_type:   readField('cuisine_type'),
    };
    await G.session?.patch(final);
    G.chat?.sendToShell({ type: 'set-brand', value: final.business_name });

    // Parse the (possibly user-edited) menu textarea and re-send to shell
    const menuText = readField('menu');
    if (menuText && menuText !== '—') {
      const updatedItems = menuText.split('\n').map(function(line, i) {
        line = line.trim();
        if (!line) return null;
        const m = line.match(/^(.+?)\s*[-–]\s*(\$?[\d.]+.*)$/);
        if (m) return { name: m[1].trim(), price: m[2].trim(), desc: menuItems[i]?.desc || '', cat: menuItems[i]?.cat || 'Menu Highlights', imgUrl: menuItems[i]?.imgUrl || '' };
        return { name: line.replace(/^\d+[.)]\s*/, '').trim(), price: menuItems[i]?.price || '', desc: menuItems[i]?.desc || '', cat: menuItems[i]?.cat || 'Menu Highlights', imgUrl: menuItems[i]?.imgUrl || '' };
      }).filter(Boolean).filter(function(it) { return it.name.length > 1; });
      if (updatedItems.length) {
        menuItems = updatedItems;
        sendMenuToShell(updatedItems);
        await G.session?.patch({ menu_items: JSON.stringify(updatedItems) });
      }
    }

    G.chat?.sendToShell({ type: 'hostgen-generate' });

    showLoadingOverlay();

    // Generate one image per menu item via Workers AI (Flux schnell), in parallel.
    // This is the heavy step — runs during the loading overlay so the user sees
    // the rotating "training her on your menu…" copy while it works.
    await generateMenuImages(menuItems, final.cuisine_type);
    // Push the image-enriched menu into the iframe so the preview shows real photos
    sendMenuToShell(menuItems);

    // Build preview URL AFTER images are populated so the email link has them too
    const previewUrl = buildPreviewUrl(final.business_name, menuItems);
    await G.session?.patch({ preview_url: previewUrl, stage: 'complete' });

    // Send email now that the preview link is final
    const emailPromise = fetch('https://anna-avatar-worker.littf02.workers.dev/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:       final.prospect_name,
        email:      final.prospect_email,
        restaurant: final.business_name,
        cuisine:    final.cuisine_type,
        previewUrl,
      }),
    }).then(r => r.json()).then(d => {
      if (d.error) console.warn('[voice] email failed:', d.error);
      else console.log('[voice] preview email sent, id:', d.id);
    }).catch(e => console.warn('[voice] email error:', e.message));

    await emailPromise.catch(() => {});

    // Hide loading overlay and reveal the success state
    hideLoadingOverlay();
    showSuccessState(previewUrl, final.business_name);

    // Anna narrates the reveal, then walks through the demo.
    // _walkthroughActive blocks item-tapped echoes from the iframe during this phase.
    G._walkthroughActive = true;
    try {
      await speak(`Okay — your AI host for ${final.business_name || 'your restaurant'} is ready. I just sent the preview to your email. Let me show you how she works.`);
      await G.wait(400);

      // Scroll to menu items
      G.chat?.sendToShell({ type: 'demo-scroll-to', selector: '.hscroll' });
      await G.wait(700);
      await speak(`Here are your ${menuItems.length} menu items — trained on your restaurant.`);
      await G.wait(400);
      await speak(`You can click on any item and I'll describe it. Your customers can add it straight to their order.`);
      await G.wait(900);

      // Speak the first item's description BEFORE clicking so the audio fires
      // before any potential interference from the programmatic iframe click.
      const firstItem = menuItems[0];
      if (firstItem) {
        let itemSpoken = firstItem.name || 'this item';
        if (firstItem.desc) itemSpoken += '. ' + firstItem.desc;
        if (firstItem.price) itemSpoken += ' It\'s ' + firstItem.price + '.';
        await speak(itemSpoken);
      }
      await G.wait(300);

      // Now click the first menu item — the screen switches to the item detail
      // right after Anna finishes describing it.
      G.chat?.sendToShell({ type: 'demo-click-item', index: 0 });
      await G.wait(800);

      // Scroll down to reveal the Add to Order button
      G.chat?.sendToShell({ type: 'demo-scroll-bottom' });
      await G.wait(700);

      // Click Add to Order
      G.chat?.sendToShell({ type: 'demo-click-btn', text: 'Add to Order' });
      await G.wait(900);

      // Open the cart drawer so the prospect sees the live order they just built
      G.chat?.sendToShell({ type: 'demo-open-cart' });
      await G.wait(2500);

      // Close the cart and scroll back up so the avatar is visible while she
      // delivers the closing pitch.
      G.chat?.sendToShell({ type: 'demo-close-cart' });
      await G.wait(600);
      G.chat?.sendToShell({ type: 'demo-scroll-top' });
      await G.wait(700);

      // Closing sales pitch — single continuous monologue. The pay button
      // lives on the success card on this same page (no tab switch).
      await speak(`And just like that, your app is ready to start its twenty-four seven shift. As a founding member you lock in introductory pricing — three hundred and ninety-nine dollars to set it all up, plus one forty-nine a month, and that price stays with you forever. It's that simple — tap the button below to pay, and in seventy-two hours you'll have your fully customized twenty-four seven AI employee answering your guests.`);
    } finally {
      G._walkthroughActive = false;
    }
  }

  // ── Loading overlay with rotating copy ────────────────────────────────────
  const LOADING_LINES = [
    'Building your AI host…',
    'Training her on your menu…',
    'Are you ready for your new employee?',
    'You just made her — your AI host will be with you shortly…',
    'Wiring her up to your restaurant…',
    'Just a few more details…',
  ];
  let loadingTimer = null;
  function showLoadingOverlay() {
    const overlay = document.getElementById('hg-loading-overlay');
    if (!overlay) return;
    overlay.hidden = false;
    let i = 0;
    const textEl = document.getElementById('hg-loading-text');
    if (textEl) textEl.textContent = LOADING_LINES[0];
    clearInterval(loadingTimer);
    loadingTimer = setInterval(() => {
      i = (i + 1) % LOADING_LINES.length;
      if (!textEl) return;
      textEl.style.opacity = '0';
      setTimeout(() => {
        textEl.textContent = LOADING_LINES[i];
        textEl.style.opacity = '1';
      }, 280);
    }, 3500);
  }

  function hideLoadingOverlay() {
    clearInterval(loadingTimer);
    const overlay = document.getElementById('hg-loading-overlay');
    if (overlay) {
      overlay.style.transition = 'opacity 0.4s ease';
      overlay.style.opacity = '0';
      setTimeout(() => { overlay.hidden = true; overlay.style.opacity = ''; overlay.style.transition = ''; }, 420);
    }
  }

  function showSuccessState(previewUrl, restaurantName) {
    clearInterval(_keepAliveTimer);
    _keepAliveTimer = null;
    // Update shell caption
    const caption = document.querySelector('.shell-caption');
    if (caption) caption.textContent = `↑ ${restaurantName || 'your AI host'} — live preview`;

    // Wire the preview link
    const link = document.getElementById('success-preview-link');
    if (link && previewUrl) link.href = previewUrl;

    // Wire the "Back to demo" button — scrolls the iframe into view so the
    // prospect can interact with their built menu before paying.
    const backBtn = document.getElementById('success-back-to-demo');
    if (backBtn && !backBtn._wired) {
      backBtn._wired = true;
      backBtn.addEventListener('click', () => {
        const shell = document.getElementById('hg-right') || document.querySelector('.shell-wrap');
        if (shell) shell.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    // Wire the founders-pricing checkout button → Stripe Checkout via the worker
    const checkoutBtn = document.getElementById('success-checkout-btn');
    if (checkoutBtn && !checkoutBtn._wired) {
      checkoutBtn._wired = true;
      checkoutBtn.addEventListener('click', async () => {
        const original = checkoutBtn.textContent;
        checkoutBtn.disabled = true;
        checkoutBtn.textContent = 'Opening checkout…';
        try {
          const rec = G.session?.record || {};
          const r = await fetch('https://aihostgen-checkout-worker.littf02.workers.dev/create-checkout-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: rec.prospect_email || '',
              businessName: rec.business_name || restaurantName || '',
              successUrl: location.origin + '/?paid=1',
              cancelUrl:  location.origin + '/?canceled=1',
            }),
          });
          const data = await r.json();
          if (data.url) {
            window.location.href = data.url;
          } else {
            console.warn('[voice] checkout error:', data);
            checkoutBtn.disabled = false;
            checkoutBtn.textContent = original;
            setHint('Checkout error — try again or contact support.');
          }
        } catch (e) {
          console.warn('[voice] checkout fetch failed:', e?.message);
          checkoutBtn.disabled = false;
          checkoutBtn.textContent = original;
        }
      });
    }

    // Hide the form rows and input area, show success card
    document.getElementById('hg-form').style.display = 'none';
    document.getElementById('hg-input-area').style.display = 'none';
    document.getElementById('hg-success').hidden = false;
    setBtn('done');
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────
  function setBtn(state) {
    if (!elBtn) return;
    elBtn.dataset.state = state;
    elBtn.classList.toggle('listening', state === 'listening');
    elBtn.disabled = (state === 'done');
  }

  function setHint(text) {
    if (elHint) elHint.textContent = text;
  }

  // ── Typing fallback — works at any step, including menu ──────────────────
  async function submitTypedAnswer() {
    const input = document.getElementById('hg-typed-input');
    const text = input?.value?.trim();
    if (!text) return;
    if (input) input.value = '';

    // On menu step, route typed text through extractMenuFromText
    if (STEPS[stepIndex]?.key === 'menu') {
      hideMenuWidget();
      setHint('Organising your menu…');
      let items = [];
      try { items = await extractMenuFromText(text); } catch(e) { console.warn('[menu] text err:', e); }
      if (!items.length) {
        setFieldValue('menu', text);
        await G.session?.patch({ menu_source: 'text', menu_text: text });
        await speak('Got it. I\'ll build the full menu from those items.');
        await advanceFromMenu();
      } else {
        applyMenuItems(items);
        await G.session?.patch({ menu_source: 'text', menu_text: text, menu_items: JSON.stringify(items) });
        await speak(`I've got ${items.length} items. Check them over and hit Looks good when ready.`);
        await advanceFromMenu();
      }
      return;
    }

    handleAnswer(text, false);
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function initUI() {
    elBtn  = document.getElementById('hg-mic-btn');
    elHint = document.getElementById('hg-mic-hint');
    if (!elBtn) return;

    // Avatar panel — wire up Anna's idle loop + talk loop
    G.avatar?.init({
      idleSrc: 'assets/avi-anna-idle-3.mp4',
      talkLoopSrc: 'assets/avi-anna-idle-3.mp4',  // same loop used while TTS plays (renderer replaces this)
    });
    setAnnaStatus('Anna is ready', '');
    elBtn.addEventListener('click', () => {
      if (elBtn.dataset.state === 'listening') {
        stopListening();
        return;
      }
      if (elBtn.dataset.state === 'done') return;
      if (stepIndex < 0) return;

      // User tap = they want to speak NOW. Cancel any ongoing TTS immediately.
      if (_annaSpeaking) {
        window.speechSynthesis?.cancel();
        stopCurrentAudio();
        _annaSpeaking = false;
      }
      startListening();
    });

    const typedInput = document.getElementById('hg-typed-input');
    const typedSend  = document.getElementById('hg-typed-send');
    typedSend?.addEventListener('click', submitTypedAnswer);
    typedInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitTypedAnswer(); }
    });

    // Final review confirm button
    document.getElementById('hg-review-confirm')?.addEventListener('click', confirmAndBuild);

    // Clicking a form-row in review mode focuses its input for editing
    document.querySelectorAll('#hg-form .form-row').forEach((row) => {
      row.addEventListener('click', () => {
        if (!inReview) return;
        const input = row.querySelector('input.form-a');
        if (input) input.focus();
      });
    });

    initMenuWidget();
  }

  G.voice = {
    // Exposed so chat.js can restore the demo state on return-from-Stripe.
    applyMenuItems: applyMenuItems,
    showSuccessState: showSuccessState,
    start: async () => {
      stepIndex = 0;
      prospectName = '';
      restaurantName = '';
      pendingConfirm = false;
      confirmRejects = 0;
      lastAttempt = '';
      menuItems = [];
      // Clear the menu textarea from any previous session
      const menuEl = document.getElementById('field-menu');
      if (menuEl && menuEl.tagName === 'TEXTAREA') menuEl.value = '';
      hideMenuWidget();
      setBtn('idle');
      // Start Anna's idle loop — also force-play the background idle element
      G.avatar?.idle();
      const bgIdle = document.getElementById('avatar-idle');
      if (bgIdle) bgIdle.play().catch(() => {});
      // Keep Modal TTS container warm every 90s so it doesn't cold-start mid-conversation
      clearInterval(_keepAliveTimer);
      _keepAliveTimer = setInterval(() => {
        fetch(TTS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript: 'ok', speed: 0.75 }),
        }).catch(() => {});
      }, 90000);
      await askStep();
    },
    speak,
    stopListening,
    initUI,
    handleTyped: (text) => handleAnswer(text, false),
  };
})(window.AIHostGen);
