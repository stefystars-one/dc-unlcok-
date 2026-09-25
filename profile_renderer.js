// Embedded into the Discord main-process hook by tools/sync_profile_renderer.cjs.
(() => {
  const VERSION = 'profile-dom-20260924-10';
  const incoming = window.__DU_PROFILE_BANNER_CONFIG || null;
  const previous = window.__duProfileBannerRuntime;
  if (previous?.version === VERSION) { previous.update(incoming); return; }
  if (previous?.dispose) previous.dispose();
  else if (previous?.update) previous.update({enabled:false,bannerUrl:'',url:'',avatarUrl:''});

  let config = incoming;
  let disposed = false;
  let pending = 0;
  let applying = false;
  let publicRequest = 0;
  const changes = new Map();
  const avatars = new Map();
  const banners = new Map();
  const ROOTS = '.user-profile-popout,.user-profile-modal,.user-profile-modal-v2,[class*="profileHeader_"],[class*="userProfileOuter_"],[class*="userProfileModal_"],[class*="userPopoutOuter_"],[class*="userPopout_"],[class*="accountProfileCard_"],[class*="profileCustomizationSection_"]';
  const MEDIA = '[data-du-profile-media]';
  const API = 'https://discord-unlock-api.st4rs.workers.dev';
  const numeric = (v, fallback, min, max) => Number.isFinite(Number(v)) && v !== undefined ? Math.min(max,Math.max(min,Number(v))) : fallback;
  const validUrl = value => { try { const u=new URL(String(value||'')); return ['https:','http:','data:','blob:'].includes(u.protocol) ? u.href : ''; } catch (_) { return ''; } };
  const videoUrl = value => { try { const u=new URL(String(value||'')); if(/\.(mp4|webm|m4v|mov)$/i.test(u.pathname)) return true; const mime=decodeURIComponent(u.searchParams.get('mime')||'').toLowerCase(); return /^video\/(mp4|webm|quicktime)$/i.test(mime)||(/(^|\.)googlevideo\.com$/i.test(u.hostname)&&/\/videoplayback$/i.test(u.pathname)&&(u.searchParams.has('itag')||u.searchParams.has('mime'))); } catch (_) { return false; } };
  // O player incorporado do YouTube exige uma identidade HTTP verificável e responde com erro 153 dentro do renderer do Discord. A capa oficial é estável e não executa scripts remotos.
  const youtubeThumbnailUrl = value => { try { const u=new URL(String(value||'')),h=u.hostname.toLowerCase(); let id=''; if((h==='youtube.com'||h==='www.youtube.com'||h==='m.youtube.com')&&u.pathname==='/watch') id=u.searchParams.get('v')||''; else if(h==='youtu.be') id=u.pathname.split('/').filter(Boolean)[0]||''; else if((h==='youtube.com'||h==='www.youtube.com')&&u.pathname.startsWith('/shorts/')) id=u.pathname.split('/').filter(Boolean)[1]||''; return /^[A-Za-z0-9_-]{11}$/.test(id) ? 'https://i.ytimg.com/vi/'+id+'/hqdefault.jpg' : ''; } catch (_) { return ''; } };
  function uid() {
    try { const id=window.BdApi?.Webpack?.getStore?.('UserStore')?.getCurrentUser?.()?.id; if (id) return String(id); } catch (_) {}
    const id=String(config?.duUserId||'');
    return /^\d{17,21}$/.test(id) ? id : '';
  }
  function set(el, property, value) {
    let saved=changes.get(el);
    if (!saved) { saved=new Map(); changes.set(el,saved); }
    if (!saved.has(property)) saved.set(property,[el.style.getPropertyValue(property),el.style.getPropertyPriority(property)]);
    if (el.style.getPropertyValue(property)!==value || el.style.getPropertyPriority(property)!=='important') el.style.setProperty(property,value,'important');
  }
  function restore(el) {
    const saved=changes.get(el);
    if (!saved) return;
    for (const [property,[value,priority]] of saved) {
      if (value) el.style.setProperty(property,value,priority); else el.style.removeProperty(property);
    }
    changes.delete(el);
  }
  function clearEntry(entry) {
    entry.media?.remove();
    if (entry.viewport) entry.viewport.remove();
    for (const node of entry.changed) restore(node);
    if (entry.synthetic) entry.host.remove();
  }
  function owned(root,id) {
    if (!id) return false;
    const explicit=root.getAttribute('data-user-id')||root.getAttribute('data-userid');
    if (explicit) return explicit===id;
    const first=root.querySelector('img[src*="/avatars/"]:not('+MEDIA+')');
    if (first) return first.getAttribute('src').includes('/avatars/'+id+'/');
    try {
      const key=Object.keys(root).find(k=>k.startsWith('__reactFiber$'));
      for (let fiber=root[key],i=0;fiber&&i<15;fiber=fiber.return,i++) {
        const user=fiber.memoizedProps?.user||fiber.memoizedProps?.currentUser;
        if (user?.id) return String(user.id)===id;
      }
    } catch (_) {}
    return root.matches('[class*="accountProfileCard_"],[class*="profileCustomizationSection_"]');
  }
  function pruneOwnPublicCss() {
    if (!config) return;
    const id=uid();
    if (!id) return;
    // The public stylesheet uses content:url(), which changes an image's intrinsic
    // aspect ratio. Local configuration is authoritative, including explicit removal.
    const style=document.getElementById('du-banner-css-inject');
    try {
      const sheet=style?.sheet;
      if (sheet) for (let i=sheet.cssRules.length-1;i>=0;i--) {
        if ((sheet.cssRules[i].selectorText||'').includes(id)) sheet.deleteRule(i);
      }
    } catch (_) {}
  }
  async function refreshPublicCss() {
    const request=++publicRequest;
    try {
      const response=await fetch(API+'/du-banner/css',{cache:'no-store'});
      if (!response.ok) return;
      const css=await response.text();
      if (disposed||request!==publicRequest) return;
      let style=document.getElementById('du-banner-css-inject');
      if (!style) { style=document.createElement('style'); style.id='du-banner-css-inject'; (document.head||document.documentElement).appendChild(style); }
      if (style.textContent!==css) style.textContent=css;
      pruneOwnPublicCss();
    } catch (_) {}
  }
  function syncLocalAvatarCss(id,url) {
    let style=document.getElementById('du-local-avatar-css');
    if (!id || !url) { style?.remove(); return; }
    if (!style) { style=document.createElement('style');style.id='du-local-avatar-css';(document.head||document.documentElement).appendChild(style); }
    // content:url() altera somente a pintura da imagem: sem nós novos e sem reflow nas DMs.
    const safe=String(url).replace(/"/g,'%22');
    const css='img[src*="/avatars/'+id+'/"],img[src*="/users/'+id+'/avatars/"]{content:url("'+safe+'")!important;object-fit:cover!important;}';
    if (style.textContent!==css) style.textContent=css;
  }  function mediaFor(entry,url) {
    if (entry.url===url && entry.media?.isConnected) return entry.media;
    entry.media?.remove();
    const youtube=youtubeThumbnailUrl(url);
    const video=videoUrl(url);
    const media=document.createElement(video?'video':'img');
    media.setAttribute('data-du-profile-media','1');
    media.setAttribute('referrerpolicy','no-referrer');
    media.setAttribute('aria-hidden','true');
    if (youtube) media.setAttribute('allow','autoplay; encrypted-media; picture-in-picture');
    else if (video) { media.autoplay=true;media.muted=true;media.loop=true;media.playsInline=true; }
    media.style.cssText='position:absolute!important;inset:0!important;display:block!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;margin:0!important;object-fit:cover!important;pointer-events:none!important;';
    media.src=youtube||url;
    (entry.viewport||entry.host).appendChild(media);
    entry.url=url;entry.media=media;
    if (video) media.play().catch(()=>{});
    return media;
  }
  function applyAvatar(native,url) {
    // Use the square HTML stack inside Discord's foreignObject. Its SVG mask
    // retains the status cutout; viewport measurements never use the GIF's ratio.
    const host=native.parentElement;
    if (!(host instanceof HTMLElement)) return;
    const rect=host.getBoundingClientRect();
    if (!rect.width||!rect.height) return;
    let entry=avatars.get(native);
    if (entry && entry.host!==host) { clearEntry(entry);avatars.delete(native);entry=null; }
    if (!entry) {
      const viewport=document.createElement('span');
      viewport.setAttribute('data-du-profile-avatar','1');
      viewport.style.cssText='position:absolute!important;left:0!important;top:0!important;display:block!important;overflow:hidden!important;border-radius:50%!important;pointer-events:none!important;z-index:1!important;';
      host.appendChild(viewport);
      entry={host,viewport,changed:[native,host]};avatars.set(native,entry);
    }
    if (getComputedStyle(host).position==='static') set(host,'position','relative');
    const side=Math.min(host.clientWidth||rect.width,host.clientHeight||rect.height);
    entry.viewport.style.setProperty('width',side+'px','important');
    entry.viewport.style.setProperty('height',side+'px','important');
    set(native,'opacity','0');
    set(native,'width','100%');set(native,'height','100%');set(native,'object-fit','cover');
    const x=numeric(config.avatarPosX,50,0,100),y=numeric(config.avatarPosY,50,0,100);
    const zoom=Math.max(numeric(config.avatarSize,72,40,220)/72,1);
    const media=mediaFor(entry,url);
    media.style.setProperty('opacity',String(numeric(config.avatarOpacity,100,0,100)/100),'important');
    // object-position moves the crop inside Discord's native circular mask.
    // This matches what X/Y mean in the editor and avoids drifting the whole
    // avatar away from the status cutout when the banner height changes.
    media.style.setProperty('object-position',x+'% '+y+'%','important');
    media.style.setProperty('transform','scale('+zoom+')','important');
    media.style.setProperty('transform-origin','center center','important');
  }
  function bannerArea(root) {
    const candidates=Array.from(root.querySelectorAll('div[class*="banner_"],div[class*="profileBanner"],div[class*="bannerWrapper_"],div[style*="background-image"]'))
      .filter(el=>{const r=el.getBoundingClientRect();return r.width>120&&r.height>35&&r.height<420&&!el.closest('[data-du-profile-avatar]');});
    // Prefer the native painted layer. Its CSS mask already cuts around the avatar.
    const painted=candidates.find(el=>el.style.backgroundImage && !el.closest('[data-du-profile-avatar]'));
    if (painted) {
      const parent=painted.parentElement;
      return {host:painted,sizing:parent&&/banner/.test(String(parent.className))?parent:painted};
    }
    const html=candidates.find(el=>el.getBoundingClientRect().width>120&&!el.closest('svg'));
    if (html) return {host:html,sizing:html};
    const svg=root.querySelector('svg[class*="bannerSVGWrapper"],svg[class*="banner_"]');
    if (svg) {
      const foreign=svg.querySelector('foreignObject');
      const htmlChild=foreign?.firstElementChild;
      if (htmlChild instanceof HTMLElement) return {host:htmlChild,sizing:svg};
    }
    // A known profile with no banner still gets a dedicated HTML area, never an
    // invalid DIV inserted directly into SVG or over the whole profile card.
    const inner=root.querySelector('[class*="inner_"],[class*="userProfileInner_"]')||root;
    let host=inner.querySelector(':scope > [data-du-profile-banner-fallback]');
    if (!host) { host=document.createElement('div');host.setAttribute('data-du-profile-banner-fallback','1');inner.prepend(host); }
    return {host,sizing:host,synthetic:true};
  }
  function rootFromAvatar(native) {
    for (let root=native.parentElement,depth=0;root&&depth<14;root=root.parentElement,depth++) {
      const r=root.getBoundingClientRect();
      if (r.width<120||r.width>900||r.height<100||r.height>950) continue;
      const banner=root.querySelector('div[class*="banner_"],div[class*="profileBanner"],div[class*="bannerWrapper_"],div[style*="background-image"]');
      if (banner&&banner!==native.parentElement&&!banner.contains(native)) return root;
    }
    return null;
  }
  function isAllowedOwnAvatar(native,id) {
    if (!(native instanceof HTMLImageElement) || native.matches(MEDIA) || native.closest(MEDIA)) return false;
    // Chat/DM history has virtualized avatar nodes. Replacing them causes a
    // layout pass while scrolling and can move a minimized Discord back up.
    if (native.closest('[class*="message_"],[class*="messageListItem_"],[class*="messagesWrapper_"],[class*="chatContent_"],[class*="privateChannels_"]')) return false;
    if (native.closest('[class*="panels_"]')) return true;
    const root=rootFromAvatar(native);
    return !!(root&&owned(root,id));
  }
  function applyBanner(root,url) {
    let entry=banners.get(root);
    if (entry && !entry.host.isConnected) { clearEntry(entry);banners.delete(root);entry=null; }
    if (!entry) { const info=bannerArea(root);entry={...info,changed:Array.from(new Set([info.host,info.sizing])),layout:[]};banners.set(root,entry); }
    const {host,sizing}=entry;
    // Discord positions the avatar/status with fixed top offsets, but the
    // banner cutout follows its height. Measure the native layout each time so
    // resizing neither leaves the avatar behind nor accumulates translation.
    for (const node of entry.layout) restore(node);
    entry.layout=[];
    restore(sizing);
    const originalHeight=sizing.getBoundingClientRect().height;
    const height=numeric(config.height,120,80,400);
    const delta=height-originalHeight;
    const anchors=[];
    const id=uid();
    for (const native of root.querySelectorAll('img[src*="/avatars/'+id+'/"],img[src*="/users/'+id+'/avatars/"]')) {
      if (native.matches(MEDIA)||host.contains(native)) continue;
      let anchor=null;
      for (let node=native.parentElement;node&&node!==root;node=node.parentElement) {
        if (node instanceof HTMLElement&&getComputedStyle(node).position==='absolute') anchor=node;
      }
      if (!anchor||anchors.some(a=>a.node===anchor)) continue;
      const parent=anchor.offsetParent;
      if (!(parent instanceof HTMLElement)||!parent.contains(sizing)) continue;
      const top=parseFloat(getComputedStyle(anchor).top);
      if (!Number.isFinite(top)) continue;
      anchors.push({node:anchor,parent,top,parentHeight:parent.getBoundingClientRect().height});
    }
    const layoutSet=(node,property,value)=>{
      if (!entry.layout.includes(node)) entry.layout.push(node);
      if (!entry.changed.includes(node)) entry.changed.push(node);
      set(node,property,value);
    };
    for (const anchor of anchors) {
      // Move the entire avatar (mask, status and decorations) and the nearby
      // status bubble, not the GIF inside the native avatar mask.
      for (const node of anchor.parent.querySelectorAll('*')) {
        if (!(node instanceof HTMLElement)||host.contains(node)||node===sizing||node.contains(sizing)) continue;
        if (node.offsetParent!==anchor.parent||getComputedStyle(node).position!=='absolute') continue;
        const top=parseFloat(getComputedStyle(node).top);
        if (Number.isFinite(top)&&top>=anchor.top-1) layoutSet(node,'top',(top+delta)+'px');
      }
      if (/profileHeader|header_/i.test(anchor.parent.className)) {
        layoutSet(anchor.parent,'height',Math.max(0,anchor.parentHeight+delta)+'px');
      }
    }
    if (getComputedStyle(host).position==='static') set(host,'position','relative');
    set(host,'overflow','hidden');
    set(host,'background-image','none');
    set(host,'background-color','transparent');
    set(sizing,'height',height+'px');
    if (host!==sizing) set(host,'height','100%');
    const media=mediaFor(entry,url);
    media.style.setProperty('opacity',String(numeric(config.opacity,85,0,100)/100),'important');
    media.style.setProperty('object-position','center '+numeric(config.posY,50,0,100)+'%','important');
  }
  function apply() {
    if (disposed||applying) return;
    applying=true;
    try {
      pruneOwnPublicCss();
      const id=uid();
      const avatarUrl=config?.enabled ? validUrl(config.avatarUrl) : '';
      const bannerUrl=config?.enabled ? validUrl(config.bannerUrl||config.url) : '';
      syncLocalAvatarCss(id,avatarUrl);
      const currentAvatars=new Set();
      const ownNativeAvatars=id
        ? Array.from(document.querySelectorAll('img[src*="/avatars/'+id+'/"],img[src*="/users/'+id+'/avatars/"]'))
            .filter(native=>isAllowedOwnAvatar(native,id))
        : [];
      if (avatarUrl) {
        ownNativeAvatars.forEach(native=>{
          if (native.matches(MEDIA)||native.closest(MEDIA)) return;
          currentAvatars.add(native);applyAvatar(native,avatarUrl);
        });
      }
      for (const [native,entry] of avatars) if (!currentAvatars.has(native)) {clearEntry(entry);avatars.delete(native);}
      const roots=Array.from(document.querySelectorAll(ROOTS)).filter(root=>owned(root,id));
      // Discord's full profile view uses unrelated generated class names. Derive
      // its root from the authenticated user's native avatar and nearby banner.
      for (const native of ownNativeAvatars) {
        const root=rootFromAvatar(native);
        if (root&&!roots.includes(root)) roots.push(root);
      }
      const currentBanners=new Set();
      if (bannerUrl) for (const root of roots) {
        if (roots.some(other=>other!==root&&root.contains(other))) continue;
        currentBanners.add(root);applyBanner(root,bannerUrl);
      }
      for (const [root,entry] of banners) if (!currentBanners.has(root)) {clearEntry(entry);banners.delete(root);}
    } catch (error) { console.error('[DiscordUnlock profile]',error); }
    finally {applying=false;}
  }
  function schedule() {
    if (disposed||pending) return;
    pending=setTimeout(()=>{pending=0;apply();},40);
  }
  const observer=new MutationObserver(records=>{
    if (records.some(record=>{
      const element=record.target instanceof Element ? record.target : record.target.parentElement;
      if (element?.closest(MEDIA+', [data-du-profile-avatar]')) return false;
      if (element?.closest('[class*="message_"],[class*="messageListItem_"],[class*="messagesWrapper_"]') && !element.closest(ROOTS+', [class*="panels_"]')) return false;
      if (record.type==='attributes') return true;
      return [...record.addedNodes,...record.removedNodes].some(node=>node.nodeType===1&&!node.matches?.(MEDIA+', [data-du-profile-avatar]'));
    })) schedule();
  });
  observer.observe(document.body||document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src','class']});
  const poll=setInterval(apply,1500);
  window.addEventListener('resize',schedule);
  window.__duProfileBannerRuntime={
    version:VERSION,
    update(next) {
      const previousNetworkRefresh=Number(config?.networkRefreshNonce||0);
      config=next&&typeof next==='object'?next:null;
      window.__DU_PROFILE_BANNER_CONFIG=config;
      try { if(config)localStorage.setItem('du_profile_banner',JSON.stringify(config));else localStorage.removeItem('du_profile_banner'); } catch (_) {}
      // A atualização chega pelo WebSocket autenticado do aplicativo. A única
      // busca pública acontece ao iniciar ou quando o servidor avisa uma troca.
      if (Number(config?.networkRefreshNonce||0)>previousNetworkRefresh) refreshPublicCss();
      apply();
      return {version:VERSION,avatars:avatars.size,banners:banners.size};
    },
    refreshPublicCss,
    diagnostics() {return {version:VERSION,userId:uid(),avatars:avatars.size,banners:banners.size,config};},
    dispose() {
      disposed=true;publicRequest++;observer.disconnect();clearTimeout(pending);clearInterval(poll);window.removeEventListener('resize',schedule);document.getElementById('du-local-avatar-css')?.remove();
      for(const entry of avatars.values())clearEntry(entry);
      for(const entry of banners.values())clearEntry(entry);
      for(const el of changes.keys())restore(el);
    }
  };
  apply();
  refreshPublicCss();
})();

