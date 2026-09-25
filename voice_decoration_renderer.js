// Preview-only voice decoration fallback. Embedded beside the profile renderer.
(() => {
  const VERSION = 'voice-decoration-preview-1';
  if (window.__duVoiceDecorationRuntime?.version === VERSION) {
    window.__duVoiceDecorationRuntime.refresh(); return;
  }
  window.__duVoiceDecorationRuntime?.dispose?.();
  const ROOT = '[class*="callContainer_"],[class*="videoGrid_"]';
  const TILE = '[class*="tile_"],[class*="voiceUser_"],[class*="participant_"]';
  const AVATAR = '[class*="avatar_"],[class*="avatarWrapper_"]';
  const EXCLUDED = '[class*="message_"],[class*="messageListItem_"],[class*="messagesWrapper_"],[class*="embed"],[class*="streamPreview_"],[class*="videoFrame_"]';
  const entries = new Map(), observers = new Map();
  let disposed = false, timer = 0;
  const store = name => window.BdApi?.Webpack?.getStore?.(name);
  function identity(avatar, tile) {
    const channelId = store('SelectedChannelStore')?.getVoiceChannelId?.();
    if (!channelId) return '';
    for (let node = avatar; node && tile.contains(node); node = node.parentElement) {
      const key = Object.keys(node).find(k => k.startsWith('__reactFiber$'));
      for (let fiber = key && node[key], depth = 0; fiber && depth < 8; fiber = fiber.return, depth++) {
        const p = fiber.memoizedProps || {};
        const id = String(p.user?.id || p.participant?.user?.id || p.voiceState?.userId || p.userId || '');
        if (!/^\d{17,21}$/.test(id)) continue;
        const state = store('VoiceStateStore')?.getVoiceStateForUser?.(id);
        if (String(state?.channelId || state?.channel_id || '') === String(channelId)) return id;
        return '';
      }
      if (node === tile) break;
    }
    return '';
  }
  function remove(host, entry) {
    entry.overlay.remove();
    if (entry.positionChanged && host.style.getPropertyValue('position') === 'relative') {
      if (entry.position) host.style.setProperty('position', entry.position, entry.priority);
      else host.style.removeProperty('position');
    }
    entries.delete(host);
  }
  function refresh() {
    if (disposed) return;
    const active = new Set();
    const plugin = window.NitroStreamUnlockInstance;
    const enabled = window.__DU_PROFILE_BANNER_CONFIG?.voiceDecorationsPreview === true && plugin && !plugin._networkStopped;
    if (enabled) for (const root of document.querySelectorAll(ROOT)) {
      if (root.closest(EXCLUDED)) continue;
      for (const tile of root.querySelectorAll(TILE)) {
        if (tile.closest(EXCLUDED) || tile.querySelector('video')) continue;
        for (const avatar of tile.querySelectorAll(AVATAR)) {
          if (avatar.closest(EXCLUDED) || avatar.querySelector(AVATAR)) continue;
          const host = avatar instanceof HTMLImageElement ? avatar.parentElement : avatar;
          if (!(host instanceof HTMLElement) || host === tile || !tile.contains(host) || host.closest('svg')) continue;
          const rect = host.getBoundingClientRect(), ar = avatar.getBoundingClientRect();
          if (rect.width < 24 || rect.width > 256 || Math.abs(rect.width - rect.height) > 2 || Math.abs(rect.width - ar.width) > 2 || Math.abs(rect.height - ar.height) > 2) continue;
          const id = identity(avatar, tile);
          if (!id) continue;
          const visual = id === plugin._getCurrentUserId()
            ? (plugin._isShopUnlockEnabled() ? plugin._getAppliedCollectibles() : {})
            : plugin._networkCollectibles?.get(id);
          const asset = String(visual?.avatarDecoration?.asset || '');
          if (!/^[A-Za-z0-9_-]{1,160}$/.test(asset)) continue;
          if (host.querySelector('[class*="avatarDecoration_"],img[src*="avatar-decoration-presets/"]:not([data-du-voice-decoration])')) continue;
          active.add(host);
          let entry = entries.get(host);
          if (!entry) {
            const overlay = document.createElement('img');
            overlay.setAttribute('data-du-voice-decoration', '1'); overlay.setAttribute('aria-hidden', 'true');
            overlay.style.cssText = 'position:absolute!important;inset:0!important;width:100%!important;height:100%!important;object-fit:contain!important;pointer-events:none!important;z-index:2!important;';
            entry = {overlay, position:host.style.getPropertyValue('position'), priority:host.style.getPropertyPriority('position'), positionChanged:getComputedStyle(host).position === 'static'};
            if (entry.positionChanged) host.style.setProperty('position', 'relative');
            host.appendChild(overlay); entries.set(host, entry);
          }
          const src = 'https://cdn.discordapp.com/avatar-decoration-presets/' + asset + '.png?size=256&passthrough=true';
          if (entry.overlay.src !== src) entry.overlay.src = src;
        }
      }
    }
    for (const [host, entry] of entries) if (!active.has(host)) remove(host, entry);
    for (const [root, observer] of observers) if (!enabled || !root.isConnected) { observer.disconnect(); observers.delete(root); }
    if (enabled) for (const root of document.querySelectorAll(ROOT)) if (!observers.has(root)) {
      const observer = new MutationObserver(records => {
        if (records.some(r => !r.target.closest?.('[data-du-voice-decoration]') && (r.type === 'attributes' || [...r.addedNodes,...r.removedNodes].some(n => n.nodeType === 1 && !n.matches?.('[data-du-voice-decoration]'))))) schedule();
      });
      observer.observe(root, {subtree:true,childList:true,attributes:true,attributeFilter:['class','src']});
      observers.set(root, observer);
    }
  }
  function schedule() { if (!disposed && !timer) timer = setTimeout(() => { timer = 0; refresh(); }, 40); }
  const discovery = new MutationObserver(records => {
    if (records.some(r => [...r.addedNodes,...r.removedNodes].some(n => n.nodeType === 1 && (n.matches?.(ROOT) || n.querySelector?.(ROOT))))) schedule();
  });
  discovery.observe(document.body || document.documentElement, {subtree:true,childList:true});
  const voiceStore = store('VoiceStateStore');
  voiceStore?.addChangeListener?.(schedule);
  window.addEventListener('resize', schedule);
  window.__duVoiceDecorationRuntime = {
    version:VERSION, refresh, diagnostics:() => ({count:entries.size, roots:observers.size}),
    dispose() {
      disposed = true; clearTimeout(timer); discovery.disconnect();
      for (const observer of observers.values()) observer.disconnect();
      for (const [host, entry] of entries) remove(host, entry);
      voiceStore?.removeChangeListener?.(schedule); window.removeEventListener('resize', schedule);
      delete window.__duVoiceDecorationRuntime;
    }
  };
  refresh();
})();
