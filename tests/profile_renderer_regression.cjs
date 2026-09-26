// Run with PLAYWRIGHT_MODULE pointing at a Playwright installation when it is
// not on Node's module path. Exercises the modern Discord DOM without network.
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const own='906190137178873946',other='111111111111111111';
const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="160"><rect width="80" height="160" fill="purple"/></svg>');
const root=id=>`<div class="profile-view-unrecognized" data-fixture="${id}" style="width:300px"><div class="header__new"><div class="banner_f7e69e" style="height:105px"><div class="fill_f7e69e banner__68edb" style="height:100%;background-image:url(native.png)"></div></div><svg width="92" height="92"><foreignObject width="80" height="80"><div xmlns="http://www.w3.org/1999/xhtml" class="avatarStack__44b0c" style="width:80px;height:80px;display:grid"><img class="avatar__44b0c" src="https://cdn.discordapp.com/avatars/${id}/original.png" style="width:100%;height:100%"/></div></foreignObject></svg></div></div>`;
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage();
  await page.route('**/*',route=>route.abort());
  const serverView=`<section class="profileHeader__server" data-server-fixture style="width:900px;height:600px;background-image:url(server-wallpaper.png)"><div style="width:900px;height:200px;background-image:url(channel-banner.png)"></div><img src="https://cdn.discordapp.com/avatars/${own}/server.png" style="width:40px;height:40px"></section>`;
  await page.setContent(root(own)+root(other)+serverView);
  await page.evaluate(({own,image})=>{
    window.fetch=async()=>({ok:false});
    window.BdApi={Webpack:{getStore:()=>({getCurrentUser:()=>({id:own})})}};
    window.__DU_PROFILE_BANNER_CONFIG={enabled:true,duUserId:own,bannerUrl:image,avatarUrl:image,height:181,posY:75,avatarPosX:40,avatarPosY:62,avatarSize:69,opacity:100,avatarOpacity:100};
    const style=document.createElement('style');style.id='du-banner-css-inject';
    style.textContent='img[src*="/avatars/'+own+'/"]{content:url("'+image+'")!important}img[src*="/avatars/111111111111111111/"]{opacity:.8}';
    document.head.appendChild(style);
  },{own,image});
  await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../profile_renderer.js'),'utf8')});
  const result=await page.evaluate(({own,other})=>{
    const runtime=window.__duProfileBannerRuntime,original={...window.__DU_PROFILE_BANNER_CONFIG};
    const media=()=>document.querySelector('[data-du-profile-avatar] img');
    const first=media(),initial=runtime.diagnostics();
    const rect=media().parentElement.getBoundingClientRect();
    runtime.update({...original,avatarPosX:0,avatarPosY:100,avatarSize:108,posY:10});
    const pan={transform:media().style.transform,objectPosition:media().style.objectPosition,same:first===media()};
    const otherClean=!document.querySelector('[data-fixture="'+other+'"] [data-du-profile-media]');
    const serverClean=!document.querySelector('[data-server-fixture] [data-du-profile-media]');
    runtime.update({...original,bannerUrl:'',url:''});
    const avatarOnly=runtime.diagnostics();
    runtime.update({...original,avatarUrl:''});
    const bannerOnly=runtime.diagnostics();
    runtime.update({enabled:false,bannerUrl:'',avatarUrl:'',duUserId:own});
    const removed={media:document.querySelectorAll('[data-du-profile-media]').length,nativeHeight:document.querySelector('img[src*="/avatars/'+own+'/"]').getBoundingClientRect().height,bannerHeight:document.querySelector('.banner_f7e69e').style.height,cssRules:document.getElementById('du-banner-css-inject').sheet.cssRules.length};
    runtime.update(original);
    return {initial,rect:{width:rect.width,height:rect.height},pan,otherClean,serverClean,avatarOnly,bannerOnly,removed};
  },{own,other});
  assert.equal(result.initial.avatars,1);assert.equal(result.initial.banners,1);
  assert.deepEqual(result.rect,{width:80,height:80});
  assert.equal(result.pan.same,true);assert.equal(result.pan.transform,'translate(25%, -25%) scale(1.5)');assert.equal(result.pan.objectPosition,'0% 100%');
  assert.equal(result.otherClean,true);
  assert.equal(result.serverClean,true);
  assert.equal(result.avatarOnly.avatars,1);assert.equal(result.avatarOnly.banners,0);
  assert.equal(result.bannerOnly.avatars,0);assert.equal(result.bannerOnly.banners,1);
  assert.deepEqual(result.removed,{media:0,nativeHeight:80,bannerHeight:'105px',cssRules:1});
  await page.evaluate(()=>document.querySelector('[data-fixture="906190137178873946"]').remove());
  await page.waitForTimeout(100);
  await page.evaluate(html=>document.body.insertAdjacentHTML('beforeend',html),root(own));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-du-profile-avatar]').count(),1);
  assert.equal(await page.locator('[data-fixture="'+other+'"] [data-du-profile-media]').count(),0);
  // Discord profile v2: the native banner is 140px and the avatar is fixed at
  // top:80px. The previous implementation resized the cutout alone.
  await page.evaluate(({own})=>{
    window.__duProfileBannerRuntime.dispose();
    document.body.innerHTML=`<div class="user-profile-modal-v2" style="width:960px"><main style="width:400px"><div class="profileHeader__9c3be" style="position:relative;height:220px"><div class="profileHeaderBannerContainer__9c3be"><div class="banner_f7e69e" style="height:140px"><div class="fill_f7e69e banner__68edb" style="height:100%;background-image:url(native.png);--custom-cutout-y:100%"></div></div></div><div class="avatar__75742" style="position:absolute;top:80px;left:32px;width:120px;height:120px"><svg width="138" height="138"><foreignObject width="120" height="120"><div xmlns="http://www.w3.org/1999/xhtml" class="avatarStack__44b0c" style="width:120px;height:120px"><img src="https://cdn.discordapp.com/avatars/${own}/native.png" style="width:100%;height:100%"></div></foreignObject></svg></div><div class="container_ab8609" style="position:absolute;top:132px;left:172px;width:130px;height:36px">Status</div></div><div id="profileBody" style="height:100px">Profile</div></main></div>`;
    delete window.__duProfileBannerRuntime;
  },{own});
  await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../profile_renderer.js'),'utf8')});
  const positions=await page.evaluate(()=>{
    const runtime=window.__duProfileBannerRuntime,config={...window.__DU_PROFILE_BANNER_CONFIG};
    const results=[];
    for(const height of [107,208,80,400,208,107]){
      runtime.update({...config,height});
      const avatar=document.querySelector('.avatar__75742').getBoundingClientRect(),banner=document.querySelector('.banner_f7e69e').getBoundingClientRect();
      results.push({height,banners:runtime.diagnostics().banners,centerOffset:avatar.top+avatar.height/2-banner.bottom,avatarHeight:avatar.height,bubbleGap:document.querySelector('.container_ab8609').getBoundingClientRect().top-avatar.top,bodyGap:document.querySelector('#profileBody').getBoundingClientRect().top-avatar.bottom,media:document.querySelectorAll('.banner_f7e69e [data-du-profile-media]').length});
    }
    runtime.update({...config,bannerUrl:'',url:''});
    return {results,restored:{avatarTop:document.querySelector('.avatar__75742').style.top,bannerHeight:document.querySelector('.banner_f7e69e').style.height,headerHeight:document.querySelector('.profileHeader__9c3be').style.height,bubbleTop:document.querySelector('.container_ab8609').style.top}};
  });
  for(const position of positions.results){assert.equal(position.banners,1);assert.equal(position.media,1);assert.equal(position.centerOffset,0);assert.equal(position.avatarHeight,120);assert.equal(position.bubbleGap,52);assert.equal(position.bodyGap,20);}
  assert.deepEqual(positions.restored,{avatarTop:'80px',bannerHeight:'140px',headerHeight:'220px',bubbleTop:'132px'});
  await page.evaluate(image=>{
    window.__duProfileBannerRuntime.dispose();delete window.__duProfileBannerRuntime;
    const root=document.querySelector('.user-profile-modal-v2');root.className='user-profile-popout';root.style.width='300px';
    root.querySelector('main').style.width='300px';
    const header=root.querySelector('.profileHeader__9c3be');header.className='header__5be3e';header.style.height='152px';
    root.querySelector('.banner_f7e69e').style.height='105px';
    const avatar=root.querySelector('.avatar__75742');Object.assign(avatar.style,{top:'59px',left:'14px',width:'80px',height:'80px'});
    const svg=avatar.querySelector('svg');svg.setAttribute('width','92');svg.setAttribute('height','92');
    const foreign=avatar.querySelector('foreignObject');foreign.setAttribute('width','80');foreign.setAttribute('height','80');
    Object.assign(avatar.querySelector('.avatarStack__44b0c').style,{width:'80px',height:'80px'});
    root.querySelector('.container_ab8609').style.top='97px';
    window.__DU_PROFILE_BANNER_CONFIG={...window.__DU_PROFILE_BANNER_CONFIG,enabled:true,bannerUrl:image,avatarUrl:image};
  },image);
  await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../profile_renderer.js'),'utf8')});
  const small=await page.evaluate(()=>{
    const runtime=window.__duProfileBannerRuntime,config={...window.__DU_PROFILE_BANNER_CONFIG};
    return [107,208,80,400,107].map(height=>{
      runtime.update({...config,height});
      const a=document.querySelector('.avatar__75742').getBoundingClientRect(),b=document.querySelector('.banner_f7e69e').getBoundingClientRect();
      return {offset:a.top+a.height/2-b.bottom,side:a.width,height:a.height,bubbleGap:document.querySelector('.container_ab8609').getBoundingClientRect().top-a.top,bodyGap:document.querySelector('#profileBody').getBoundingClientRect().top-a.bottom};
    });
  });
  for(const position of small) assert.deepEqual(position,{offset:-6,side:80,height:80,bubbleGap:38,bodyGap:13});
  await page.evaluate(()=>window.__duProfileBannerRuntime.update({...window.__DU_PROFILE_BANNER_CONFIG,bannerUrl:'https://media.example.test/banner.m4v?download=1',avatarUrl:'https://media.example.test/avatar.m4v?download=1'}));
  assert.equal(await page.locator('[data-du-profile-avatar] video').count(),1);
  assert.equal(await page.locator('.banner_f7e69e [data-du-profile-media]').evaluate(el=>el.tagName),'VIDEO');
  await page.evaluate(()=>window.__duProfileBannerRuntime.update({...window.__DU_PROFILE_BANNER_CONFIG,bannerUrl:'https://www.youtube.com/watch?v=xzlmjn46_Ic',avatarUrl:'https://youtu.be/xzlmjn46_Ic'}));
  assert.equal(await page.locator('[data-du-profile-avatar] img').count(),1);
  const youtube=await page.locator('.banner_f7e69e [data-du-profile-media]').evaluate(el=>({tag:el.tagName,src:el.getAttribute('src')}));
  assert.equal(youtube.tag,'IMG');assert.match(youtube.src,/i\.ytimg\.com\/vi\/xzlmjn46_Ic\/hqdefault\.jpg/);
  console.log('PASS: profile rendering/removal/reopening and both native popout/v2 avatar-status alignment across repeated 80–400px banner resizing.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
