const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const cpp = fs.readFileSync(path.join(root, 'gui_main.cpp'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8');

const realtime = cpp.slice(cpp.indexOf('function refreshNetworkVisualsFromServer()'), cpp.indexOf('function scheduleCloudRealtimeRetry()'));
assert.match(realtime, /sendToCpp\('refresh_network_visuals'\)/);
assert.doesNotMatch(realtime, /persistProfileBannerConfig|du_profile_banner/);
assert.match(cpp, /action == "refresh_network_visuals"/);
assert.match(cpp, /network_visual_refresh\.txt/);

const downloadComplete = cpp.slice(cpp.indexOf("message.type === 'theme_download_complete'"), cpp.indexOf("message.type === 'wallpaper_download_progress'"));
assert.doesNotMatch(downloadComplete, /cloneNode\s*\(/);
assert.match(cpp, /const identityKeys = theme =>/);
assert.match(cpp, /catalogThemeKeys/);
for (const source of [cpp, ui]) {
  assert.match(source, /class="theme-action-row"/);
  assert.match(source, /\.theme-action-row \.btn-apply-theme\s*\{[^}]*margin-top:\s*0/s);
}

const profileFile = fs.readFileSync(path.join(root, 'profile_renderer.js'), 'utf8');
const taggedProfileFile = cp.execFileSync('git', ['show', 'v10.9:profile_renderer.js'], {cwd: root, encoding: 'utf8'});
const normalized = value => value.replace(/\r\n/g, '\n');
const segment = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
assert.equal(normalized(segment(profileFile, 'function applyAvatar(', 'function bannerArea(')), normalized(segment(taggedProfileFile, 'function applyAvatar(', 'function bannerArea(')), 'local avatar layout must stay equal to v10.9');
assert.equal(normalized(segment(profileFile, 'function applyBanner(', 'function apply()')), normalized(segment(taggedProfileFile, 'function applyBanner(', 'function apply()')), 'local banner layout must stay equal to v10.9');
assert.match(profileFile, /function applyPublicBanner\(/);
assert.match(profileFile, /fetch\(API\+'\/du-banner\/'/);
assert.match(profileFile, /function discoverProfileRoots\(/);
assert.match(profileFile, /ver perfil completo\|view full profile/);
assert.match(profileFile, /const allRoots=discoverProfileRoots\(\)/);
assert.match(profileFile, /const publicCssPoll=setInterval/);
assert.match(profileFile, /_refreshNetworkCollectibles\?\.\(true\)/);
const rendererStart=cpp.indexOf('const duProfileBannerJs = '),rendererEnd=cpp.indexOf(';\n\nfunction getThemePaths',rendererStart);
const embeddedRenderer=JSON.parse(cpp.slice(rendererStart+'const duProfileBannerJs = '.length,rendererEnd));
const voiceFile=fs.readFileSync(path.join(root,'voice_decoration_renderer.js'),'utf8');
assert.equal(embeddedRenderer,profileFile+'\n'+voiceFile,'embedded renderers must match their source files');

const embeddedHtml = cpp.split('R"raw_html(')[1].split(')raw_html"')[0];
const scripts = [...embeddedHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
for (const script of scripts) new Function(script);
for (const match of ui.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) new Function(match[1]);

console.log('PASS regressions: no theme clone, aligned actions, read-only realtime refresh, v10.9 local layout preserved, public banner fallback embedded, UI syntax valid');
