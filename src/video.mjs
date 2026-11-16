// Sariq Coin v5 – video metadata, controlled Telegram channel import and local media handling.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const VIDEO_REWARD_COINS = 25;
export const VIDEO_REWARD_ENERGY = 10;
export const DAILY_VIDEO_REWARD_LIMIT = 5;
export const DIRECT_UPLOAD_MAX = 40 * 1024 * 1024;
export const TELEGRAM_DOWNLOAD_MAX = 20 * 1024 * 1024;

export function initVideoState(s) {
  s.videos ||= [];
  s.pendingVideos ||= [];
  s.events ||= [];
}
export function videoPublic(v){
  return {id:v.id,title:v.title,description:v.description||'',durationSeconds:v.durationSeconds,
    source:v.source,createdAt:v.createdAt,likes:v.likes||0,views:v.views||0,
    url:`/media/videos/${v.id}`};
}
export function isVideoId(id){return /^vid_[0-9a-f]{24}$/.test(id);}
export function newVideoId(){return `vid_${crypto.randomBytes(12).toString('hex')}`;}
export function safeTitle(value, max=90){
  const t=String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
  if(!t)throw Object.assign(new Error('Video nomini kiriting.'),{status:400});
  return t;
}
export function validDuration(value){
  const d=Number(value);
  if(!Number.isInteger(d)||d<5||d>120)throw Object.assign(new Error('Video davomiyligi 5–120 soniya oralig‘ida bo‘lsin.'),{status:400});
  return d;
}
export function inspectVideo(bytes, expected='') {
  if(bytes.length<16)throw Error('Video fayl yaroqsiz.');
  if(bytes.toString('ascii',4,8)==='ftyp' && (!expected||expected==='video/mp4'))return {ext:'.mp4',mime:'video/mp4'};
  if(bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3 && (!expected||expected==='video/webm'))return {ext:'.webm',mime:'video/webm'};
  throw Error('Faqat haqiqiy MP4 yoki WebM video fayllar qabul qilinadi.');
}
export function shuffledVideos(videos,userId,day){
  const seed=crypto.createHash('sha256').update(`${userId}|${day}`).digest('hex');
  return videos.filter(v=>v.published).sort((a,b)=>{
    const ha=crypto.createHash('sha256').update(`${seed}|${a.id}`).digest('hex');
    const hb=crypto.createHash('sha256').update(`${seed}|${b.id}`).digest('hex');
    return ha.localeCompare(hb);
  });
}
export function ensureViewer(u){
  u.likedVideos ||= [];
  u.savedVideos ||= [];
  u.videoRewards ||= [];
  u.totalVideoSeconds ||= 0;
  u.videoCoinsEarned ||= 0;
}
export async function saveUploadedVideo(req,mediaDir,{maxBytes=DIRECT_UPLOAD_MAX}={}){
  const parts=[];let length=0;
  for await (const chunk of req){length+=chunk.length;if(length>maxBytes)throw Object.assign(Error('Video hajmi limitdan oshdi.'),{status:413});parts.push(chunk);}
  const file=Buffer.concat(parts);let mime;
  try{mime=inspectVideo(file,String(req.headers['content-type']||'').split(';')[0]);}catch(e){throw Object.assign(e,{status:400});}
  await fs.mkdir(mediaDir,{recursive:true,mode:0o700});
  const fileName=`${crypto.randomUUID()}${mime.ext}`;
  await fs.writeFile(path.join(mediaDir,fileName),file,{flag:'wx',mode:0o600});
  return {fileName,size:file.length,mime:mime.mime};
}
export function channelMetadata(msg,configuredId){
  if(!configuredId || String(msg?.chat?.id)!==String(configuredId))return null;
  const obj=msg.video || (msg.document?.mime_type==='video/mp4'?msg.document:null);
  if(!obj?.file_id)return null;
  const fileSize=Number(obj.file_size||0);
  const status=fileSize>TELEGRAM_DOWNLOAD_MAX?'oversize':'pending';
  const title=safeTitle((msg.caption||'').replace(/^#SCVIDEO\s*/i,'').split('\n')[0]||`Kanal videosi ${msg.message_id}`);
  return {id:newVideoId(),channelId:String(msg.chat.id),messageId:msg.message_id,
    telegramFileId:obj.file_id,fileUniqueId:obj.file_unique_id||'',
    title,description:String(msg.caption||'').slice(0,240),durationSeconds:Number.isInteger(obj.duration)?Math.min(120,Math.max(5,obj.duration)):20,
    fileSize,status,createdAt:Date.now(),source:'telegram'};
}
export async function downloadTelegramVideo({token,meta,mediaDir}){
  if(!token)throw Error('Bot token sozlanmagan.');
  if(meta.fileSize>TELEGRAM_DOWNLOAD_MAX)throw Error('Telegram Bot API 20 MB dan katta videoni yuklab ololmaydi. Faylni admin paneldan yuklang.');
  const res=await fetch(`https://api.telegram.org/bot${token}/getFile`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file_id:meta.telegramFileId}),signal:AbortSignal.timeout(30000)});
  const json=await res.json();if(!json.ok||!json.result?.file_path)throw Error(json.description||'Telegram getFile xatosi.');
  if((json.result.file_size||0)>TELEGRAM_DOWNLOAD_MAX)throw Error('Telegram yuklab olish chegarasi 20 MB.');
  const filePath=json.result.file_path;
  if(!/^[a-zA-Z0-9_./-]+$/.test(filePath) || filePath.includes('..'))throw Error('Telegram file_path noto‘g‘ri.');
  const download=await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`,{signal:AbortSignal.timeout(60000)});
  if(!download.ok)throw Error('Telegramdan videoni olish imkoni bo‘lmadi.');
  const chunks=[];let length=0;
  for await(const chunk of download.body){length+=chunk.length;if(length>TELEGRAM_DOWNLOAD_MAX)throw Error('Telegram videosi 20 MB dan katta.');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  const v=inspectVideo(bytes,'video/mp4');
  await fs.mkdir(mediaDir,{recursive:true,mode:0o700});
  const fileName=`${crypto.randomUUID()}${v.ext}`;
  await fs.writeFile(path.join(mediaDir,fileName),bytes,{flag:'wx',mode:0o600});
  return {fileName,size:length,mime:v.mime};
}
