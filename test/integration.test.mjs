import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const listenPort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function runServer(fn,extraEnv={}){
 const tmp=await mkdtemp(path.join(os.tmpdir(),'sariq-coin-v2-'));const port=await listenPort();
 const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,DATA_FILE:path.join(tmp,'store.json'),PORT:String(port),HOST:'127.0.0.1',BOT_TOKEN:'',DEMO_MODE:'true',NODE_ENV:'development',...extraEnv},stdio:'pipe'});
 const base=`http://127.0.0.1:${port}`;
 try{
  let ready=false;
  for(let i=0;i<80;i++){if(child.exitCode!==null)break;try{const res=await fetch(base+'/healthz');if(res.ok){ready=true;break;}}catch{}await delay(80);}
  assert.ok(ready,'Demo server did not start');
  await fn(base);
 }finally{child.kill();await rm(tmp,{recursive:true,force:true});}
}
test('configured frontend origin receives credentialed CORS and preflight support',async()=>{
 await runServer(async base=>{
  const origin='https://sariqcoin.example';
  let response=await fetch(base+'/api/auth/telegram',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type,x-sariq-client'}});
  assert.equal(response.status,204);
  assert.equal(response.headers.get('access-control-allow-origin'),origin);
  assert.equal(response.headers.get('access-control-allow-credentials'),'true');
  response=await fetch(base+'/api/auth/telegram',{method:'POST',headers:{origin,'content-type':'application/json','x-sariq-client':'1'},body:'{}'});
  assert.equal(response.status,503,'allowed cross-origin POST reaches the API');
  assert.equal(response.headers.get('access-control-allow-origin'),origin);
  response=await fetch(base+'/api/auth/telegram',{method:'OPTIONS',headers:{origin:'https://untrusted.example','access-control-request-method':'POST'}});
  assert.equal(response.status,403);
  assert.equal(response.headers.get('access-control-allow-origin'),null);
 },{FRONTEND_ORIGINS:'https://sariqcoin.example'});
});
async function client(base){
 let cookie='';
 const call=async(endpoint,payload,method)=>{
  const post=method==='POST'||payload!==undefined;
  const res=await fetch(base+endpoint,{method:post?'POST':'GET',headers:{'content-type':'application/json','x-sariq-client':'1',...(cookie?{cookie}:{})},body:post?JSON.stringify(payload??{}):undefined});
  const sc=res.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];
  return {status:res.status,data:await res.json()};
 };
 return call;
}
test('full local demo: tap, reward, order, admin approval, cancelled coupon restoration',async()=>{
 await runServer(async base=>{
  const call=await client(base);
  const image=await fetch(base+'/assets/pizza-main.png');
  assert.equal(image.status,200);
  assert.match(image.headers.get('content-type')||'',/image\/png/);
  assert.ok((await image.arrayBuffer()).byteLength>10000);
  const privateFile=await fetch(base+'/.env');
  assert.equal(privateFile.status,404);
  let r=await call('/api/config');assert.equal(r.status,200);assert.equal(r.data.products.length,6);
  r=await call('/api/auth/demo',{asAdmin:false});assert.equal(r.status,200);
  r=await call('/api/me');assert.equal(r.data.user.coins,12480);
  r=await call('/api/game/tap',{productId:'pepperoni',count:5});assert.equal(r.data.earned,5);
  const beforeBoost=(await call('/api/me')).data.user;
  r=await call('/api/game/boost',{});assert.equal(r.status,200);
  assert.ok(r.data.boosterUntil-Date.now()>29*60*1000,'x2 30 daqiqa davom etishi kerak');
  r=await call('/api/game/tap',{productId:'pepperoni',count:1});
  assert.equal(r.status,200);assert.equal(r.data.multiplier,2);
  assert.equal(r.data.earned,2,'x2 bilan 1 bosish +2 Coin beradi');
  assert.equal(r.data.dailyTaps,beforeBoost.dailyTaps+1,'haqiqiy bosishlar soni 1 taga oshadi');
  assert.equal(r.data.coins,beforeBoost.coins+2);
  r=await call('/api/me');assert.equal(r.data.user.totalTaps,beforeBoost.totalTaps+1);
  r=await call('/api/coupons/redeem',{rewardId:'discount5'});assert.equal(r.status,200);const code=r.data.code;
  r=await call('/api/orders',{items:[{productId:'pepperoni',qty:1}],fulfillment:'pickup',couponCode:code});assert.equal(r.status,200);let order=r.data.order;
  assert.equal(order.subtotal,89000);assert.equal(order.discount,4450);assert.equal(order.total,84550);
  r=await call('/api/orders',{items:[{productId:'pepperoni',qty:1}],fulfillment:'pickup',couponCode:code});assert.equal(r.status,400);
  r=await call('/api/admin/overview');assert.equal(r.status,403);
  const admin=await client(base);r=await admin('/api/auth/demo',{asAdmin:true});assert.equal(r.status,200);
  r=await admin(`/api/admin/orders/${order.id}/status`,{status:'cancelled'});assert.equal(r.status,200);
  r=await call('/api/me');assert.equal(r.data.coupons.find(c=>c.code===code).status,'active');
  r=await call('/api/orders',{items:[{productId:'pepperoni',qty:1}],fulfillment:'delivery',couponCode:code});assert.equal(r.status,200);order=r.data.order;
  r=await admin(`/api/admin/orders/${order.id}/status`,{status:'completed'});assert.equal(r.status,200);assert.equal(r.data.order.commission,Math.round(84550*.03));
  r=await call('/api/me');assert.equal(r.data.coupons.find(c=>c.code===code).status,'used');
  r=await admin('/api/admin/overview');assert.equal(r.status,200);assert.equal(r.data.stats.completedOrders,1);
 });
});

