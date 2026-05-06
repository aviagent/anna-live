// Gold cursor that animates to elements and "clicks" them.
// Direct port of kitadesigns-site/learn.js:119-151, restyled for Avi Agentics palette.
(function (G) {
  const cursor = {
    el: null,
    init() {
      if (this.el) return;
      const node = G.el('div', { class: 'kita-cursor', id: 'kita-cursor' });
      node.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M3 2 L3 18 L8 14 L11 21 L14 19.5 L11 12.5 L17 12 Z"
                fill="#d4aa50" stroke="#1a2744" stroke-width="1.2" stroke-linejoin="round"/>
        </svg>`;
      document.body.appendChild(node);
      this.el = node;
    },
    async moveTo(target, { hold = 200 } = {}) {
      if (!target || !this.el) return;
      const rect = (typeof target === 'string' ? G.$(target) : target)?.getBoundingClientRect?.();
      if (!rect) return;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      this.el.classList.add('visible');
      this.el.style.left = x + 'px';
      this.el.style.top  = y + 'px';
      await G.wait(720);
      if (hold) await G.wait(hold);
    },
    async click(target) {
      const node = typeof target === 'string' ? G.$(target) : target;
      if (!node) return;
      await this.moveTo(node, { hold: 80 });
      this.el.classList.add('clicking');
      try { node.click?.(); } catch {}
      await G.wait(450);
      this.el.classList.remove('clicking');
    },
    async flick() {
      if (!this.el) return;
      this.el.classList.add('clicking');
      await G.wait(450);
      this.el.classList.remove('clicking');
    },
    hide() { this.el?.classList.remove('visible'); },
  };
  G.cursor = cursor;
})(window.AIHostGen);
