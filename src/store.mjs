import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {DEFAULT_SETTINGS,localDay} from './catalog.mjs';

export const newState=()=>({version:1,users:{},pendingReferrals:{},claims:[],orders:[],events:[],settings:{...DEFAULT_SETTINGS}});
export class Store {
  constructor(file){this.file=file;this.data=newState();this.pending=Promise.resolve();}
  async init(){await fs.mkdir(path.dirname(this.file),{recursive:true});try {this.data=JSON.parse(await fs.readFile(this.file,'utf8'));} catch(e){if(e.code!=='ENOENT') throw e;await this.save();}}
  async save(state=this.data){
    const tmp=`${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp,JSON.stringify(state,null,2),{mode:0o600});
      await fs.rename(tmp,this.file);
    } catch(e) {
      await fs.unlink(tmp).catch(()=>{});
      throw e;
    }
  }
  // Validate and save an isolated draft, then publish it. Errors must not partially mutate live balances.
  async edit(fn){
    const action=this.pending.then(async()=>{
      const draft=structuredClone(this.data);
      const result=await fn(draft);
      await this.save(draft);
      this.data=draft;
      return result;
    });
    this.pending=action.catch(()=>{});
    return action;
  }
  ensureUser(state,identity,now=Date.now(),isDemo=false){
    if (!state.users[identity.id]) state.users[identity.id]={id:identity.id,name:identity.name,username:identity.username,coins:isDemo?12480:0,energy:state.settings.energyMax,energyAt:now,dailyDay:localDay(now),dailyTaps:0,totalTaps:0,tapsByProduct:{},selectedProduct:'pepperoni',createdAt:now,dailyClaimedDay:'',boosterUntil:0,boosterUsedDay:'',referrerId:null,referralCount:0,referralBonusCount:0,firstOrderRewarded:false};
    const u=state.users[identity.id];u.name=identity.name;u.username=identity.username;
    const startRef=/^ref_(\d+)$/.exec(identity.startParam||'');
    const refId=startRef?.[1]||state.pendingReferrals[identity.id];
    if(refId && refId!==identity.id && state.users[refId] && !u.referrerId && u.totalTaps===0 && !state.orders.some(o=>o.userId===u.id)) {
      u.referrerId=refId;state.users[refId].referralCount=(state.users[refId].referralCount||0)+1;
    }
    delete state.pendingReferrals[identity.id];
    return u;
  }
}
