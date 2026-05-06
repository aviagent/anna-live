(function (G) {
  G.AIHostGen = G.AIHostGen || G;

  let elInfo, elStart, elIframe;

  G.boot = async function boot() {
    elInfo   = G.$('#hg-info');
    elStart  = G.$('#start-btn');
    elIframe = G.$('#shell-iframe');
    initStartButton();
    initIframeBridge();
    G.voice?.initUI();
    G.devPanel?.init();
    try { await G.session?.bootstrap(); } catch {}

    // If the user is returning from Stripe Checkout (?canceled=1 or ?paid=1),
    // skip the form and jump straight to the success card with their built
    // demo + pay button still visible.
    try {
      const qs = new URLSearchParams(location.search);
      const returning = qs.get('canceled') === '1' || qs.get('paid') === '1';
      const rec = G.session?.record;
      if (returning && rec && rec.business_name) {
        // Hide the info card and reveal chat-side, then jump to success state.
        document.getElementById('hostgen')?.classList.add('started');
        if (elInfo) elInfo.hidden = true;
        const chatSide = document.getElementById('hg-chat-side');
        if (chatSide) chatSide.hidden = false;
        // Push their menu + brand back into the iframe so it shows their demo
        try {
          if (rec.menu_items) {
            const items = typeof rec.menu_items === 'string' ? JSON.parse(rec.menu_items) : rec.menu_items;
            G.voice?.applyMenuItems?.(items);
          }
          sendToShell({ type: 'set-brand', value: rec.business_name });
        } catch (e) { console.warn('[chat] restore demo failed:', e?.message); }
        // Show the success card (form hidden, pay button visible)
        const previewUrl = rec.preview_url || '#';
        G.voice?.showSuccessState?.(previewUrl, rec.business_name);
      }
    } catch (e) { console.warn('[chat] return-from-checkout init failed:', e?.message); }

    // Play the welcome Anna video on the landing page (autoplay blocked until gesture)
    const welcomeVid = G.$('#welcome-anna-video');
    if (welcomeVid) welcomeVid.play().catch(() => {});
    // Load all pre-baked prompt clips (greeting + the static step prompts).
    // Each was rendered once via the worker and ships in /assets so there's
    // zero Modal dependency on click. Step keys with dynamic text (those
    // that interpolate ${prospectName} / ${restaurantName}) are NOT baked —
    // they fall through to live TTS in voice.js.
    G.greetingClipBlob = null;
    G.greetingClipReady = false;
    G.greetingClipDuration = null;   // ms, probed from video metadata
    G.staticPromptClips = {};        // { stepKey: Blob }
    G.staticPromptDurations = {};    // { stepKey: ms }

    // Probe the actual playback duration from a blob by loading it into a
    // hidden <video> element. Much more accurate than blob-size heuristics.
    function probeClipDuration(blob) {
      return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const v = document.createElement('video');
        const done = (ms) => { try { URL.revokeObjectURL(url); } catch(_) {} resolve(ms); };
        v.onloadedmetadata = () => done(Math.round(v.duration * 1000));
        v.onerror = () => done(null);
        setTimeout(() => done(null), 4000);
        v.src = url;
      });
    }

    fetch('assets/greeting.mp4')
      .then((r) => r.ok ? r.blob() : null)
      .then((vidBlob) => {
        if (vidBlob) {
          G.greetingClipBlob = vidBlob;
          G.greetingClipReady = true;
          probeClipDuration(vidBlob).then((ms) => {
            if (ms) G.greetingClipDuration = ms;
            console.log('[chat] greeting clip ready, duration:', ms, 'ms');
          });
        }
      })
      .catch((e) => console.warn('[chat] greeting static-load failed:', e?.message));
    [
      ['prospect_email', 'assets/prompt-email.mp4'],
    ].forEach(([key, url]) => {
      fetch(url)
        .then((r) => r.ok ? r.blob() : null)
        .then((b) => {
          if (b) {
            G.staticPromptClips[key] = b;
            probeClipDuration(b).then((ms) => {
              if (ms) G.staticPromptDurations[key] = ms;
              console.log('[chat] static clip ready:', key, ms, 'ms');
            });
          }
        })
        .catch(() => {});
    });

    // Also warm Modal in the background so non-greeting utterances aren't
    // cold-started when the user reaches step 2.
    const lipUrl = window.AIHostGenConfig?.rendererUrl;
    fetch('https://anna-avatar-worker.littf02.workers.dev/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: 'warming up', speed: 0.75 }),
    })
      .then((r) => r.ok ? r.blob() : null)
      .then((audioBlob) => {
        if (audioBlob && lipUrl) {
          fetch(lipUrl + '/animate', {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav' },
            body: audioBlob,
          }).catch(() => {});
        }
      })
      .catch(() => {});
  };

  function initStartButton() {
    elStart?.addEventListener('click', async () => {
      // Switch the layout: info card (left) → chat-side (left), phone stays right
      document.getElementById('hostgen')?.classList.add('started');
      if (elInfo) {
        elInfo.style.transition = 'opacity 0.25s ease';
        elInfo.style.opacity = '0';
        setTimeout(() => { elInfo.hidden = true; elInfo.style.opacity = ''; }, 260);
      }
      // Reveal the chat-side column (form view + input area)
      const chatSide = document.getElementById('hg-chat-side');
      if (chatSide) chatSide.hidden = false;
      // Forward the user gesture into the iframe so its audio unlock fires —
      // parent clicks don't propagate into the iframe, and without this the
      // phone preview videos stay muted forever. Both paths fire to maximise
      // the chance the browser treats it as still-active user activation.
      try { elIframe?.contentWindow?.forceUnlock?.(); } catch {}
      sendToShell({ type: 'user-unlock' });
      // Tell the simpledemo to pause its welcome video before Anna speaks
      sendToShell({ type: 'hostgen-start' });

      // Dispatch the pre-rendered greeting clip RIGHT NOW — before the mic
      // prompt — so Anna starts talking the instant the user clicks. The
      // mic permission dialog runs in parallel below; she can speak through
      // the prompt. voice.start → askStep skips the first speak() so we
      // don't double-play.
      if (G.greetingClipReady && G.greetingClipBlob) {
        try {
          sendToShell({ type: 'anna-clip-blob', blob: G.greetingClipBlob, withAudio: true });
          G._greetingPlayed = true;
        } catch (_) {}
      }


      // Acquire and HOLD the mic stream from within the gesture.
      // Don't stop the tracks — voice.js picks this up as its working stream
      // so the MediaRecorder fallback never needs a second getUserMedia call
      // (which would be outside gesture context and fail on iOS).
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
      }).then((stream) => {
        G._heldMicStream = stream;
      }).catch((e) => console.warn('[chat] initial mic prompt failed:', e?.name || e));

      // Also pre-trigger SpeechRecognition permission in the gesture context.
      // iOS/mobile requires SR.start() to be called from a user gesture; starting
      // and immediately aborting here locks in the permission for the real calls.
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SR) {
        try {
          const prewarm = new SR();
          prewarm.start();
          setTimeout(() => { try { prewarm.abort(); } catch(_) {} }, 80);
        } catch(_) {}
      }

      // Start the conversation flow immediately. If the greeting was already
      // dispatched above, askStep will skip the first speak().
      G.voice?.start();
    });
  }

  // ── Iframe bridge ───────────────────────────────────────────────
  function initIframeBridge() {
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hostgen-ready') {
        // iframe ready — nothing to do here now
      } else if (msg.type === 'item-tapped') {
        // Block during the walkthrough — Anna is already narrating; the programmatic
        // iframe clicks fire item-tapped back which would cause a duplicate speak.
        if (G._walkthroughActive) return;
        // Only speak when the build is complete
        const successEl = document.getElementById('hg-success');
        if (!successEl || successEl.hidden) return;
        const { name, desc, price } = msg;
        if (!name || !G.voice) return;
        let spoken = name;
        if (desc) spoken += '. ' + desc;
        if (price && price > 0) {
          const priceStr = Number.isInteger(price) ? price : price.toFixed(2);
          spoken += ` It's $${priceStr}.`;
        }
        G.voice.speak(spoken);
      }
    });
  }

  function sendToShell(msg) {
    try { elIframe?.contentWindow?.postMessage(msg, '*'); }
    catch (e) { console.warn('[chat] postMessage failed:', e); }
  }

  G.chat = { sendToShell };
})(window.AIHostGen);