test('cart quote applies discounts immediately without spending the coupon',async()=>{
 await runServer(async base=>{
  const call=await client(base);
  let r=await call('/api/auth/demo',{asAdmin:false});assert.equal(r.status,200);
  r=await call('/api/orders/quote',{items:[{productId:'margarita',qty:1}],fulfillment:'delivery',couponCode:''});
  assert.equal(r.status,200);
  assert.deepEqual([r.data.subtotal,r.data.discount,r.data.total],[79000,0,79000]);

  r=await call('/api/coupons/redeem',{rewardId:'discount5'});
  assert.equal(r.status,200);const code=r.data.code;
  const requestData={items:[{productId:'margarita',qty:1}],fulfillment:'delivery',couponCode:code};
  r=await call('/api/orders/quote',requestData);
  assert.equal(r.status,200);
  assert.deepEqual([r.data.subtotal,r.data.discount,r.data.total],[79000,3950,75050]);
  // A quote must never reserve a coupon, even when requested several times.
  r=await call('/api/orders/quote',requestData);assert.equal(r.status,200);
  r=await call('/api/me');assert.equal(r.data.coupons.find(c=>c.code===code).status,'active');
  r=await call('/api/orders/quote',{...requestData,items:[{productId:'chicken',qty:1}]});
  assert.equal(r.status,400);assert.match(r.data.error,/kamida/);
  r=await call('/api/orders',requestData);assert.equal(r.status,200);
  assert.equal(r.data.order.total,75050);
  r=await call('/api/orders/quote',requestData);assert.equal(r.status,400);
 });
});

test('free-product quote validates cart contents and preserves totals',async()=>{
 await runServer(async base=>{
  const call=await client(base);
  await call('/api/auth/demo',{asAdmin:false});
  let r=await call('/api/coupons/redeem',{rewardId:'freefri'});
  assert.equal(r.status,200);const code=r.data.code;
  r=await call('/api/orders/quote',{items:[{productId:'margarita',qty:1}],fulfillment:'pickup',couponCode:code});
  assert.equal(r.status,400);assert.match(r.data.error,/Sovg‘a mahsulot/);
  r=await call('/api/orders/quote',{items:[{productId:'margarita',qty:1},{productId:'fri',qty:1}],fulfillment:'pickup',couponCode:code});
  assert.equal(r.status,200);
  assert.deepEqual([r.data.subtotal,r.data.discount,r.data.total],[97000,18000,79000]);
 });
});


test('product purchase adds one Coin per item in demo and reverses on cancellation',async()=>{
 await runServer(async base=>{
  const call=await client(base);await call('/api/auth/demo',{asAdmin:false});
  const before=(await call('/api/me')).data.user.coins;
  const items=[{productId:'margarita',qty:2},{productId:'cola',qty:1}];
  const q=await call('/api/orders/quote',{items,fulfillment:'pickup',couponCode:''});
  assert.equal(q.status,200);assert.equal(q.data.purchaseCoinReward,3);
  const placed=await call('/api/orders',{items,fulfillment:'pickup',couponCode:''});
  assert.equal(placed.status,200);
  assert.equal(placed.data.order.purchaseCoinReward,3);
  assert.equal(placed.data.order.purchaseRewardGranted,true);
  assert.equal((await call('/api/me')).data.user.coins,before+3);
  const admin=await client(base);await admin('/api/auth/demo',{asAdmin:true});
  let r=await admin(`/api/admin/orders/${placed.data.order.id}/status`,{status:'cancelled'});
  assert.equal(r.status,200);assert.equal(r.data.order.purchaseRewardGranted,false);
  assert.equal((await call('/api/me')).data.user.coins,before);
  r=await admin(`/api/admin/orders/${placed.data.order.id}/status`,{status:'cancelled'});
  assert.equal(r.status,400,'repeat cancellation must not credit or deduct twice');
 });
});

