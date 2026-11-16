export const PRODUCTS = [
  { id:'pepperoni', category:'Pitsa', name:'Pepperoni', emoji:'🍕', price:89000, description:'Pepperoni va pishloqli pitsa (demo narx)' },
  { id:'margarita', category:'Pitsa', name:'Margarita', emoji:'🍕', price:79000, description:'Pomidor va pishloqli pitsa (demo narx)' },
  { id:'chicken', category:'Burger', name:'Chicken Burger', emoji:'🍔', price:36000, description:'Tovuqli burger (demo narx)' },
  { id:'lavash', category:'Lavash', name:'Lavash', emoji:'🌯', price:39000, description:'Tovuqli lavash (demo narx)' },
  { id:'fri', category:'Gazaklar', name:'Fri', emoji:'🍟', price:18000, description:'Kartoshka fri (demo narx)' },
  { id:'cola', category:'Ichimlik', name:'Cola', emoji:'🥤', price:12000, description:'Sovuq ichimlik (demo narx)' }
];

// Bular haqiqiy restoran kuponlari EMAS. Demo shartlari, admin bilan kelishiladi.
// Demo buyurtma chegarasi server va kupon byudjeti hisobida bir xil qo‘llanadi.
export const MAX_ORDER_SUBTOTAL = 3_000_000;
export const REWARDS = [
  { id:'discount5', name:'5% chegirma', type:'percent', cost:2000, value:5, maxDiscount:Math.floor(MAX_ORDER_SUBTOTAL*5/100), minOrder:50000, monthlyLimit:500, emoji:'🎟️', description:'Kamida 50 000 so‘mlik buyurtmaning to‘liq 5% i; har kupon faqat 1 marta ishlatiladi' },
  { id:'freefri', name:'Fri sovg‘a', type:'free_item', cost:5000, productId:'fri', maxDiscount:18000, minOrder:50000, monthlyLimit:100, emoji:'🍟', description:'50 000 so‘mdan katta buyurtmada 1 ta Fri bepul' },
  { id:'discount10k', name:'10 000 so‘m chegirma', type:'fixed', cost:10000, value:10000, maxDiscount:10000, minOrder:70000, monthlyLimit:200, emoji:'🎁', description:'Kamida 70 000 so‘mlik mahsulot buyurtmasiga' },
  { id:'freepizza', name:'Margarita sovg‘a', type:'free_item', cost:25000, productId:'margarita', maxDiscount:79000, minOrder:100000, monthlyLimit:20, emoji:'🍕', description:'100 000 so‘mdan katta buyurtmada 1 ta Margarita bepul' }
];

export const DEFAULT_SETTINGS = Object.freeze({ monthlyBudget:5000000, commissionPercent:3, energyMax:300, regenSeconds:60, dailyTapLimit:500 });

export const DAILY_BONUS = 50;
export const REFERRER_BONUS = 200;
export const REFEREE_BONUS = 100;
export const REFERRAL_FIRST_ORDER_MIN = 50000;
export const REFERRAL_MONTHLY_CAP = 5;

export const localDay = (ms=Date.now()) => new Date(ms + 5*60*60*1000).toISOString().slice(0,10);
export const localMonth = (ms=Date.now()) => localDay(ms).slice(0,7);
export function regenerateEnergy(user, now, settings) {
  if (!Number.isFinite(user.energy)) user.energy = settings.energyMax;
  const elapsed = Math.max(0, (now - (user.energyAt ?? now)) / 1000);
  user.energy = Math.min(settings.energyMax, user.energy + elapsed / settings.regenSeconds);
  user.energyAt = now;
  const today=localDay(now);
  if (user.dailyDay !== today) { user.dailyDay=today; user.dailyTaps=0; }
  return user;
}
export function calculateDiscount(reward, items, subtotal) {
  if (!reward) throw new Error('Kupon turi topilmadi.');
  if (subtotal < reward.minOrder) throw new Error(`Kupon uchun kamida ${reward.minOrder.toLocaleString('en-US')} so‘mlik mahsulot kerak.`);
  // Percentage vouchers apply to the *entire* eligible subtotal. The demo order
  // ceiling, not a hidden 5 000 so‘m cap, bounds the maximum possible exposure.
  if (reward.type==='percent') return Math.min(subtotal,Math.floor(subtotal*reward.value/100));
  if (reward.type==='fixed') return Math.min(subtotal,reward.value,reward.maxDiscount);
  if (reward.type==='free_item') {
    const chosen=items.find(it=>it.productId===reward.productId);
    if (!chosen || chosen.qty<1) throw new Error('Sovg‘a mahsulotni savatchaga qo‘shing.');
    const product=PRODUCTS.find(it=>it.id===reward.productId);
    return Math.min(subtotal,product.price,reward.maxDiscount);
  }
  throw new Error('Kupon turi noma’lum.');
}
export function safeCustomer(u) {
  return { id:u.id,name:u.name,username:u.username,totalTaps:u.totalTaps,coins:u.coins,energy:Math.floor(u.energy),dailyTaps:u.dailyTaps,selectedProduct:u.selectedProduct,boosterUntil:u.boosterUntil,boosterUsedDay:u.boosterUsedDay,dailyClaimedDay:u.dailyClaimedDay,referralCount:u.referralCount,referralBonusCount:u.referralBonusCount,createdAt:u.createdAt,referrerId:u.referrerId,totalVideoSeconds:Math.floor(u.totalVideoSeconds||0),videoCoinsEarned:u.videoCoinsEarned||0 };
}
