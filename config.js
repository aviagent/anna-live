// Runtime config for AI Host Gen.
// Each external resource is named so it doesn't collide with Stella's setup
// or any other live Avi Agentics project.
window.AIHostGen = window.AIHostGen || {};
window.AIHostGen.AIHostGenConfig = window.AIHostGenConfig = {

  // ── Backend API (Cloudflare Worker) ──────────────────────────────
  apiBase: 'https://api.aihostgen.aviagentics.com',

  // ── PocketBase ──────────────────────────────────────────────────
  // Same VPS PB instance as the rest of Avi Agentics, but a NEW
  // dedicated collection for AI Host Gen sessions so it does NOT
  // mix with Stella's data, the avatar lib, or anything else.
  pbUrl:        'http://155.138.149.147:8090',
  pbCollection: 'aihostgen_sessions',  // create this in PB admin

  // ── Cloudflare R2 (assets bucket) ───────────────────────────────
  // Dedicated to AI Host Gen — separate from Stella, anna-live, etc.
  r2PublicBase: 'https://pub-f322c4db10be4c209c8f415760b54cf2.r2.dev',
  r2Prefix:     '',

  // ── Fizzy-clover renderer (RunPod) ──────────────────────────────
  // Direct pod URL for live lipsync. Update when pod restarts.
  // Empty = audio-only fallback (no lipsync).
  rendererPodUrl: '',  // empty = audio-only; set to pod URL when pod is running

  rendererUrl: 'https://anna-avatar-worker.littf02.workers.dev',

  // ── Other ───────────────────────────────────────────────────────
  intakeFormUrl: 'https://aviagentics.com/intake-form.html',

  // Dev mode: only active when ?dev=1 is in the URL THIS visit.
  // No localStorage persistence — refresh without ?dev=1 disables it.
  devEnabled: (() => {
    try {
      // Clear any leftover persisted flag from older builds
      localStorage.removeItem('aihostgen_dev');
      const q = new URLSearchParams(location.search);
      return q.get('dev') === '1';
    } catch { return false; }
  })(),
};
