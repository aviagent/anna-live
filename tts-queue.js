// Audio queue with iOS-friendly AudioContext unlock.
// Direct port of anna-live.html:2252-2354 — same lifecycle, no Anna-specific bits.
(function (G) {
  let ctx = null;
  const queue = [];
  let playing = false;
  let onCompleteCb = null;

  function unlock() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx || ctx.state === 'closed') ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function enqueue(blob) {
    queue.push(blob);
    if (!playing) playNext();
  }

  function playNext() {
    if (!queue.length) {
      playing = false;
      G.avatar?.stopTalkLoop();
      if (onCompleteCb) { const cb = onCompleteCb; onCompleteCb = null; setTimeout(cb, 250); }
      return;
    }
    playing = true;
    const blob = queue.shift();
    const audio = unlock();
    if (audio) {
      blob.arrayBuffer()
        .then((buf) => audio.decodeAudioData(buf))
        .then((decoded) => {
          const src = audio.createBufferSource();
          src.buffer = decoded;
          src.connect(audio.destination);
          src.onended = () => playNext();
          src.start(0);
        })
        .catch((e) => { console.warn('[tts] decode failed:', e); playNext(); });
    } else {
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.onended  = () => { URL.revokeObjectURL(url); playNext(); };
      a.onerror  = () => { URL.revokeObjectURL(url); playNext(); };
      a.play().catch(() => playNext());
    }
  }

  // High-level API — `speak(text)` calls /tts on the Worker, plays through queue.
  async function speak(text, { onComplete } = {}) {
    if (!text) return;
    const apiBase = G.AIHostGenConfig?.apiBase || window.AIHostGenConfig?.apiBase;
    // No worker configured → just no-op silently. Avoids spamming browser TTS
    // queues during local dev / headless preview.
    if (!apiBase) {
      if (onComplete) setTimeout(onComplete, 50);
      return;
    }
    // Skip TTS entirely on localhost dev — the Worker isn't deployed and
    // browser SpeechSynthesis can stall in headless preview.
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      if (onComplete) setTimeout(onComplete, 50);
      return;
    }
    G.avatar?.startTalkLoop();
    if (onComplete) onCompleteCb = onComplete;
    try {
      const r = await fetch(`${apiBase}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: text, voice: 'kita' }),
      });
      if (!r.ok) throw new Error(`tts ${r.status}`);
      const blob = await r.blob();
      enqueue(blob);
    } catch (e) {
      console.warn('[tts] worker error, falling back to browser SpeechSynthesis:', e.message);
      browserSpeak(text, onComplete);
    }
  }

  function browserSpeak(text, onComplete) {
    if (!window.speechSynthesis) {
      G.avatar?.stopTalkLoop();
      if (onComplete) setTimeout(onComplete, 200);
      return;
    }
    speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 0.97; utt.pitch = 1.0; utt.volume = 0.9;
    utt.onstart = () => G.avatar?.startTalkLoop();
    utt.onend   = () => { G.avatar?.stopTalkLoop(); if (onComplete) setTimeout(onComplete, 200); };
    utt.onerror = () => { G.avatar?.stopTalkLoop(); if (onComplete) setTimeout(onComplete, 200); };
    speechSynthesis.speak(utt);
  }

  G.tts = { unlock, speak, browserSpeak, enqueue };
})(window.AIHostGen);
