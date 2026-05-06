// Avatar clip manifest. Replace R2 URLs once the clips are recorded + uploaded.
// Until then `placeholder` clips fall through to the avatar's "no src" path,
// which produces a silent 2.4s pause so the conductor still advances.
(function (G) {
  const R2 = 'https://lead-demo.r2.cloudflarestorage.com'; // TODO: real R2 bucket URL
  const ph = ''; // empty src triggers avatar's onerror → 2.4s pause fallback

  G.clips = {
    'idle-loop':         { src: ph, transcript: '(silent breathing loop)' },
    'talk-loop-silent':  { src: ph, transcript: '(silent talking loop, used for streaming TTS)' },

    // Greet / framing
    'greet-1':           { src: ph, transcript: "Hey, I'm Kita. In about a minute I'll set up an AI host trained on your menu. Tap Start to begin." },
    'ack-name':          { src: ph, transcript: "Got it." },
    'react-name':        { src: ph, transcript: "Beautiful. Now let me read your menu." },

    // Menu ingest
    'ask-menu':          { src: ph, transcript: "Drop your menu — paste a link or upload a photo." },
    'react-menu':        { src: ph, transcript: "Reading your menu now." },
    'react-menu-image':  { src: ph, transcript: "Got it — I'll pull what I can from this." },

    // Generating + preview
    'generating-1':      { src: ph, transcript: "Pulling the highlights." },
    'generating-2':      { src: ph, transcript: "Recording your welcome line." },
    'generating-3':      { src: ph, transcript: "Drafting five sample answers." },
    'preview-intro':     { src: ph, transcript: "Here you go. This is your AI host — already trained on a piece of your menu." },
    'preview-samples':   { src: ph, transcript: "Tap any of these to hear how I'd answer a guest." },

    // Close
    'transition-pitch':  { src: ph, transcript: "What you just watched took 60 seconds." },
    'pitch-upgrade':     { src: ph, transcript: "Want me to do the full menu, your hours, your specials? Three ninety-nine sets it up." },
    'cta-close':         { src: ph, transcript: "Tap upgrade — I'll see you on the other side." },

    // Fallback
    'oops-fallback':     { src: ph, transcript: "I didn't catch that — tap the mic and try again." },
  };

  G.clipUrl = (id) => G.clips[id]?.src || '';
})(window.AIHostGen);
