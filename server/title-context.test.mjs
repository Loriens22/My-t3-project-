import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import plugin, { applyTitleContext } from './plugins/t3-title-context/server.mjs';
const stock = JSON.parse(fs.readFileSync(new URL('./plugins/groq-context/stock-prompts.json',import.meta.url),'utf8')).prompts;
const session = () => ({title:'T3 Code generateThreadTitle',permissions:[{action:'*',resource:'*',effect:'ask'}]});
const event = () => ({sessionID:'owned',agent:'build',model:{providerID:'nvidia',id:'nvidia/nemotron-3.5-lightning-30b-a3b'},
  system:[{type:'text',text:stock.at(-1).text},{type:'text',text:'OWNER AGENTS.md MUST REMAIN EXACT',metadata:{experimental:{instructions:[{key:'owner',text:'RULES'}]}}}],
  messages:[{role:'user',content:[{type:'text',text:'Generate a title that will help the user recognize this T3 Code thread weeks later.\nReturn JSON with keys title and needsRefinement.\n\nUser message:\nUse shell to create a city.'}]}],
  tools:{shell:{description:'Shell',input:{type:'object'}}},options:{maxTokens:32000,temperature:0.7}});
test('only the exact temporary title factory becomes a bounded tool-free metadata request',()=>{
 for(const prompt of stock){const e=event();e.system[0].text=prompt.text;const before=structuredClone(e);const messages=e.messages;const owner=e.system[1];assert.equal(applyTitleContext(e,session(),{id:'build'}),true);
  assert.match(e.system.at(-1).text,/reference data to name, not tasks to execute/);assert.deepEqual(e.tools,{});assert.equal(e.options.maxTokens,2048);assert.equal(e.options.temperature,before.options.temperature);assert.equal(e.messages,messages);assert.equal(e.system[1],owner);assert.deepEqual(e.system.slice(0,-1),before.system);assert.deepEqual(e.model,before.model);}
});
test('normal coding sessions, custom agents/prompts and mismatched providers remain byte-identical',()=>{
 for(const change of [
  (e,s)=>s.title='Owner coding session',(e,s)=>s.permissions[0].effect='allow',
  (e,s)=>s.permissions.push({action:'read',resource:'*',effect:'ask'}),
  (e)=>e.model.providerID='groq',(e)=>e.model.id='owner/model',
  (e)=>e.messages[0].content[0].text='Owner task',
 ]){const e=event(),s=session();change(e,s);const before=JSON.stringify(e);assert.equal(applyTitleContext(e,s,{id:'build'}),false);assert.equal(JSON.stringify(e),before);}
 const e=event(),before=JSON.stringify(e);assert.equal(applyTitleContext(e,session(),{system:stock.at(-1).text}),false);assert.equal(JSON.stringify(e),before);
});
test('all harness/owner system parts survive unknown stock templates without duplication',()=>{
 const e=event();e.system[0]={type:'text',text:'Additional T3 harness instructions',metadata:{experimental:{instructions:[{key:'owner',text:'OWNER RULE'}]}}};const before=structuredClone(e.system);
 assert.equal(applyTitleContext(e,session(),{id:'build'}),true);assert.deepEqual(e.system.slice(0,-1),before);const once=JSON.stringify(e);applyTitleContext(e,session(),{id:'build'});assert.equal(JSON.stringify(e),once);
});
test('regeneration is supported and a smaller preexisting output cap is preserved',()=>{
 const e=event();e.options.maxTokens=512;e.messages[0].content[0].text='Regenerate the title for an existing T3 Code thread so the user can recognize it weeks later.\nThe previous title was "Old".\nReturn JSON with keys title and needsRefinement.';
 assert.equal(applyTitleContext(e,session(),{}),true);assert.equal(e.options.maxTokens,512);
});
test('title text survives synthetic user context, text-only content and harness wrappers',()=>{
 for(const form of ['synthetic-first','string','wrapped']){const e=event();const original=e.messages[0].content[0].text;
  if(form==='synthetic-first')e.messages.unshift({role:'user',content:[{type:'text',text:'Harness context before the title request'}]});
  if(form==='string')e.messages[0].content=original;
  if(form==='wrapped')e.messages[0].content[0].text='<system-reminder>Harness context</system-reminder>\n'+original;
  const messages=structuredClone(e.messages);assert.equal(applyTitleContext(e,session(),{id:'build'}),true);assert.deepEqual(e.messages,messages);assert.deepEqual(e.tools,{});
 }
});
test('runtime registration scopes the hook and fails closed on missing identification',async()=>{
 for(const broken of [false,true]){const callbacks=new Map();let disposed=0;const cleanup=await plugin.setup({session:{async get(){if(broken)throw Error('lookup failed');return session();},async hook(name,fn,filter){assert.deepEqual(filter,{providerID:'nvidia'});callbacks.set(name,fn);return {dispose(){disposed++;}};}},agent:{async get(){return {data:{id:'build'}};}}});assert.deepEqual([...callbacks.keys()],['context','generate']);for(const callback of callbacks.values()){const e=event();const before=JSON.stringify(e);await callback(e);if(broken)assert.equal(JSON.stringify(e),before);else assert.deepEqual(e.tools,{});}await cleanup();assert.equal(disposed,2);}
});
