// Tiny shared helpers — no globals leaked except `AIHostGen`.
window.AIHostGen = window.AIHostGen || {};

(function (G) {
  G.$  = (sel, root = document) => root.querySelector(sel);
  G.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  G.el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  };

  G.wait = (ms) => new Promise((r) => setTimeout(r, ms));

  G.escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  G.uuid = () => (crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // Async event bus — modules emit/subscribe without import order.
  const subs = new Map();
  G.on  = (event, fn) => { (subs.get(event) ?? subs.set(event, new Set()).get(event)).add(fn); };
  G.off = (event, fn) => { subs.get(event)?.delete(fn); };
  G.emit = async (event, payload) => {
    const fns = subs.get(event);
    if (!fns) return;
    for (const fn of fns) {
      try { await fn(payload); } catch (e) { console.warn(`[bus] ${event} handler failed:`, e); }
    }
  };
})(window.AIHostGen);
