import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startRun,loadRun,amendRunDefinition,evaluateRun,definitionIdentity,definitionDigest,flowRunHead,claimReadyStep,releaseStepClaim,attachEvidence,validateRunStateConsistency} from '../../dist/index.js';

import {surfaceClaimEvidenceFixture} from './helpers/fixtures.mjs';
const expectation={id:'observed',kind:'trust.bundle',required:true,description:'Observed fixture quality',bundle_claim:{claimType:'quality.tests'}};
async function advance(f){const run=await loadRun(f.runId,f.cwd),file=path.join(f.cwd,'pass.json');await writeFile(file,JSON.stringify((await surfaceClaimEvidenceFixture('pass-trust-report.json')).evidence[0].bundle));await attachEvidence(f.runId,{cwd:f.cwd,gate:`${run.state.current_step}-gate`,file,kind:'trust.bundle'});return evaluateRun(f.runId,{cwd:f.cwd});}
const definition=()=>({id:'pending-forward',version:'1',steps:[{id:'a',next:'b'},{id:'b',next:'c'},{id:'c',next:null}],gates:Object.fromEntries(['a','b','c'].map(id=>[`${id}-gate`,{step:id,expects:[expectation]}]))});
async function fixture(t,def=definition()) {const cwd=await mkdtemp(path.join(os.tmpdir(),'flow-pending-forward-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const file=path.join(cwd,'definition.json');await writeFile(file,JSON.stringify(def));const run=await startRun(file,{cwd,runId:'pending'});return {cwd,runId:run.runId,before:await loadRun(run.runId,cwd)};}
const request=(before,next,ref='operator:pending')=>({reason:'Change only future pending work.',expected_run_head:flowRunHead(before.state),expected_definition:definitionIdentity(before.definition),successor_digest:definitionDigest(next),compatibility_mode:'pending_forward',authority:{kind:'operator_request',actor:'test-operator',request_ref:ref,requested_at:'2026-10-09T20:00:00.000Z'}});
function skip(def=definition()){const next=structuredClone(def);next.version='skip';next.steps[0].next='c';next.steps=next.steps.filter(step=>step.id!=='b');delete next.gates['b-gate'];return next;}
function add(def=definition()){const next=structuredClone(def);next.version='add';next.steps[0].next='new';next.steps.splice(1,0,{id:'new',next:'b'});next.gates['new-gate']={step:'new',expects:[expectation]};return next;}

test('opt-in skips immediate future step without editing start/evidence; default remains protective',async t=>{
 const f=await fixture(t),next=skip(),auth=request(f.before,next);const stateFile=path.join(f.before.dir,'state.json');const bytes=await readFile(stateFile);
 const strict={...auth};delete strict.compatibility_mode;
 await assert.rejects(amendRunDefinition(f.runId,{cwd:f.cwd,definition:next,request:strict}),/reinterprets persisted step a/);assert.deepEqual(await readFile(stateFile),bytes);
 const startBytes=await readFile(path.join(f.before.dir,'definition.json')),manifest=await readFile(path.join(f.before.dir,'evidence/manifest.json'));
 await amendRunDefinition(f.runId,{cwd:f.cwd,definition:next,request:auth});const amended=await loadRun(f.runId,f.cwd);assert.equal(amended.state.current_step,'a');assert.equal(amended.state.definition_amendments[0].compatibility_mode,'pending_forward');assert.deepEqual(await readFile(path.join(f.before.dir,'definition.json')),startBytes);assert.deepEqual(await readFile(path.join(f.before.dir,'evidence/manifest.json')),manifest);
 assert.equal((await advance(f)).state.current_step,'c');assert.equal((await advance(f)).state.status,'completed');assert.equal(validateRunStateConsistency(f.before.definition,(await loadRun(f.runId,f.cwd)).state).definition.version,'skip');
});

test('opt-in adds immediate future stage and real gates visit it; historical passes remain unchanged',async t=>{
 const f=await fixture(t);await advance(f);const before=await loadRun(f.runId,f.cwd),next=structuredClone(before.definition);next.version='after-a';next.steps[1].next='new';next.steps.splice(2,0,{id:'new',next:'c'});next.gates['new-gate']={step:'new',expects:[expectation]};
 await amendRunDefinition(f.runId,{cwd:f.cwd,definition:next,request:request(before,next)});const after=await loadRun(f.runId,f.cwd);assert.deepEqual(after.state.gate_outcomes,before.state.gate_outcomes);assert.deepEqual(after.state.transitions,before.state.transitions);
 assert.equal((await advance(f)).state.current_step,'new');assert.equal((await advance(f)).state.current_step,'c');assert.equal((await advance(f)).state.status,'completed');
});

test('mode refuses current gate/needs edits, historical edits and redirects into visited work',async t=>{
 const f=await fixture(t);await advance(f);const before=await loadRun(f.runId,f.cwd);
 for(const mutate of [next=>{next.gates['b-gate'].expects=[{...expectation,id:'changed'}];},next=>{next.steps[1].needs=['a'];},next=>{next.steps[0].next='c';},next=>{next.steps[1].next='a';next.steps[1].needs=[];}]){const next=structuredClone(before.definition);next.version='bad';mutate(next);await assert.rejects(amendRunDefinition(f.runId,{cwd:f.cwd,definition:next,request:request(before,next)}),/compatibility.invalid/);}
 assert.deepEqual((await loadRun(f.runId,f.cwd)).state,before.state);
});

test('mode cannot change a consumed edge after genuine route-back revisits current step',async t=>{
 const def=definition();def.gates['b-gate']={step:'b',expects:[{...expectation,id:'required'}],on_route_back:{default:'a'},route_back_policy:{max_attempts:3,on_exceeded:'block'}};const f=await fixture(t,def);await advance(f);const failureFile=path.join(f.cwd,'failure.txt');await writeFile(failureFile,'Observed failing fixture');await attachEvidence(f.runId,{cwd:f.cwd,gate:'b-gate',file:failureFile,status:'failed'});await evaluateRun(f.runId,{cwd:f.cwd});const before=await loadRun(f.runId,f.cwd);assert.equal(before.state.current_step,'a');const next=add(before.definition);
 await assert.rejects(amendRunDefinition(f.runId,{cwd:f.cwd,definition:next,request:request(before,next)}),/consumed transition history/);
});

test('active claims refuse amendment; released future target remains started and cannot be bypassed',async t=>{
 const def=definition();def.execution={mode:'multi-cursor',claim_contract_version:'1'};def.steps[1].needs=[];for(const step of def.steps)step.mutable_resources=[];def.steps[1].mutable_resources=['source/workspace'];const f=await fixture(t,def),actor={key:'test-worker'};const claimed=await claimReadyStep(f.runId,{cwd:f.cwd,step_id:'b',claim_id:'claim-b',liveness_id:'live-b',actor,lease_seconds:300,mutable_resources:['source/workspace']});
 let before=await loadRun(f.runId,f.cwd),next=skip(before.definition);await assert.rejects(amendRunDefinition(f.runId,{cwd:f.cwd,definition:next,request:request(before,next)}),/active multi-cursor claim/);
 await releaseStepClaim(f.runId,{cwd:f.cwd,claim_id:claimed.claim.claim_id,liveness_id:claimed.claim.liveness_id,actor,reason:'stop before replan'});before=await loadRun(f.runId,f.cwd);next=skip(before.definition);await assert.rejects(amendRunDefinition(f.runId,{cwd:f.cwd,definition:next,request:request(before,next)}),/started or historical step b|removes persisted step b/);
});

test('future attached evidence protects its stage; rejected delta keeps the manifest',async t=>{
 const def=definition();def.execution={mode:'multi-cursor',claim_contract_version:'1'};def.steps[1].needs=[];for(const step of def.steps)step.mutable_resources=[];def.steps[1].mutable_resources=['source/workspace'];const f=await fixture(t,def);const file=path.join(f.cwd,'observed.txt');await writeFile(file,'Observed fixture evidence');await attachEvidence(f.runId,{cwd:f.cwd,gate:'b-gate',file,status:'failed'});const before=await loadRun(f.runId,f.cwd),manifest=await readFile(path.join(before.dir,'evidence/manifest.json')),next=skip(before.definition);
 await assert.rejects(amendRunDefinition(f.runId,{cwd:f.cwd,definition:next,request:request(before,next)}),/started or historical step b|removes persisted step b/);assert.deepEqual(await readFile(path.join(before.dir,'evidence/manifest.json')),manifest);
});

test('same-head edge amendment race commits one successor; injected publication fault leaves old canonical head',async t=>{
 const f=await fixture(t),left=add(),right=skip();
 await assert.rejects(amendRunDefinition(f.runId,{cwd:f.cwd,definition:left,request:request(f.before,left,'fault'),faultInjection(stage){if(stage==='before_rename_state')throw new Error('injected fault');}}),/injected fault/);assert.deepEqual((await loadRun(f.runId,f.cwd)).state,f.before.state);
 const outcomes=await Promise.allSettled([amendRunDefinition(f.runId,{cwd:f.cwd,definition:left,request:request(f.before,left,'left')}),amendRunDefinition(f.runId,{cwd:f.cwd,definition:right,request:request(f.before,right,'right')})]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected'&&/run_head.stale/.test(String(x.reason))).length,1);assert.equal((await loadRun(f.runId,f.cwd)).state.definition_amendments.length,1);
});

test('claim admission racing a pending edge removal cannot both commit',async t=>{
 const def=definition();def.execution={mode:'multi-cursor',claim_contract_version:'1'};def.steps[1].needs=[];for(const step of def.steps)step.mutable_resources=[];const f=await fixture(t,def),next=skip(def);
 const outcomes=await Promise.allSettled([
  amendRunDefinition(f.runId,{cwd:f.cwd,definition:next,request:request(f.before,next,'race-with-claim')}),
  claimReadyStep(f.runId,{cwd:f.cwd,step_id:'b',claim_id:'racing-b',liveness_id:'racing-live',actor:{key:'racing-host'},lease_seconds:300})
 ]);
 assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);const after=await loadRun(f.runId,f.cwd);
 if(after.state.definition_amendments?.length)assert.equal(after.state.multi_cursor?.active_claims.length??0,0);
 else assert.equal(after.state.multi_cursor.active_claims[0].step_id,'b');
});

test('pending amendment ledger rejects missing protected-step proof and unsupported mode',async t=>{
 const f=await fixture(t),next=add(),auth=request(f.before,next);
 await assert.rejects(amendRunDefinition(f.runId,{cwd:f.cwd,definition:next,request:{...auth,compatibility_mode:'force'}}),/unsupported compatibility mode/);
 await amendRunDefinition(f.runId,{cwd:f.cwd,definition:next,request:auth});const after=await loadRun(f.runId,f.cwd),corrupt=structuredClone(after.state);delete corrupt.definition_amendments[0].protected_steps;
 assert.throws(()=>validateRunStateConsistency(f.before.definition,corrupt),/protected_steps|protected steps/);
 const gateChange=structuredClone(after.definition);gateChange.version='gate-change';gateChange.gates['a-new']={step:'a',expects:[expectation]};
 await assert.rejects(amendRunDefinition(f.runId,{cwd:f.cwd,definition:gateChange,request:request(after,gateChange,'current-gate-add')}),/adds a gate to protected step a/);
});

test('preserving a started distant node as disconnected data cannot bypass it',async t=>{
 const def=definition();def.execution={mode:'multi-cursor',claim_contract_version:'1'};def.steps[2].needs=[];for(const step of def.steps)step.mutable_resources=[];const f=await fixture(t,def),actor={key:'distant-host'};
 const claim=await claimReadyStep(f.runId,{cwd:f.cwd,step_id:'c',claim_id:'distant-c',liveness_id:'distant-live',actor,lease_seconds:300});await releaseStepClaim(f.runId,{cwd:f.cwd,claim_id:claim.claim.claim_id,liveness_id:claim.claim.liveness_id,actor});
 const before=await loadRun(f.runId,f.cwd),next=structuredClone(before.definition);next.version='disconnect';next.steps[0].next=null;
 await assert.rejects(amendRunDefinition(f.runId,{cwd:f.cwd,definition:next,request:request(before,next,'disconnect-started')}),/bypasses started or historical step c/);
});
