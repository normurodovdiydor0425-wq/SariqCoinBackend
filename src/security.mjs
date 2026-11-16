import crypto from 'node:crypto';

export function verifyTelegramInitData(raw, token, now=Date.now()) {
  if (!raw || typeof raw!=='string' || raw.length>16000 || !token) throw new Error('Telegram identifikatsiya ma’lumotlari yo‘q.');
  const params = new URLSearchParams(raw);
  const hash=params.get('hash');
  const authDate=Number(params.get('auth_date'));
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isSafeInteger(authDate)) throw new Error('Telegram imzosi yoki sana noto‘g‘ri.');
  const nowSec=Math.floor(now/1000);
  if (authDate>nowSec+60 || nowSec-authDate>86400) throw new Error('Telegram sessiyasi eskirgan. Botdan qayta kiring.');
  const checkString=[...params.entries()].filter(([k])=>k!=='hash').sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=crypto.createHmac('sha256','WebAppData').update(token).digest();
  const expected=crypto.createHmac('sha256',secret).update(checkString).digest();
  const actual=Buffer.from(hash,'hex');
  if (expected.length!==actual.length || !crypto.timingSafeEqual(expected,actual)) throw new Error('Telegram ma’lumotlari tasdiqlanmadi.');
  let user;
  try { user=JSON.parse(params.get('user')||'null'); } catch { throw new Error('Telegram foydalanuvchi ma’lumotlari xato.'); }
  if (!user || !Number.isSafeInteger(user.id) || user.id<=0) throw new Error('Telegram ID topilmadi.');
  return { id:String(user.id), name:String(user.first_name||'Foydalanuvchi').slice(0,80), username:String(user.username||'').slice(0,80), startParam:String(params.get('start_param')||'').slice(0,100) };
}

export function issueSession(identity, secret, isDemo=false, now=Date.now()) {
  const payload=Buffer.from(JSON.stringify({id:String(identity.id),demo:!!isDemo,exp:now+7*86400000})).toString('base64url');
  const signature=crypto.createHmac('sha256',secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
export function readSession(cookieHeader,secret,now=Date.now()) {
  const raw=(cookieHeader||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('sariq_session='))?.slice(14);
  if (!raw) return null;
  const [payload,signature,extra]=raw.split('.');
  if (!payload||!signature||extra) return null;
  const expected=crypto.createHmac('sha256',secret).update(payload).digest('base64url');
  const a=Buffer.from(signature); const b=Buffer.from(expected);
  if (a.length!==b.length || !crypto.timingSafeEqual(a,b)) return null;
  try { const p=JSON.parse(Buffer.from(payload,'base64url').toString()); return p.exp>now && /^\d+$/.test(p.id) ? p : null; } catch { return null; }
}
export const isLocalRequest = req => {
  const host=String(req.headers.host||'').toLowerCase();
  const localHost=/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host);
  return localHost && !req.headers['x-forwarded-for'] && !req.headers['forwarded'] && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
};
export function checkSameOrigin(req, allowedOrigins=new Set()) {
  const origin=req.headers.origin;
  if (!origin) return true; // non-browser clients; still need signed session
  try {
    const parsed=new URL(origin);
    return parsed.host===req.headers.host || allowedOrigins.has(parsed.origin);
  } catch{return false;}
}
