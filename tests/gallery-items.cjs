const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../gui_main.cpp'),'utf8');
const youtube=source.slice(source.indexOf('function getYouTubeThumbnailUrl'),source.indexOf('function previewBannerUrl'));
const gallery=source.slice(source.indexOf('function normalizeDuGalleryItems'),source.indexOf('function getDuLicenseKey'));
const sandbox={URL,Date,Set,Array,Number};vm.createContext(sandbox);vm.runInContext(youtube+'\n'+gallery,sandbox);
const future=(Math.floor(Date.now()/1000)+3600).toString(16);
const items=sandbox.normalizeDuGalleryItems([
 {id:'temp',url:'https://rr1---sn-test.googlevideo.com/videoplayback?expire=9999999999&mime=video%2Fmp4'},
 {id:'expired',url:'https://cdn.discordapp.com/attachments/a/b/c.gif?ex=1'},
 {id:'yt1',url:'https://youtu.be/EN79SfbcvIE?si=one'},
 {id:'yt2',url:'https://www.youtube.com/watch?v=EN79SfbcvIE&list=duplicate'},
 {id:'discord-valid',url:'https://cdn.discordapp.com/attachments/a/b/c.mp4?ex='+future}
]);
assert.deepEqual(Array.from(items,x=>x.id),['yt1','discord-valid']);
assert.equal(items[0].thumbnail,'https://i.ytimg.com/vi/EN79SfbcvIE/hqdefault.jpg');
assert.match(source,/item\.canEdit === true \?/);
console.log('PASS gallery: temporary links hidden, YouTube previews fixed and deduplicated, edit UI requires explicit ownership');
