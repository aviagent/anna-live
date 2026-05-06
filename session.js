// Session bootstrap. Generates anon session_id (localStorage), creates a
// PocketBase site_config record, and exposes session.record + session.id.
// If PB is unreachable, falls back to local-only mode so the demo still runs.
(function (G) {
  const KEY = 'aihostgen_session_v1';

  const session = {
    id: null,
    record: null,
    pbRecordId: null,
    pb: null,
    offline: false,

    defaults() {
      return {
        business_name: '',
        theme_color:   '#b8922a',
        secondary_color: '#1a2744',
        headline: '',
        host_intro: '',
        menu_source: '',
        menu_items: [],
        sample_responses: [],
        welcome_line: '',
        stage: 'boot',
        prospect_email: '',
      };
    },

    async bootstrap() {
      const stored = localStorage.getItem(KEY);
      const parsed = stored ? safeParse(stored) : null;
      this.id = parsed?.id || G.uuid();
      this.record = { ...this.defaults(), ...(parsed?.record || {}), session_id: this.id };

      try {
        if (typeof PocketBase === 'undefined') throw new Error('PocketBase SDK missing');
        this.pb = new PocketBase(G.AIHostGenConfig?.pbUrl || window.AIHostGenConfig?.pbUrl);
      } catch (e) {
        console.warn('[session] PB init failed, running offline:', e.message);
        this.offline = true;
        this._persistLocal();
        return this.record;
      }

      try {
        if (parsed?.pbRecordId) {
          this.pbRecordId = parsed.pbRecordId;
          // Verify it still exists; if not, recreate.
          await this.pb.collection(coll()).getOne(this.pbRecordId).catch(async () => {
            this.pbRecordId = null;
          });
        }
        if (!this.pbRecordId) {
          const created = await this.pb.collection(coll()).create({
            ...this.record,
            session_id: this.id,
          });
          this.pbRecordId = created.id;
          this.record = { ...this.record, ...created };
        }
        this._persistLocal();
        return this.record;
      } catch (e) {
        console.warn('[session] PB bootstrap failed, running offline:', e.message);
        this.offline = true;
        this._persistLocal();
        return this.record;
      }
    },

    async patch(partial) {
      this.record = { ...this.record, ...partial };
      this._persistLocal();
      // Always emit so UI updates work in offline mode too.
      G.emit('session:patch', { partial, record: this.record, source: this.offline ? 'local' : 'optimistic' });
      if (this.offline || !this.pbRecordId) return this.record;
      try {
        const updated = await this.pb.collection(coll()).update(this.pbRecordId, partial);
        this.record = { ...this.record, ...updated };
        this._persistLocal();
      } catch (e) {
        console.warn('[session] PB patch failed:', e.message);
      }
      return this.record;
    },

    async subscribe(cb) {
      if (this.offline || !this.pb || !this.pbRecordId) return () => {};
      try {
        return await this.pb.collection(coll()).subscribe(this.pbRecordId, (e) => {
          this.record = { ...this.record, ...e.record };
          this._persistLocal();
          cb?.(e.record, e.action);
        });
      } catch (e) {
        console.warn('[session] PB subscribe failed:', e.message);
        return () => {};
      }
    },

    async reset() {
      localStorage.removeItem(KEY);
      this.id = G.uuid();
      this.pbRecordId = null;
      this.record = { ...this.defaults(), session_id: this.id };
      G.emit('session:reset', { record: this.record });
      if (!this.offline && this.pb) {
        try {
          const created = await this.pb.collection(coll()).create({ ...this.record });
          this.pbRecordId = created.id;
        } catch (e) { console.warn('[session] reset create failed:', e.message); }
      }
      this._persistLocal();
      return this.record;
    },

    _persistLocal() {
      try {
        localStorage.setItem(KEY, JSON.stringify({
          id: this.id,
          pbRecordId: this.pbRecordId,
          record: this.record,
        }));
      } catch {}
    },
  };

  function coll() { return G.AIHostGenConfig?.pbCollection || window.AIHostGenConfig?.pbCollection || 'site_config'; }
  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

  G.session = session;
})(window.AIHostGen);
