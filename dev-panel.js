// Dev-only fake-LLM panel. Renders only when ?dev=1 (config sets aihostgen_dev).
// In the chat-driven world, the only useful dev affordances are: jump to a step,
// reset the session, and force-generate.
(function (G) {
  function init() {
    const enabled = G.AIHostGenConfig?.devEnabled;
    const toggle = G.$('#dev-toggle');
    const panel  = G.$('#dev-panel');
    if (!panel || !toggle) return;
    toggle.hidden = !enabled;
    panel.hidden = !enabled;

    toggle.addEventListener('click', () => { panel.hidden = !panel.hidden; });
    G.$('#dev-close')?.addEventListener('click', () => { panel.hidden = true; });

    G.$$('#dev-panel [data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        const arg  = btn.dataset.arg;
        if (tool === 'step')     return G.chat?.goToStep?.(parseInt(arg, 10) || 0);
        if (tool === 'reset')    return G.chat?.resetAll?.();
        if (tool === 'generate') return G.chat?.runGenerate?.();
      });
    });
  }
  G.devPanel = { init };
})(window.AIHostGen);
