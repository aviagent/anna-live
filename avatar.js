// Avatar playback — port of kitadesigns-site/learn.js:74-117.
// Two <video> elements: main (playClip) + talkLoop (silent overlay during streaming TTS).
(function (G) {
  const avatar = {
    frameEl: null,
    videoEl: null,
    talkLoopEl: null,
    captionEl: null,
    idleSrc: null,
    talkLoopSrc: null,

    init({ idleSrc, talkLoopSrc } = {}) {
      this.frameEl    = G.$('#avatar-frame');
      this.videoEl    = G.$('#avatar-video');
      this.talkLoopEl = G.$('#avatar-talkloop');
      this.captionEl  = G.$('#avatar-caption');
      this.idleSrc = idleSrc ?? null;
      this.talkLoopSrc = talkLoopSrc ?? null;
    },

    idle() {
      if (!this.videoEl || !this.idleSrc) return;
      this.frameEl?.classList.remove('speaking', 'tts-streaming');
      this.videoEl.src = this.idleSrc;
      this.videoEl.loop = true;
      this.videoEl.muted = true;
      this.videoEl.play().catch(() => { /* placeholder shown */ });
    },

    async playClip(src) {
      if (!this.videoEl || !src) return new Promise((r) => setTimeout(r, 1200));
      this.frameEl?.classList.add('speaking');
      this.frameEl?.classList.remove('tts-streaming');
      return new Promise((resolve) => {
        const video = this.videoEl;
        const finish = () => {
          video.removeEventListener('ended', onEnd);
          video.removeEventListener('error', onErr);
          this.frameEl?.classList.remove('speaking');
          this.idle();
          resolve();
        };
        const onEnd = () => finish();
        const onErr = () => {
          // Clip unavailable — fall back to a 2.4s pause so the conductor still advances.
          video.removeEventListener('ended', onEnd);
          video.removeEventListener('error', onErr);
          this.frameEl?.classList.remove('speaking');
          setTimeout(resolve, 2400);
        };
        video.addEventListener('ended', onEnd);
        video.addEventListener('error', onErr, { once: true });
        video.src = src;
        video.loop = false;
        video.muted = false;
        video.play().catch(onErr);
      });
    },

    // For streaming TTS: show silent talk-loop on top, audio plays via tts-queue.
    startTalkLoop() {
      if (!this.talkLoopEl || !this.talkLoopSrc) {
        // Without a video asset, fall back to the speaking glow ring.
        this.frameEl?.classList.add('speaking');
        return;
      }
      this.talkLoopEl.src = this.talkLoopSrc;
      this.talkLoopEl.loop = true;
      this.talkLoopEl.muted = true;
      this.talkLoopEl.play().catch(() => {});
      this.frameEl?.classList.add('tts-streaming', 'speaking');
    },
    stopTalkLoop() {
      this.talkLoopEl?.pause?.();
      this.frameEl?.classList.remove('tts-streaming', 'speaking');
    },

    setCaption(text) {
      if (!this.captionEl) return;
      if (!text) { this.captionEl.hidden = true; this.captionEl.textContent = ''; return; }
      this.captionEl.hidden = false;
      this.captionEl.textContent = text;
    },
  };

  G.avatar = avatar;
})(window.AIHostGen);
