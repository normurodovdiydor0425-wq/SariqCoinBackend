import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {verifyTelegramInitData,issueSession,readSession} from '../src/security.mjs';
import {PRODUCTS,REWARDS,regenerateEnergy,calculateDiscount,localDay} from '../src/catalog.mjs';

const token='000001:TEST_TOKEN_ONLY';
function signedInitData(userId=969070334,now=Date.now()){
  const p=new URLSearchParams({auth_date:String(Math.floor(now/1000)),user:JSON.stringify({id:userId,first_name:'Sinov',username:'test_user'}),start_param:'ref_123'});
  const chk=[...p].sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>`${k}=${v}`).join('\n');
  const sk=crypto.createHmac('sha256','WebAppData').update(token).digest();
  p.set('hash',crypto.createHmac('sha256',sk).update(chk).digest('hex'));return p.toString();
}
test('telegram signed initData passes validation',()=>{const result=verifyTelegramInitData(signedInitData(),token);assert.equal(result.id,'969070334');assert.equal(result.startParam,'ref_123');});
test('tampered user id fails hash check',()=>{const data=signedInitData().replace('969070334','888888888');assert.throws(()=>verifyTelegramInitData(data,token),/tasdiqlanmadi/);});
test('old initData fails',()=>assert.throws(()=>verifyTelegramInitData(signedInitData(123,Date.now()-3*86400000),token),/eskirgan/));
test('server session token cannot be forged',()=>{const secret='test-secret-more-than-thirty-two-bytes';const sess=issueSession({id:'969070334'},secret);assert.equal(readSession(`sariq_session=${sess}`,secret).id,'969070334');assert.equal(readSession(`sariq_session=${sess}tampered`,secret),null);});
test('energy regeneration uses configured seconds',()=>{const now=Date.now();const user={energy:0,energyAt:now-5*60*1000,dailyDay:localDay(now),dailyTaps:5};regenerateEnergy(user,now,{energyMax:300,regenSeconds:60});assert.equal(user.energy,5);assert.equal(user.dailyTaps,5);});
test('5% coupon discounts the full eligible subtotal, without the old 5 000-so‘m cap',()=>{
 const discount=REWARDS.find(r=>r.id==='discount5');
 assert.equal(calculateDiscount(discount,[],79000),3950);
 assert.equal(calculateDiscount(discount,[],150000),7500);
 assert.equal(calculateDiscount(discount,[],200000),10000);
 assert.equal(calculateDiscount(discount,[],500000),25000);
 assert.equal(calculateDiscount(discount,[],3000000),150000);
 assert.throws(()=>calculateDiscount(discount,[],30000),/kamida/);
});
test('free item requires product in cart',()=>{const free=REWARDS.find(r=>r.id==='freefri');assert.throws(()=>calculateDiscount(free,[],100000),/savatchaga/);assert.equal(calculateDiscount(free,[{productId:'fri',qty:1}],100000),18000);});
test('demo products all have valid positive prices',()=>{assert.equal(PRODUCTS.length,6);for(const p of PRODUCTS){assert.ok(p.price>0);assert.ok(p.emoji);}});
