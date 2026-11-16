import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {inspectVideo,channelMetadata,shuffledVideos} from '../src/video.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const listenPort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function startServer(fn){
 const tmp=await mkdtemp(path.join(os.tmpdir(),'sariq-video-v5-')),port=await listenPort();
 const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_FILE:path.join(tmp,'store.json'),VIDEO_MEDIA_DIR:path.join(tmp,'videos'),BOT_TOKEN:'',DEMO_MODE:'true',NODE_ENV:'development'},stdio:'pipe'});
 const base=`http://127.0.0.1:${port}`;
 try{
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(base+'/healthz')).ok){ready=true;break;}}catch{}await delay(80);}
  assert.ok(ready,'Video demo server did not start');await fn(base);
 }finally{child.kill();await rm(tmp,{force:true,recursive:true});}
}
async function apiClient(base,asAdmin){
 let cookie='';
 async function send(p,data,raw){const res=await fetch(base+p,{method:data===undefined?'GET':'POST',headers:{'x-sariq-client':'1',...(raw?{'content-type':'video/mp4'}:{'content-type':'application/json'}),...(cookie?{cookie}:{})},body:data===undefined?undefined:(raw?data:JSON.stringify(data))});
   const c=res.headers.get('set-cookie');if(c)cookie=c.split(';')[0];return {status:res.status,data:await res.json()};}
 const a=await send('/api/auth/demo',{asAdmin});assert.equal(a.status,200);
 return {send,get cookie(){return cookie}};
}
test('video metadata and shuffled feed are deterministic and channel scoped',()=>{
 const fake=Buffer.from('000000186674797069736f6d00000000','hex');
 assert.equal(inspectVideo(fake).mime,'video/mp4');
 assert.throws(()=>inspectVideo(Buffer.alloc(20)));
 const message={chat:{id:-1001234567890},message_id:77,video:{file_id:'mock',file_unique_id:'id1',file_size:10000,duration:13},caption:'#SCVIDEO Pizza yangi aksiyasi'};
 assert.equal(channelMetadata(message,'-1001234567890').title,'Pizza yangi aksiyasi');
 assert.equal(channelMetadata(message,'-100999'),null);
 const videos=Array.from({length:7},(_,i)=>({id:`v${i}`,published:true}));
 assert.deepEqual(shuffledVideos(videos,'55','2026-11-15').map(v=>v.id),shuffledVideos(videos,'55','2026-11-15').map(v=>v.id));
});
test('admin upload, publish, swipe feed API, watch-time and daily reward', {timeout:45000},async()=>{
 await startServer(async base=>{
  const user=await apiClient(base,false);const admin=await apiClient(base,true);
  let r=await user.send('/api/videos/feed');assert.equal(r.status,200);assert.equal(r.data.videos.length,1);
  const demo=r.data.videos[0],firstCoins=(await user.send('/api/me')).data.user.coins;
  r=await user.send('/api/admin/videos');assert.equal(r.status,403);
  r=await user.send('/api/admin/videos/upload?title=hacker&duration=12',Buffer.alloc(100),true);assert.equal(r.status,403);
  const videoBuffer=await readFile(path.join(root,'public','assets','demo-video.mp4'));
  r=await admin.send('/api/admin/videos/upload?title=Test+Shorts&duration=12',videoBuffer,true);assert.equal(r.status,201);
  let list=await admin.send('/api/admin/videos');assert.equal(list.status,200);
  const uploaded=list.data.videos.find(v=>v.title==='Test Shorts');assert.ok(uploaded);assert.equal(uploaded.published,false);
  r=await user.send('/api/videos/feed');assert.equal(r.data.videos.length,1,'unapproved video must not appear');
  r=await admin.send(`/api/admin/videos/${uploaded.id}/publish`,{});assert.equal(r.status,200);
  r=await user.send('/api/videos/feed');assert.equal(r.data.videos.length,2);
  const media=await fetch(base+`/media/videos/${uploaded.id}`,{headers:{cookie:user.cookie,range:'bytes=0-99'}});
  assert.equal(media.status,206);assert.equal((await media.arrayBuffer()).byteLength,100);
  r=await user.send(`/api/videos/${uploaded.id}/like`,{});assert.ok(r.status>=400,'like API endi yo‘q');
  // Test server-side wall-time accounting: we cannot claim a video immediately.
  r=await user.send(`/api/videos/${demo.id}/start`,{});assert.equal(r.status,200);
  const sessionId=r.data.sessionId;
  r=await user.send(`/api/videos/${demo.id}/complete`,{sessionId,currentTime:12});assert.equal(r.status,400);
  for(let sec=2;sec<=12;sec+=2){await delay(2050);r=await user.send(`/api/videos/${demo.id}/progress`,{sessionId,currentTime:sec,playing:true,rate:1});assert.equal(r.status,200);}
  r=await user.send(`/api/videos/${demo.id}/complete`,{sessionId,currentTime:12});assert.equal(r.status,200);assert.equal(r.data.earned,25);
  assert.equal(r.data.coins,firstCoins+25);assert.ok(r.data.totalWatchSeconds>=9);
  r=await user.send('/api/videos/feed');assert.equal(r.data.earnedToday,1);
  assert.equal(r.data.videos.find(x=>x.id===uploaded.id).liked,undefined);
  r=await admin.send(`/api/admin/videos/${uploaded.id}/hide`,{});assert.equal(r.status,200);
  r=await user.send('/api/videos/feed');assert.equal(r.data.videos.length,1);
 });
});
