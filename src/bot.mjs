// Telegram Bot API long polling. Hech qanday tashqi npm kutubxonasi talab qilinmaydi.
async function tg(token,method,data={}) {
  const result=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(35000)});
  const json=await result.json();if(!json.ok)throw Error(`${method}: ${json.description||'Telegram xatosi'}`);return json.result;
}
export async function startBot(config,store){
  const bot=await tg(config.botToken,'getMe');config.botUsername=bot.username||'';
  console.log(`Bot ishga tushdi: @${config.botUsername}`);
  if(config.miniAppUrl){
    if(!config.miniAppUrl.startsWith('https://'))console.warn('Telegram Mini App uchun HTTPS manzil kerak.');
    else await tg(config.botToken,'setChatMenuButton',{menu_button:{type:'web_app',text:'🍕 Sariq Coin',web_app:{url:config.miniAppUrl}}}).catch(e=>console.warn(e.message));
  }
  let offset=0;
  let lastReport=0;
  for(;;){
    try{
      const updates=await tg(config.botToken,'getUpdates',{offset,timeout:25,allowed_updates:['message','channel_post']});
      for(const update of updates){
        offset=Math.max(offset,update.update_id+1);
        if(update.channel_post && config.onChannelPost){await config.onChannelPost(update.channel_post);continue;}
        const msg=update.message;
        if(!msg?.text||!msg.chat||!msg.from)continue;
        if(!msg.text.startsWith('/start')&&!msg.text.startsWith('/help')&&!msg.text.startsWith('/admin'))continue;
        const id=String(msg.from.id);
        const ref=/^\/start(?:@\w+)?\s+ref_(\d+)\s*$/.exec(msg.text);
        if(ref && ref[1]!==id){await store.edit(s=>{s.pendingReferrals[id]=ref[1];});}
        if(msg.text.startsWith('/admin')&&id!==config.adminId){await tg(config.botToken,'sendMessage',{chat_id:msg.chat.id,text:'Admin panel faqat vakolatli foydalanuvchi uchun.'});continue;}
        const txt=msg.text.startsWith('/admin')?'🛡 Admin panel Mini App ichida «Profil → Admin panel» orqali ochiladi.':'🍕 Sariq Coin — bosib tangalar yig‘ing, sinov kuponlarini oling!\n\n⚠️ Bu DEMO loyiha. Hozircha real buyurtma va chegirmalar ishlamaydi.';
        const keyboard=config.miniAppUrl.startsWith('https://')?{keyboard:[[{text:'🍕 Sariq Coin o‘yinini ochish',web_app:{url:config.miniAppUrl}}]],resize_keyboard:true,is_persistent:true}:undefined;
        await tg(config.botToken,'sendMessage',{chat_id:msg.chat.id,text:txt,reply_markup:keyboard});
      }
    }catch(e){
      if(Date.now()-lastReport>30000){console.warn('Telegram polling:',e.message);lastReport=Date.now();}
      await new Promise(resolve=>setTimeout(resolve,3000));
    }
  }
}
