import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Store} from './src/store.mjs';
import {PRODUCTS,REWARDS,DAILY_BONUS,DEFAULT_SETTINGS,localDay,localMonth,regenerateEnergy,calculateDiscount,safeCustomer,REFERRER_BONUS,REFEREE_BONUS,REFERRAL_FIRST_ORDER_MIN,REFERRAL_MONTHLY_CAP,MAX_ORDER_SUBTOTAL} from './src/catalog.mjs';
import {verifyTelegramInitData,issueSession,readSession,isLocalRequest,checkSameOrigin} from './src/security.mjs';
import {startBot} from './src/bot.mjs';
import {initVideoState,videoPublic,shuffledVideos,ensureViewer,channelMetadata,downloadTelegramVideo,saveUploadedVideo,newVideoId,validDuration,safeTitle,VIDEO_REWARD_COINS,VIDEO_REWARD_ENERGY,DAILY_VIDEO_REWARD_LIMIT,DIRECT_UPLOAD_MAX} from './src/video.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
async function loadEnv(){try{const src=await fs.readFile(path.join(root,'.env'),'utf8');for(const line of src.split(/\r?\n/)){const m=/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);if(m && !process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');}}catch(e){if(e.code!=='ENOENT') throw e;}}
await loadEnv();
const config={
  host:process.env.HOST||'0.0.0.0',port:Number(process.env.PORT||8080),botToken:process.env.BOT_TOKEN||'',
  adminId:String(process.env.ADMIN_TELEGRAM_ID||'969070334'),adminUsername:process.env.ADMIN_USERNAME||'Normurodov_Diydor',
  miniAppUrl:process.env.MINI_APP_URL||'',isProduction:process.env.NODE_ENV==='production',demoRequested:process.env.DEMO_MODE==='true',
  sessionSecret:process.env.SESSION_SECRET||crypto.randomBytes(32).toString('hex'),botUsername:'',
  videoChannelId:process.env.VIDEO_CHANNEL_ID||'', videoChannelImport:process.env.VIDEO_CHANNEL_IMPORT==='true',
  frontendOrigins:new Set((process.env.FRONTEND_ORIGINS||'').split(',').map(origin=>origin.trim()).filter(Boolean).map(origin=>{
    let parsed;
    try{parsed=new URL(origin);}catch{throw Error('FRONTEND_ORIGINS ichida origin noto‘g‘ri.');}
    if(!['https:','http:'].includes(parsed.protocol)||parsed.origin!==origin)throw Error('FRONTEND_ORIGINS ichida faqat aniq HTTP(S) originlardan foydalaning.');
    return parsed.origin;
  }))
};
if(config.isProduction && (!process.env.SESSION_SECRET||process.env.SESSION_SECRET.length<32)) throw Error('Production uchun kamida 32 belgili SESSION_SECRET zarur.');
if(!Number.isInteger(config.port)||config.port<1||config.port>65535) throw Error('PORT noto‘g‘ri.');
const store=new Store(process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(root,'data','store.json'));
await store.init();
const mediaDir=process.env.VIDEO_MEDIA_DIR ? path.resolve(process.env.VIDEO_MEDIA_DIR) : path.join(root,'data','videos');
const videoSessions=new Map();
const BOOST_DURATION_MS=30*60*1000; // x2 Coin for 30 minutes; one physical tap still uses one energy and counts as one tap
// Demo placeholder is for localhost only; production contains only videos approved by an admin.
if(config.demoRequested&&!config.isProduction){
  await store.edit(s=>{initVideoState(s);if(!s.videos.length){s.videos.push({id:newVideoId(),title:'Sariq Bola Pizza • Demo video',description:'Sinov uchun qisqa animatsion video',durationSeconds:12,fileName:'demo-video.mp4',mime:'video/mp4',source:'demo',published:true,createdAt:Date.now(),likes:0,views:0});}});
}
config.onChannelPost=async msg=>{
  if(!config.videoChannelImport)return;
  if(!config.videoChannelId){console.log('[Sariq Coin] Video kanali chat ID:',msg?.chat?.id,'— VIDEO_CHANNEL_ID ga shu raqamni kiriting.');return;}
  let m;try{m=channelMetadata(msg,config.videoChannelId)}catch(e){console.warn('Kanal video metama’lumoti:',e.message);return;}
  if(!m)return;
  await store.edit(s=>{initVideoState(s);if(s.videos.some(v=>v.source==='telegram'&&v.channelId===m.channelId&&v.messageId===m.messageId))return;
    if(s.pendingVideos.some(v=>v.channelId===m.channelId&&v.messageId===m.messageId))return;
    s.pendingVideos.push(m);s.events.push({type:'video_channel_pending',id:m.id,at:Date.now()});});
};
const tapWindows=new Map();
const mime={'.mp4':'video/mp4','.webm':'video/webm','.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const reply=(res,status,data)=>{const output=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(output);};
const err=(msg,status=400)=>Object.assign(new Error(msg),{status});
async function body(req){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>64*1024)throw err('So‘rov hajmi juda katta.',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw err('JSON formati xato.');}}
const isDemoEnabled=req=>config.demoRequested&&!config.isProduction&&isLocalRequest(req);
const createCookie=(id,req,isDemo=false)=>`sariq_session=${issueSession({id},config.sessionSecret,isDemo)}; HttpOnly; SameSite=${config.isProduction?'None':'Strict'}; Path=/; Max-Age=604800${(config.isProduction||config.miniAppUrl.startsWith('https://'))?'; Secure':''}`;
// A purchased coupon code can be assigned to only one pending order at a time.
const findClaim=(s,id,code)=>s.claims.find(c=>c.userId===id && c.code===code && c.status==='active' && !c.orderId && c.expiresAt>Date.now());
const effectiveClaimStatus=(c,now)=>c.expiresAt<=now && c.status==='active'?'expired':c.status;
// Outstanding percent coupons reserve their maximum *possible* discount, not
// the legacy 5 000 so‘m cap. This also covers old coupons already issued before
// the upgrade. Once used, the reserved budget becomes the actual discount.
const budgetExposure=(c,now)=>{
  const status=effectiveClaimStatus(c,now);
  if(status==='used') return Math.max(0, Number(c.spentValue ?? c.reservedValue ?? 0));
  if(status==='active'||status==='reserved') {
    const currentReward=REWARDS.find(r=>r.id===c.rewardId);
    return Math.max(0,Number(c.reservedValue||0),Number(currentReward?.maxDiscount||0));
  }
  return 0;
};

// One authoritative pricing function for the live quote and the saved demo order.
// Product prices come from the trusted server catalog, never from the client.
function prepareOrderQuote(s,id,data){
  if(!['delivery','pickup'].includes(data.fulfillment))throw err('Yetkazish turi noto‘g‘ri.');
  if(!Array.isArray(data.items)||data.items.length<1||data.items.length>12)throw err('Savatcha bo‘sh yoki noto‘g‘ri.');
  const items=[];
  for(const item of data.items){
    const product=PRODUCTS.find(p=>p.id===item.productId),qty=Number(item.qty);
    if(!product||!Number.isInteger(qty)||qty<1||qty>10)throw err('Savatcha mahsuloti noto‘g‘ri.');
    items.push({productId:product.id,name:product.name,price:product.price,qty});
  }
  const subtotal=items.reduce((a,i)=>a+i.qty*i.price,0);
  if(subtotal>MAX_ORDER_SUBTOTAL)throw err('Demo buyurtma qiymati chegaradan oshdi.');
  const code=String(data.couponCode||'').trim().toUpperCase();
  let claim=null,discount=0;
  if(code){
    claim=findClaim(s,id,code);
    if(!claim)throw err('Kupon topilmadi, ishlatilgan yoki muddati tugagan.');
    const reward=REWARDS.find(r=>r.id===claim.rewardId);
    try{discount=calculateDiscount(reward,items,subtotal);}catch(e){throw err(e.message,400);}
  }
  return {items,subtotal,discount,total:subtotal-discount,couponCode:claim?.code||null,claim,purchaseCoinReward:items.reduce((sum,item)=>sum+item.qty,0)};
}


const publicSnapshot=(s,u,now)=>{
  regenerateEnergy(u,now,s.settings);
  const activeClaims=s.claims.filter(c=>c.userId===u.id).slice(-25).reverse().map(c=>({code:c.code,rewardId:c.rewardId,name:c.name,status:effectiveClaimStatus(c,now),expiresAt:c.expiresAt}));
  const orders=s.orders.filter(o=>o.userId===u.id).slice(-12).reverse().map(o=>({id:o.id,status:o.status,subtotal:o.subtotal,discount:o.discount,total:o.total,fulfillment:o.fulfillment,createdAt:o.createdAt,purchaseCoinReward:o.purchaseCoinReward||0,purchaseRewardGranted:o.purchaseRewardGranted===true}));
  return {user:safeCustomer(u),rules:s.settings,coupons:activeClaims,orders,canClaimDaily:u.dailyClaimedDay!==localDay(now),canBoost:u.boosterUsedDay!==localDay(now),serverTime:now,referralLink:config.botUsername?`https://t.me/${config.botUsername}?start=ref_${u.id}`:'',isAdmin:u.id===config.adminId};
};
const sumReserved=(s,now)=>s.claims.filter(c=>localMonth(c.createdAt)===localMonth(now)).reduce((t,c)=>t+budgetExposure(c,now),0);
function takeRate(id,count,now){
  const old=tapWindows.get(id)||{tokens:15,at:now};
  old.tokens=Math.min(15,old.tokens+Math.max(0,(now-old.at)/1000)*8);
  old.at=now;
  if(old.tokens<count){tapWindows.set(id,old);throw err('Juda tez bosilyapti. Biroz sekinroq bosing.',429);}
  old.tokens-=count;tapWindows.set(id,old);
  if(tapWindows.size>10000)tapWindows.clear();
}
async function route(req,res,url){
  const method=req.method||'GET'; const pathname=url.pathname;
  if(method==='GET' && pathname==='/api/config') return reply(res,200,{demoAvailable:isDemoEnabled(req),hasBot:!!config.botToken,adminUsername:config.adminUsername,botUsername:config.botUsername,products:PRODUCTS,rewards:REWARDS});
  if(method==='POST'&&pathname==='/api/auth/telegram'){
    if(!config.botToken)throw err('Bot token hali sozlanmagan.',503);
    const data=await body(req);
    let identity;
    try{identity=verifyTelegramInitData(data.initData,config.botToken);}catch(e){throw err(e.message,401);}
    await store.edit(s=>store.ensureUser(s,identity,Date.now(),false));
    res.setHeader('Set-Cookie',createCookie(identity.id,req));
    return reply(res,200,{ok:true,id:identity.id});
  }
  if(method==='POST'&&pathname==='/api/auth/demo'){
    if(!isDemoEnabled(req))throw err('Demo login faqat lokal kompyuterda ishlaydi.',403);
    const data=await body(req);
    const admin=data.asAdmin===true;
    const identity=admin?{id:config.adminId,name:'Demo administrator',username:config.adminUsername}:{id:'700000001',name:'Demo mijoz',username:'Demo_Customer'};
    await store.edit(s=>store.ensureUser(s,identity,Date.now(),true));
    res.setHeader('Set-Cookie',createCookie(identity.id,req,true));
    return reply(res,200,{ok:true,id:identity.id});
  }
  if(method==='POST'&&pathname==='/api/auth/logout'){
    res.setHeader('Set-Cookie','sariq_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');return reply(res,200,{ok:true});
  }
  const session=readSession(req.headers.cookie,config.sessionSecret);
  if(!session)throw err('Avval Telegram Mini App orqali kiring.',401);
  if(session.demo&&!isDemoEnabled(req))throw err('Demo sessiya faqat lokal sinovda ishlaydi.',403);
  const id=session.id;
  if(!store.data.users[id])throw err('Foydalanuvchi topilmadi.',401);
  const admin=id===config.adminId;
  if(method==='GET'&&pathname==='/api/me')return reply(res,200,await store.edit(s=>publicSnapshot(s,s.users[id],Date.now())));

  if(method==='GET'&&pathname==='/api/videos/feed'){
    const s=store.data;const u=s.users[id];ensureViewer(u);
    const day=localDay();
    const earnedToday=u.videoRewards.filter(x=>x.day===day).length;
    const videos=shuffledVideos(s.videos||[],id,day).map(v=>({...videoPublic(v),rewardedToday:u.videoRewards.some(x=>x.day===day&&x.videoId===v.id)}));
    return reply(res,200,{videos,rewardCoins:VIDEO_REWARD_COINS,rewardEnergy:VIDEO_REWARD_ENERGY,dailyLimit:DAILY_VIDEO_REWARD_LIMIT,earnedToday,totalWatchSeconds:u.totalVideoSeconds||0,videoCoinsEarned:u.videoCoinsEarned||0});
  }
  const videoAction=/^\/api\/videos\/(vid_[a-f0-9]{24})\/(start|progress|complete)$/.exec(pathname);
  if(method==='POST'&&videoAction){
    const videoId=videoAction[1],action=videoAction[2];
    const video=store.data.videos?.find(v=>v.id===videoId&&v.published);
    if(!video)throw err('Video topilmadi.',404);
    const data=await body(req),now=Date.now();
    if(action==='start'){
      const sessionId=crypto.randomBytes(16).toString('hex');
      // One active video session per user; no reward for simultaneous background streams.
      videoSessions.set(id,{sessionId,videoId,startedAt:now,lastAt:now,lastPosition:0,seenSeconds:0});
      if(videoSessions.size>15000)videoSessions.clear();
      return reply(res,200,{sessionId,durationSeconds:video.durationSeconds});
    }
    const vSession=videoSessions.get(id);
    if(!vSession||vSession.videoId!==videoId||vSession.sessionId!==data.sessionId||now-vSession.startedAt>180000)throw err('Video sessiyasi eskirgan. Qayta oching.',409);
    if(action==='progress'){
      const t=Number(data.currentTime),playing=data.playing===true,rate=Number(data.rate||1);
      if(!Number.isFinite(t)||t<0||t>video.durationSeconds+2)throw err('Video vaqti xato.');
      const deltaTime=Math.max(0,(now-vSession.lastAt)/1000),deltaPlay=t-vSession.lastPosition;
      // Only forward, sequential playback within real elapsed wall time is counted. Browser signals can
      // still be forged: external ad network attestation is required before economic production use.
      let counted=0;
      if(playing&&rate>0&&rate<=1.15&&deltaTime<=15&&deltaPlay>0&&deltaPlay<=deltaTime+1.1){
        counted=Math.max(0,Math.min(deltaTime,deltaPlay,6,video.durationSeconds-vSession.seenSeconds));
      }
      vSession.lastAt=now;vSession.lastPosition=t;vSession.seenSeconds+=counted;
      if(counted>=0.25){await store.edit(s=>{ensureViewer(s.users[id]);s.users[id].totalVideoSeconds=Math.round((s.users[id].totalVideoSeconds+counted)*100)/100;});}
      return reply(res,200,{watchedSeconds:Math.floor(vSession.seenSeconds),requiredSeconds:Math.ceil(video.durationSeconds*0.8),totalWatchSeconds:Math.floor(store.data.users[id].totalVideoSeconds||0)});
    }
    if(action==='complete'){
      const endTime=Number(data.currentTime);
      if(!Number.isFinite(endTime)||endTime<video.durationSeconds-1.5)throw err('Video oxirigacha ko‘rilmagan.');
      const required=Math.max(4,video.durationSeconds*.8);
      if(vSession.seenSeconds+0.25<required||now-vSession.startedAt<required*1000)throw err('Mukofot uchun videoni yetarli vaqt davomida ko‘rish kerak.');
      videoSessions.delete(id);
      const result=await store.edit(s=>{const u=s.users[id];ensureViewer(u);const v=s.videos.find(x=>x.id===videoId&&x.published);
        if(!v)throw err('Video endi faol emas.',404);
        const day=localDay(now);const already=u.videoRewards.some(x=>x.day===day&&x.videoId===videoId);
        const used=u.videoRewards.filter(x=>x.day===day).length;
        v.views=(v.views||0)+1;
        if(already||used>=DAILY_VIDEO_REWARD_LIMIT)return {earned:0,energyEarned:0,reason:already?'Bu video uchun bugun mukofot olingan.':'Bugungi video mukofot limiti tugagan.',coins:u.coins,energy:Math.floor(u.energy),totalWatchSeconds:Math.floor(u.totalVideoSeconds),views:v.views};
        regenerateEnergy(u,now,s.settings);
        const before=u.energy;
        u.energy=Math.min(s.settings.energyMax,u.energy+VIDEO_REWARD_ENERGY);
        u.coins+=VIDEO_REWARD_COINS;u.videoCoinsEarned+=VIDEO_REWARD_COINS;
        u.videoRewards.push({day,videoId,at:now});
        u.videoRewards=u.videoRewards.filter(x=>x.day>=localDay(now-7*86400000));
        s.events.push({type:'video_reward',userId:id,videoId,earned:VIDEO_REWARD_COINS,at:now});
        return {earned:VIDEO_REWARD_COINS,energyEarned:Math.floor(u.energy-before),coins:u.coins,energy:Math.floor(u.energy),totalWatchSeconds:Math.floor(u.totalVideoSeconds),views:v.views};
      });return reply(res,200,result);
    }
  }
  if(method==='POST'&&pathname==='/api/game/select'){
    const data=await body(req);if(!PRODUCTS.some(p=>p.id===data.productId))throw err('Mahsulot noto‘g‘ri.');
    const result=await store.edit(s=>{s.users[id].selectedProduct=data.productId;return {selectedProduct:data.productId};});return reply(res,200,result);
  }
  if(method==='POST'&&pathname==='/api/game/tap'){
    const data=await body(req),count=Number(data.count);
    if(!Number.isInteger(count)||count<1||count>10)throw err('Bir paketda 1 dan 10 tagacha bosish mumkin.');
    if(!PRODUCTS.some(p=>p.id===data.productId))throw err('Mahsulot noto‘g‘ri.');
    const now=Date.now();takeRate(id,count,now);
    const result=await store.edit(s=>{
      const u=s.users[id],rules=s.settings;regenerateEnergy(u,now,rules);
      const accepted=Math.max(0,Math.min(count,Math.floor(u.energy),rules.dailyTapLimit-u.dailyTaps));
      const multiplier=u.boosterUntil>now?2:1;
      const earned=accepted*multiplier;
      u.energy-=accepted;u.dailyTaps+=accepted;u.totalTaps+=accepted;u.coins+=earned;
      u.tapsByProduct[data.productId]=(u.tapsByProduct[data.productId]||0)+accepted;
      return {accepted,earned,coins:u.coins,energy:Math.floor(u.energy),dailyTaps:u.dailyTaps,multiplier};
    });return reply(res,200,result);
  }
  if(method==='POST'&&pathname==='/api/game/daily'){
    const result=await store.edit(s=>{const u=s.users[id];if(u.dailyClaimedDay===localDay())throw err('Bugungi bonus allaqachon olingan.');u.dailyClaimedDay=localDay();u.coins+=DAILY_BONUS;return {earned:DAILY_BONUS,coins:u.coins};});return reply(res,200,result);
  }
  if(method==='POST'&&pathname==='/api/game/boost'){
    const result=await store.edit(s=>{const u=s.users[id];if(u.boosterUsedDay===localDay())throw err('Bugungi x2 booster allaqachon ishlatilgan.');u.boosterUsedDay=localDay();u.boosterUntil=Date.now()+BOOST_DURATION_MS;return {boosterUntil:u.boosterUntil};});return reply(res,200,result);
  }
  if(method==='POST'&&pathname==='/api/coupons/redeem'){
    const data=await body(req);const reward=REWARDS.find(r=>r.id===data.rewardId);if(!reward)throw err('Mukofot topilmadi.');
    const now=Date.now();const result=await store.edit(s=>{
      const u=s.users[id];if(u.coins<reward.cost)throw err('Coin yetarli emas.');
      if(sumReserved(s,now)+reward.maxDiscount>s.settings.monthlyBudget)throw err('Oylik kupon byudjeti tugagan. Keyingi kampaniyani kuting.');
      const issued=s.claims.filter(c=>c.rewardId===reward.id&&localMonth(c.createdAt)===localMonth(now)&&budgetExposure(c,now)>0).length;
      if(issued>=reward.monthlyLimit)throw err('Bu mukofotning oylik limiti tugagan.');
      const code=`SC-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      const claim={code,rewardId:reward.id,name:reward.name,userId:id,status:'active',createdAt:now,expiresAt:now+30*86400000,reservedValue:reward.maxDiscount,orderId:null};
      s.claims.push(claim);u.coins-=reward.cost;s.events.push({type:'coupon_issued',userId:id,code,at:now});
      return {code,name:reward.name,coins:u.coins,expiresAt:claim.expiresAt};
    });return reply(res,200,result);
  }
  if(method==='POST'&&pathname==='/api/orders/quote'){
    // Read-only quote: does not reserve or consume the coupon.
    const data=await body(req);
    const {subtotal,discount,total,couponCode,purchaseCoinReward}=prepareOrderQuote(store.data,id,data);
    return reply(res,200,{subtotal,discount,total,couponCode,purchaseCoinReward});
  }
  if(method==='POST'&&pathname==='/api/orders'){
    const data=await body(req);
    const note=String(data.note||'').trim().slice(0,300);
    const result=await store.edit(s=>{
      // Recompute within the write transaction; the quote alone never authorizes a discount.
      const {items,subtotal,discount,total,couponCode,claim,purchaseCoinReward}=prepareOrderQuote(s,id,data);
      // Demo orders immediately credit +1 Coin per ordered item. In real mode,
      // rewards only credit after the restaurant administrator completes the order.
      const purchaseRewardGranted=Boolean(session.demo && isDemoEnabled(req));
      const order={id:`ORD-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,userId:id,items,subtotal,discount,total,fulfillment:data.fulfillment,note,couponCode,status:'placed',createdAt:Date.now(),completedAt:null,commission:0,source:'miniapp',purchaseCoinReward,purchaseRewardGranted};
      if(purchaseRewardGranted)s.users[id].coins+=purchaseCoinReward;
      s.orders.push(order);
      if(claim){claim.status='reserved';claim.orderId=order.id;claim.reservedValue=Math.max(Number(claim.reservedValue||0),Number(REWARDS.find(r=>r.id===claim.rewardId)?.maxDiscount||0));}
      s.events.push({type:'order_created',userId:id,orderId:order.id,at:Date.now(),purchaseCoinReward,purchaseRewardGranted});return {order};
    });return reply(res,200,result);
  }
  if(!admin)throw err('Administrator huquqi talab qilinadi.',403);
  if(method==='GET'&&pathname==='/api/admin/overview'){
    const s=store.data,now=Date.now();const completed=s.orders.filter(o=>o.status==='completed');
    const overview={adminId:config.adminId,adminUsername:config.adminUsername,settings:s.settings,
      stats:{users:Object.keys(s.users).length,totalTaps:Object.values(s.users).reduce((t,u)=>t+u.totalTaps,0),totalCoins:Object.values(s.users).reduce((t,u)=>t+u.coins,0),totalVideoSeconds:Math.floor(Object.values(s.users).reduce((t,u)=>t+(u.totalVideoSeconds||0),0)),videoRewards:Object.values(s.users).reduce((t,u)=>t+(u.videoRewards?.length||0),0),orders:s.orders.length,completedOrders:completed.length,revenue:completed.reduce((t,o)=>t+o.total,0),commission:completed.reduce((t,o)=>t+o.commission,0),issuedCoupons:s.claims.length,usedCoupons:s.claims.filter(c=>c.status==='used').length,monthlyReserved:sumReserved(s,now)},
      orders:s.orders.slice(-60).reverse(),claims:s.claims.slice(-80).reverse().map(c=>({...c,status:effectiveClaimStatus(c,now),owner:s.users[c.userId]?.name||c.userId})),users:Object.values(s.users).map(u=>({id:u.id,name:u.name,username:u.username,coins:u.coins,totalTaps:u.totalTaps,referralCount:u.referralCount})).sort((a,b)=>b.totalTaps-a.totalTaps).slice(0,50)};
    return reply(res,200,overview);
  }

  if(method==='GET'&&pathname==='/api/admin/videos'){
    const s=store.data;initVideoState(s);
    return reply(res,200,{videos:s.videos.map(v=>({...videoPublic(v),published:v.published,fileName:v.fileName,channelId:v.channelId||'',messageId:v.messageId||null})).reverse(),
      pending:s.pendingVideos.map(v=>({id:v.id,title:v.title,durationSeconds:v.durationSeconds,fileSize:v.fileSize,status:v.status,channelId:v.channelId,messageId:v.messageId})).reverse(),
      channelConfigured:!!config.videoChannelId,channelImportEnabled:config.videoChannelImport,directUploadMax:DIRECT_UPLOAD_MAX});
  }
  if(method==='POST'&&pathname==='/api/admin/videos/upload'){
    const title=safeTitle(url.searchParams.get('title')),durationSeconds=validDuration(url.searchParams.get('duration'));
    const description=String(url.searchParams.get('description')||'').trim().slice(0,240);
    if((store.data.videos||[]).length>=100)throw err('Demo videolar limiti: 100.',409);
    const upload=await saveUploadedVideo(req,mediaDir);
    const video={id:newVideoId(),title,description,durationSeconds,source:'admin_upload',published:false,
      fileName:upload.fileName,mime:upload.mime,size:upload.size,createdAt:Date.now(),likes:0,views:0};
    try{await store.edit(s=>{initVideoState(s);s.videos.push(video);s.events.push({type:'video_uploaded',videoId:video.id,adminId:id,at:Date.now()});});}
    catch(e){await fs.unlink(path.join(mediaDir,upload.fileName)).catch(()=>{});throw e;}
    return reply(res,201,{video:videoPublic(video),message:'Video yuklandi. Admin “Nashr etish” tugmasini bosgandan so‘ng ko‘rinadi.'});
  }
  const adminVideo=/^\/api\/admin\/videos\/(vid_[a-f0-9]{24})\/(publish|hide|approve|reject)$/.exec(pathname);
  if(method==='POST'&&adminVideo){
    const vid=adminVideo[1],action=adminVideo[2];
    if(action==='approve'){
      const entry=store.data.pendingVideos?.find(v=>v.id===vid);
      if(!entry)throw err('Tasdiqlanadigan kanal videosi topilmadi.',404);
      if(entry.status==='oversize')throw err('Kanal videosi 20 MB dan katta. Shu videoni kompyuterdan admin panelga yuklang.',413);
      const upload=await downloadTelegramVideo({token:config.botToken,meta:entry,mediaDir});
      const video={id:entry.id,title:entry.title,description:entry.description,durationSeconds:validDuration(entry.durationSeconds),
        source:'telegram',channelId:entry.channelId,messageId:entry.messageId,fileName:upload.fileName,mime:upload.mime,size:upload.size,
        published:true,createdAt:Date.now(),likes:0,views:0};
      try{await store.edit(s=>{initVideoState(s);if(!s.pendingVideos.some(x=>x.id===vid))throw err('Video allaqachon ko‘rib chiqilgan.',409);
        s.videos.push(video);s.pendingVideos=s.pendingVideos.filter(x=>x.id!==vid);s.events.push({type:'video_approved',videoId:vid,at:Date.now(),adminId:id});});}
      catch(e){await fs.unlink(path.join(mediaDir,upload.fileName)).catch(()=>{});throw e;}
      return reply(res,200,{ok:true});
    }
    const result=await store.edit(s=>{initVideoState(s);
      if(action==='reject'){
        if(!s.pendingVideos.some(v=>v.id===vid))throw err('Kutilayotgan video topilmadi.',404);
        s.pendingVideos=s.pendingVideos.filter(v=>v.id!==vid);
      }else{
        const v=s.videos.find(x=>x.id===vid);if(!v)throw err('Video topilmadi.',404);
        v.published=action==='publish';
      }
      s.events.push({type:`video_${action}`,adminId:id,videoId:vid,at:Date.now()});return {ok:true};});
    return reply(res,200,result);
  }
  if(method==='POST'&&pathname==='/api/admin/settings'){
    const data=await body(req);const rules={
      monthlyBudget:Number(data.monthlyBudget),commissionPercent:Number(data.commissionPercent),
      energyMax:Number(data.energyMax),regenSeconds:Number(data.regenSeconds),dailyTapLimit:Number(data.dailyTapLimit)};
    if(!Number.isInteger(rules.monthlyBudget)||rules.monthlyBudget<0||rules.monthlyBudget>1000000000)throw err('Byudjet 0 dan 1 mlrd gacha bo‘lishi kerak.');
    if(!Number.isFinite(rules.commissionPercent)||rules.commissionPercent<0||rules.commissionPercent>10)throw err('Komissiya 0–10% oralig‘ida.');
    if(!Number.isInteger(rules.energyMax)||rules.energyMax<100||rules.energyMax>1000)throw err('Energiya 100–1000 oralig‘ida.');
    if(!Number.isInteger(rules.regenSeconds)||rules.regenSeconds<10||rules.regenSeconds>600)throw err('Tiklanish 10–600 soniya.');
    if(!Number.isInteger(rules.dailyTapLimit)||rules.dailyTapLimit<100||rules.dailyTapLimit>3000)throw err('Kunlik limit 100–3000.');
    const result=await store.edit(s=>{s.settings=rules;s.events.push({type:'settings_changed',adminId:id,at:Date.now()});return s.settings;});return reply(res,200,{settings:result});
  }
  const orderMatch=/^\/api\/admin\/orders\/([^/]+)\/status$/.exec(pathname);
  if(method==='POST'&&orderMatch){const data=await body(req);if(!['completed','cancelled'].includes(data.status))throw err('Holat noto‘g‘ri.');
    const result=await store.edit(s=>{
      const order=s.orders.find(o=>o.id===orderMatch[1]);if(!order)throw err('Buyurtma topilmadi.',404);
      if(order.status!=='placed')throw err('Bu buyurtma avval qayta ishlangan.');
      order.status=data.status;
      const buyer=s.users[order.userId];
      if(data.status==='cancelled' && order.purchaseRewardGranted){
        // Reverse the provisional demo reward; any balance below zero remains an offset
        // against future earned Coins rather than letting a cancelled order mint coins.
        buyer.coins-=(order.purchaseCoinReward||0);
        order.purchaseRewardGranted=false;
        s.events.push({type:'order_coin_reversed',userId:buyer.id,orderId:order.id,coins:order.purchaseCoinReward||0,at:Date.now()});
      }
      if(order.couponCode){
        const claim=s.claims.find(c=>c.code===order.couponCode && c.orderId===order.id && c.status==='reserved');
        if(!claim)throw err('Kupon buyurtmaga biriktirilmagan yoki avval ishlatilgan.');
        if(data.status==='completed'){
          claim.status='used';claim.orderId=order.id;claim.usedAt=Date.now();claim.spentValue=order.discount;
        }else{
          // Cancellation does not consume a coupon: no fulfilled discount was granted.
          claim.status=claim.expiresAt>Date.now()?'active':'expired';claim.orderId=null;
          claim.usedAt=null;claim.spentValue=null;
        }
      }
      if(data.status==='completed'){
        order.completedAt=Date.now();order.commission=Math.round(order.total*s.settings.commissionPercent/100);
        if(!order.purchaseRewardGranted){
          order.purchaseCoinReward ??= order.items.reduce((sum,it)=>sum+it.qty,0);
          buyer.coins+=order.purchaseCoinReward;
          order.purchaseRewardGranted=true;
          s.events.push({type:'order_coin_earned',userId:buyer.id,orderId:order.id,coins:order.purchaseCoinReward,at:Date.now()});
        }
        const prior=s.orders.some(o=>o.userId===buyer.id&&o.id!==order.id&&o.status==='completed');
        if(!prior&&!buyer.firstOrderRewarded&&order.total>=REFERRAL_FIRST_ORDER_MIN && buyer.referrerId && s.users[buyer.referrerId]){
          const inviter=s.users[buyer.referrerId];const month=localMonth();const awards=s.events.filter(e=>e.type==='referral_paid'&&e.inviterId===inviter.id&&localMonth(e.at)===month).length;
          if(awards<REFERRAL_MONTHLY_CAP){inviter.coins+=REFERRER_BONUS;buyer.coins+=REFEREE_BONUS;inviter.referralBonusCount=(inviter.referralBonusCount||0)+1;s.events.push({type:'referral_paid',inviterId:inviter.id,userId:buyer.id,at:Date.now()});}
          buyer.firstOrderRewarded=true;
        }
      }
      s.events.push({type:'order_status',orderId:order.id,status:data.status,adminId:id,at:Date.now()});return order;
    });return reply(res,200,{order:result});
  }
  if(method==='POST'&&pathname==='/api/admin/coupons/use'){
    const data=await body(req),code=String(data.code||'').trim().toUpperCase(),subtotal=Number(data.subtotal);
    if(!Number.isInteger(subtotal)||subtotal<0||subtotal>MAX_ORDER_SUBTOTAL)throw err('Mahsulot summasi noto‘g‘ri.');
    const result=await store.edit(s=>{
      const claim=s.claims.find(c=>c.code===code&&c.status==='active'&&c.expiresAt>Date.now());if(!claim)throw err('Kupon noto‘g‘ri, ishlatilgan yoki muddati tugagan.');
      const reward=REWARDS.find(r=>r.id===claim.rewardId);
      if(reward.type==='free_item')throw err('Bepul mahsulot kuponini onlayn demo buyurtmada tekshiring.');
      const discount=calculateDiscount(reward,[],subtotal),total=subtotal-discount;
      const order={id:`POS-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,userId:claim.userId,items:[],subtotal,discount,total,fulfillment:'in_store',note:'Kassir tomonidan demo ro‘yxatga olindi',couponCode:code,status:'completed',createdAt:Date.now(),completedAt:Date.now(),commission:Math.round(total*s.settings.commissionPercent/100),source:'pos_demo'};
      s.orders.push(order);claim.status='used';claim.orderId=order.id;claim.usedAt=Date.now();claim.spentValue=discount;s.events.push({type:'pos_demo',orderId:order.id,adminId:id,at:Date.now()});return {order};
    });return reply(res,200,result);
  }
  throw err('API manzili topilmadi.',404);
}
async function serveVideo(req,res,url){
  const match=/^\/media\/videos\/(vid_[a-f0-9]{24})$/.exec(url.pathname);
  if(!match)return reply(res,404,{error:'Media topilmadi.'});
  const session=readSession(req.headers.cookie,config.sessionSecret);
  if(!session || (session.demo&&!isDemoEnabled(req)) || !store.data.users[session.id])return reply(res,401,{error:'Avval Mini App ga kiring.'});
  const v=store.data.videos?.find(x=>x.id===match[1]&&x.published);
  if(!v)return reply(res,404,{error:'Video mavjud emas.'});
  const safeName=String(v.fileName||'');if(!/^[a-zA-Z0-9_.-]+\.(mp4|webm)$/.test(safeName))return reply(res,404,{error:'Fayl topilmadi.'});
  const filename=v.source==='demo'?path.join(root,'public','assets','demo-video.mp4'):path.join(mediaDir,safeName);
  let st;try{st=await fs.stat(filename);}catch{return reply(res,404,{error:'Video fayli yo‘q.'});}
  const size=st.size;const headers={'Content-Type':v.mime||'video/mp4','Accept-Ranges':'bytes','Cache-Control':'private, max-age=600'};
  let start=0,end=size-1,status=200;
  if(req.headers.range){
    const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim());
    if(!m)return reply(res,416,{error:'Range yaroqsiz.'});
    if(m[1]===''&&m[2]!==''){const suffix=Number(m[2]);start=Math.max(0,size-suffix);}else{start=Number(m[1]);if(m[2])end=Math.min(size-1,Number(m[2]));}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}
    status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length']=end-start+1;
  res.writeHead(status,headers);
  if(req.method==='HEAD')return res.end();
  fsSync.createReadStream(filename,{start,end}).on('error',e=>{console.error('Video stream:',e.message);res.destroy();}).pipe(res);
}
async function serveStatic(req,res,url){
  let p=url.pathname;
  if(p==='/')p='/index.html';if(p==='/admin')p='/admin.html';
  const allowed=['/index.html','/style.css','/config.js','/app.js','/video.js','/admin.html','/admin.js','/favicon.svg'];
  if(!allowed.includes(p) && !/^\/assets\/[a-z0-9-]+\.(png|webp)$/.test(p))return reply(res,404,{error:'Sahifa topilmadi.'});
  const file=path.join(root,'public',p);
  try{const bytes=await fs.readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(bytes);}catch{reply(res,404,{error:'Fayl yo‘q.'});}
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  // Telegram Web Mini Apps may run inside a Telegram-owned iframe.
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org; base-uri 'self'; object-src 'none'");
  try{
    const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
    const isApiRequest=url.pathname.startsWith('/api/')||url.pathname.startsWith('/media/videos/');
    const origin=req.headers.origin;
    const allowedOrigin=checkSameOrigin(req,config.frontendOrigins);
    if(isApiRequest&&origin&&allowedOrigin){
      res.setHeader('Access-Control-Allow-Origin',origin);
      res.setHeader('Access-Control-Allow-Credentials','true');
      res.setHeader('Access-Control-Allow-Methods','GET, POST, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers','Content-Type, X-Sariq-Client, Range');
      res.setHeader('Access-Control-Expose-Headers','Accept-Ranges, Content-Length, Content-Range');
      res.setHeader('Vary','Origin');
    }
    if((req.method||'GET')==='OPTIONS'){
      if(!isApiRequest||!origin||!allowedOrigin)throw err('Origin ruxsat etilmagan.',403);
      res.writeHead(204);return res.end();
    }
    if(isApiRequest&&origin&&!allowedOrigin)throw err('Origin ruxsat etilmagan.',403);
    if(req.method==='POST'&&(!checkSameOrigin(req,config.frontendOrigins)||req.headers['x-sariq-client']!=='1'))throw err('So‘rov tasdiqlanmadi.',403);
    if(req.method==='GET' && url.pathname==='/healthz')return reply(res,200,{status:'ok',service:'sariq-coin',mode:config.isProduction?'production':'development',botConfigured:!!config.botToken});
    if(url.pathname.startsWith('/api/'))return await route(req,res,url);
    if((req.method==='GET'||req.method==='HEAD')&&url.pathname.startsWith('/media/videos/'))return await serveVideo(req,res,url);
    if(req.method!=='GET')throw err('Ushbu usul qo‘llanmaydi.',405);
    return await serveStatic(req,res,url);
  }catch(e){if(e.status!==401&&e.status!==403&&e.status!==404&&e.status!==429&&e.status!==400)console.error('[Server]',e.message);return reply(res,e.status||500,{error:e.status?e.message:'Ichki server xatosi.'});}
});
server.on('error',e=>{
  if(e.code==='EADDRINUSE')console.error(`PORT ${config.port} band. Eski serverni to‘xtating yoki .env ichida PORT=8081 deb belgilang.`);
  else console.error('Serverni ishga tushirishda xato:',e.message);
  process.exitCode=1;
});
server.listen(config.port,config.host,()=>{
  console.log(`Sariq Coin Demo: http://${config.host}:${config.port}`);
  console.log(`Demo login: ${config.demoRequested&&!config.isProduction?'LOCAL ONLY':'OFF'} | Admin ID: ${config.adminId}`);
  if(!config.botToken)console.log('Telegram bot sozlanmagan. Lokal demo hali ishlaydi; .env ga yangi BOT_TOKEN qo‘shing.');
  if(config.isProduction && !config.miniAppUrl.startsWith('https://'))console.warn('DIQQAT: Mini App tugmasi uchun HTTPS MINI_APP_URL kerak.');
  if(config.botToken)startBot(config,store).catch(e=>console.error('Telegram botni ishga tushirishda xato:',e.message));
});
