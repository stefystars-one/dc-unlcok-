const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const renderer=['profile_renderer.js','voice_decoration_renderer.js'].map(name=>{
  const source=fs.readFileSync(path.join(root,name),'utf8');
  new vm.Script(source,{filename:name}); return source;
}).join('\n');
const target=path.join(root,'gui_main.cpp'),source=fs.readFileSync(target,'utf8');
const start=source.indexOf('const duProfileBannerJs = '),end=source.indexOf('function getThemePaths()',start);
if(start<0||end<0)throw new Error('Embedding markers missing');
const output=source.slice(0,start)+'const duProfileBannerJs = '+JSON.stringify(renderer)+';\n\n'+source.slice(end);
if(process.argv.includes('--check')){if(source!==output)throw new Error('Renderer embedding is stale');}
else if(source!==output)fs.writeFileSync(target,output);
for(const name of ['PLUGIN_JS','HOOK_JS']) {
 const a=output.indexOf('R"'+name+'('),b=output.indexOf(')'+name+'"',a);
 if(a<0||b<0)throw new Error('Missing '+name);
 new vm.Script(output.slice(a+name.length+3,b),{filename:name+'.js'});
}
const ui=output.slice(output.indexOf('R"raw_html(')+11,output.indexOf(')raw_html"'));
for(const match of ui.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1],{filename:'embedded-ui.js'});
console.log('PASS renderer embedding, plugin, hook and UI JavaScript syntax');
