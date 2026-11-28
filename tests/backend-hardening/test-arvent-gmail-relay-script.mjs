// The Apps Script relay sends ONLY partner messages, reads nothing else beyond
// the From header, never modifies Gmail and retries until Ride24 decides.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const code=readFileSync(new URL('../../scripts/arvent-gmail-relay/Code.gs',import.meta.url),'utf8');
const manifest=JSON.parse(readFileSync(new URL('../../scripts/arvent-gmail-relay/appsscript.json',import.meta.url),'utf8'));

function sandbox({messages,reply=()=>({code:200,body:{verdict:'approved'}})}){
 const props={RELAY_SECRET:'s3cret'},calls={raw:[],meta:[],fetch:[]};
 const ctx={
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]??null,setProperty:(k,v)=>{props[k]=v;}})},
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
  Gmail:{Users:{Labels:{list:()=>({labels:[{id:'Label_9',name:'RIDE24_ARVENT'}]})},
   Messages:{list:(u,o)=>{calls.list=o;return {messages:messages.map(m=>({id:m.id}))};},
    get:(u,id,o)=>{const m=messages.find(x=>x.id===id);
     if(o.format==='metadata'){calls.meta.push(id);return {sizeEstimate:1000,payload:{headers:[{name:'From',value:m.from}]}};}
     calls.raw.push(id);return {raw:[65,66]};}}}},
  UrlFetchApp:{fetch:(u,o)=>{calls.fetch.push(JSON.parse(o.payload));const r=reply(JSON.parse(o.payload));
   return {getResponseCode:()=>r.code,getContentText:()=>JSON.stringify(r.body)};}},
  Utilities:{base64Encode:b=>Buffer.from(b).toString('base64'),getUuid:()=>'u'},
  Logger:{log(){}},console:{log(){},warn(){}},ScriptApp:{},Date,JSON,Object,Number,String,Array,Error,
 };
 vm.createContext(ctx);vm.runInContext(code,ctx);
 return {ctx,props,calls};
}

test('manifest grants Gmail read-only access and nothing that can modify mail',()=>{
 assert.deepEqual(manifest.oauthScopes.filter(s=>/gmail|mail\.google/.test(s)),['https://www.googleapis.com/auth/gmail.readonly']);
 assert.doesNotMatch(code,/\b(trash|delete|modify|markRead|markUnread|addLabel|removeLabel|batchModify|untrash|send)\s*\(/i);
});

test('only @arventcarrental.com messages are read and relayed; private mail never leaves Gmail',()=>{
 const {ctx,calls,props}=sandbox({messages:[
  {id:'a1',from:'Arvent Car Rental <info@arventcarrental.com>'},
  {id:'p1',from:'Bank <alerts@bank.example>'},
  {id:'p2',from:'"info@arventcarrental.com" <x@evil.example>'},
  {id:'p3',from:'x@arventcarrental.com.evil.example'}]});
 ctx.relayArventConfirmations();
 assert.deepEqual(calls.raw,['a1']);
 assert.deepEqual(calls.fetch.map(f=>f.message_id),['a1']);
 assert.equal(calls.fetch[0].raw_base64,'QUI=');
 assert.deepEqual([...calls.list.labelIds],['Label_9']);
 assert.equal(calls.list.includeSpamTrash,false);
 // Processed and skipped messages are not looked at again.
 ctx.relayArventConfirmations();
 assert.deepEqual(calls.raw,['a1']);assert.equal(calls.fetch.length,1);
 assert.deepEqual(Object.keys(JSON.parse(props.DONE)).sort(),['a1','p1','p2','p3']);
});

test('a temporary Ride24 failure is retried on the next run',()=>{
 let n=0;
 const {ctx,calls}=sandbox({messages:[{id:'a2',from:'info@arventcarrental.com'}],
  reply:()=>(++n===1?{code:503,body:{verdict:'received'}}:{code:200,body:{verdict:'rejected'}})});
 ctx.relayArventConfirmations();ctx.relayArventConfirmations();ctx.relayArventConfirmations();
 assert.equal(calls.fetch.length,2);
});
