import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
vi.mock('../src/realtime', () => ({publishRealtime:vi.fn(), openRealtimeConnection:vi.fn(), RealtimeHub:class {}}));
import worker from '../src/index';
import {licenseHash} from '../src/auth';
import {publishRealtime} from '../src/realtime';
import type {Env} from '../src/types';
const id='111111111111111111', other='222222222222222222', key='TEST-LICENSE-ONLY';
let db:DatabaseSync,env:Env;
class Statement {
  constructor(private sql:string, private args:any[]=[]){}
  bind(...args:any[]){return new Statement(this.sql,args);}
  async first(){return db.prepare(this.sql).get(...this.args) || null;}
  async all(){return {results:db.prepare(this.sql).all(...this.args)};}
  async run(){const result=db.prepare(this.sql).run(...this.args);return {success:true,meta:{changes:Number(result.changes)}};}
}
async function request(method:string,path:string,body?:Record<string,unknown>){
 return worker.fetch(new Request('https://test.local'+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env);
}
async function post(body:Record<string,unknown>,licenseKey=key){
 const response=await request('POST','/du-banner',{discordId:id,licenseKey,...body});
 expect(response.status).toBe(200);return response.json();
}
const row=()=>db.prepare('SELECT * FROM du_banners WHERE discord_id=?').get(id) as any;
beforeEach(async()=>{
 db=new DatabaseSync(':memory:');
 env={JWT_SECRET:'x'.repeat(40),IDENTIFIER_PEPPER:'y'.repeat(40),DB:{prepare:(sql:string)=>new Statement(sql),batch:async(statements:Statement[])=>{
   db.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}
 }}} as unknown as Env;
 db.exec('CREATE TABLE licenses(id TEXT,status TEXT,max_devices INTEGER,expires_at INTEGER,key_hash TEXT)');
 for(const k of [key,'OTHER-LICENSE-ONLY'])db.prepare('INSERT INTO licenses VALUES(?,?,?,NULL,?)').run(k,'active',5,await licenseHash(env,k));
 vi.clearAllMocks();
});
afterEach(()=>db.close());
describe('profile synchronization with actual SQLite statements',()=>{
 it('preserves unrelated media and shop fields, supports explicit clears and monotonically increasing revision',async()=>{
  await post({bannerUrl:'https://i.imgur.com/banner.gif',avatarUrl:'https://i.imgur.com/avatar.gif'});
  const before=row().updated_at;
  await post({customizations:{avatarDecoration:{asset:'a_test'},banner:{asset:'shop_banner'}},syncOnly:true});
  expect(row().banner_url).toBe('https://i.imgur.com/banner.gif');expect(row().avatar_url).toBe('https://i.imgur.com/avatar.gif');
  expect(JSON.parse(row().customization_json).banner.asset).toBe('shop_banner');expect(row().updated_at).toBeGreaterThan(before);
  await post({avatarUrl:''});expect(row().avatar_url).toBeNull();expect(JSON.parse(row().customization_json).avatarDecoration.asset).toBe('a_test');
  await post({customizations:{}});expect(row().customization_json).toBe('{}');expect(row().banner_url).toContain('banner.gif');
 });
 it('does not publish automatic uploads or duplicate normalized gallery URLs; isolates private catalogue',async()=>{
  await post({avatarUrl:'https://i.imgur.com/private.gif#first',shareWithCommunity:false});
  await post({avatarUrl:'https://i.imgur.com/private.gif#second',shareWithCommunity:false});
  await post({avatarUrl:'https://i.imgur.com/private.gif',syncOnly:true,customizations:{avatarDecoration:{asset:'new'}}});
  const entries=db.prepare('SELECT * FROM du_banner_gallery').all() as any[];
  expect(entries).toHaveLength(1);expect(entries[0].visibility).toBe('private');
  const publicGallery=await (await request('GET','/du-banner/gallery')).json() as any;
  expect(JSON.stringify(publicGallery)).not.toContain('private.gif');
  expect(await (await request('GET','/du-banner/css')).text()).not.toContain('private.gif');
  expect(JSON.stringify(await (await request('GET','/du-banner/'+id)).json())).not.toContain('private.gif');
 });
 it('rejects a different license without changing the existing row',async()=>{
  await post({bannerUrl:'https://i.imgur.com/original.gif'});const before=row();
  const res=await request('POST','/du-banner',{discordId:id,licenseKey:'OTHER-LICENSE-ONLY',avatarUrl:'https://i.imgur.com/other.gif'});
  expect(res.status).toBe(403);expect(row()).toEqual(before);
 });
 it('changing an owned gallery entry from public to private removes its public card',async()=>{
  await post({avatarUrl:'https://i.imgur.com/change.gif',shareWithCommunity:true});
  await post({avatarUrl:'https://i.imgur.com/change.gif',shareWithCommunity:false});
  const entries=db.prepare('SELECT visibility FROM du_banner_gallery').all() as any[];
  expect(entries.map(x=>x.visibility)).toEqual(['private']);
 });
 it('removing GIFs preserves shop visuals and notifies clients',async()=>{
  await post({avatarUrl:'https://i.imgur.com/avatar.gif',customizations:{avatarDecoration:{asset:'keep'}}});
  expect((await request('DELETE','/du-banner',{discordId:id,licenseKey:key})).status).toBe(200);
  expect(row().avatar_url).toBeNull();expect(JSON.parse(row().customization_json).avatarDecoration.asset).toBe('keep');
  expect(publishRealtime).toHaveBeenLastCalledWith(env,null,expect.objectContaining({type:'du_profile_changed',discordId:id}));
 });
 it('removes only the requested shop visual from the network list',async()=>{
  await post({customizations:{avatarDecoration:{asset:'one'}}});
  await post({discordId:other,customizations:{avatarDecoration:{asset:'two'}}});
  const get=async()=>await (await request('GET','/du-banner/customizations')).json() as any;
  expect((await get()).items.map((x:any)=>x.discordId).sort()).toEqual([id,other].sort());
  await post({customizations:{}});
  expect((await get()).items.map((x:any)=>x.discordId)).toEqual([other]);
 });
 it('rejects expired signed media and advertises the safe partial-sync protocol',async()=>{
  expect((await request('POST','/du-banner',{discordId:id,licenseKey:key,avatarUrl:'https://cdn.discordapp.com/attachments/a/b/x.gif?ex=1'})).status).toBe(400);
  expect((await request('POST','/du-banner',{discordId:id,licenseKey:key,avatarUrl:'https://rr1---sn-test.googlevideo.com/videoplayback?expire=9999999999&mime=video%2Fmp4'})).status).toBe(400);
  const capabilities=await (await request('GET','/du-banner/capabilities')).json() as any;
  expect(capabilities.profileSyncProtocol).toBe(2);
 });
 it('repairs the public gallery view without deleting legacy rows',async()=>{
  await post({avatarUrl:'https://youtu.be/EN79SfbcvIE?si=first',gifName:'Vídeo estável'});
  await post({avatarUrl:'https://www.youtube.com/watch?v=EN79SfbcvIE&list=duplicate',gifName:'Cópia antiga'});
  db.prepare("INSERT INTO du_banner_gallery(id,name,url,thumbnail,category,target,added_at,author_name,visibility) VALUES(?,?,?,?,?,'both',?,'Antigo','community')")
    .run('legacy-temp','Temporário','https://rr1---sn-test.googlevideo.com/videoplayback?expire=9999999999&mime=video%2Fmp4','', 'Comunidade',1);
  const gallery=await (await request('GET','/du-banner/gallery')).json() as any;
  expect(gallery.items).toHaveLength(1);
  expect(gallery.items[0].thumbnail).toBe('https://i.ytimg.com/vi/EN79SfbcvIE/hqdefault.jpg');
  expect((db.prepare('SELECT COUNT(*) AS count FROM du_banner_gallery').get() as any).count).toBe(2);
 });
 it('allows name editing only for the creating license and DCID',async()=>{
  await post({avatarUrl:'https://i.imgur.com/owned.gif',gifName:'Meu GIF'});
  const publicGallery=await (await request('GET','/du-banner/gallery')).json() as any;
  expect(publicGallery.items[0].canEdit).toBe(false);
  const owned=await (await request('POST','/du-banner/gallery',{discordId:id,licenseKey:key})).json() as any;
  expect(owned.items[0].canEdit).toBe(true);
  const wrong=await request('POST','/du-banner/gallery/rename',{id:owned.items[0].id,name:'Invasor',discordId:id,licenseKey:'OTHER-LICENSE-ONLY'});
  expect(wrong.status).toBe(403);
  const correct=await request('POST','/du-banner/gallery/rename',{id:owned.items[0].id,name:'Nome do dono',discordId:id,licenseKey:key});
  expect(correct.status).toBe(200);
 });
});