test('completed demo order does not pay product Coin reward a second time',async()=>{
 await runServer(async base=>{
  const call=await client(base);await call('/api/auth/demo',{asAdmin:false});
  const before=(await call('/api/me')).data.user.coins;
  const result=await call('/api/orders',{items:[{productId:'pepperoni',qty:1}],fulfillment:'delivery',couponCode:''});
  assert.equal(result.status,200);
  const admin=await client(base);await admin('/api/auth/demo',{asAdmin:true});
  const updated=await admin(`/api/admin/orders/${result.data.order.id}/status`,{status:'completed'});
  assert.equal(updated.status,200);assert.equal(updated.data.order.purchaseRewardGranted,true);
  assert.equal((await call('/api/me')).data.user.coins,before+1);
 });
});


test('percent coupon over 100 000 is exact, reserved for one order, used once (online and POS)',async()=>{
 await runServer(async base=>{
  const buyer=await client(base);
  await buyer('/api/auth/demo',{asAdmin:false});
  const issued=await buyer('/api/coupons/redeem',{rewardId:'discount5'});
  assert.equal(issued.status,200);
  const code=issued.data.code;
  const items=[{productId:'pepperoni',qty:2},{productId:'fri',qty:1}]; // 196 000 so‘m
  const requestData={items,fulfillment:'pickup',couponCode:code};
  const quote=await buyer('/api/orders/quote',requestData);
  assert.equal(quote.status,200);
  assert.deepEqual([quote.data.subtotal,quote.data.discount,quote.data.total],[196000,9800,186200]);
  const placed=await buyer('/api/orders',requestData);
  assert.equal(placed.status,200);
  assert.equal(placed.data.order.discount,9800);
  let again=await buyer('/api/orders',requestData);
  assert.equal(again.status,400,'a reserved voucher cannot create a second order');
  const admin=await client(base);
  await admin('/api/auth/demo',{asAdmin:true});
  let result=await admin('/api/admin/overview');
  assert.equal(result.status,200);
  const claimReserved=result.data.claims.find(c=>c.code===code);
  assert.equal(claimReserved.status,'reserved');
  assert.equal(claimReserved.reservedValue,150000,'maximum possible percent exposure is reserved');
  const completed=await admin(`/api/admin/orders/${placed.data.order.id}/status`,{status:'completed'});
  assert.equal(completed.status,200);
  result=await admin('/api/admin/overview');
  const used=result.data.claims.find(c=>c.code===code);
  assert.equal(used.status,'used');
  assert.equal(used.spentValue,9800,'actual cost recorded after completion');
  assert.equal(result.data.stats.monthlyReserved,9800,'budget counts real expense of used coupon');
  again=await buyer('/api/orders/quote',requestData);
  assert.equal(again.status,400);
  again=await buyer('/api/orders',requestData);
  assert.equal(again.status,400);
  again=await admin('/api/admin/coupons/use',{code,subtotal:200000});
  assert.equal(again.status,400,'online used coupon cannot be used at POS');
  const second=await buyer('/api/coupons/redeem',{rewardId:'discount5'});
  assert.equal(second.status,200);
  assert.notEqual(second.data.code,code,'separate purchases have separate one-use codes');
  result=await admin('/api/admin/coupons/use',{code:second.data.code,subtotal:200000});
  assert.equal(result.status,200);
  assert.deepEqual([result.data.order.subtotal,result.data.order.discount,result.data.order.total],[200000,10000,190000]);
  again=await admin('/api/admin/coupons/use',{code:second.data.code,subtotal:200000});
  assert.equal(again.status,400,'POS used coupon cannot be used twice');
 });
});

test('parallel checkout requests cannot spend the same coupon twice',async()=>{
 await runServer(async base=>{
  const buyer=await client(base);await buyer('/api/auth/demo',{asAdmin:false});
  const issued=await buyer('/api/coupons/redeem',{rewardId:'discount5'});
  const payload={items:[{productId:'margarita',qty:1}],fulfillment:'pickup',couponCode:issued.data.code};
  const answers=await Promise.all([buyer('/api/orders',payload),buyer('/api/orders',payload)]);
  assert.deepEqual(answers.map(r=>r.status).sort(),[200,400]);
 });
});
