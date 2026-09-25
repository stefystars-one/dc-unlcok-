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
assert.equal(normalized(profileFile), normalized(taggedProfileFile), 'profile_renderer.js must stay text-equivalent to v10.9');
const rendererSegment = source => source.slice(source.indexOf('const duProfileBannerJs = '), source.indexOf('function getThemePaths', source.indexOf('const duProfileBannerJs = ')));
const taggedCpp = cp.execFileSync('git', ['show', 'v10.9:gui_main.cpp'], {cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
assert.equal(normalized(rendererSegment(cpp)), normalized(rendererSegment(taggedCpp)), 'embedded profile renderer must stay exactly as v10.9');

const embeddedHtml = cpp.split('R"raw_html(')[1].split(')raw_html"')[0];
const scripts = [...embeddedHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
for (const script of scripts) new Function(script);
for (const match of ui.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) new Function(match[1]);

console.log('PASS regressions: no theme clone, aligned actions, read-only realtime refresh, v10.9 profile renderer unchanged, UI syntax valid');
