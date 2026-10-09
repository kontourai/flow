import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const Flow = await import(process.env.FLOW_REAPPRAISAL_PACKAGE_URL ?? '../../dist/index.js');

function bundle(runId, step, status='verified') {
  const now=new Date().toISOString();
  return {schemaVersion:5,source:'flow/reappraisal-test',claims:[{id:`${step}-claim`,subjectType:'flow-step',subjectId:`${runId}/${step}`,claimType:'execution.observed',facet:'quality',fieldOrBehavior:'observed unit output',value:status==='verified',createdAt:now,updatedAt:now,verificationPolicyId:'policy',...(status==='stale'?{expiresAt:new Date(Date.now()-1000).toISOString()}: {})}],evidence:[{id:'observation',claimId:`${step}-claim`,evidenceType:'test_output',method:'validation',sourceRef:'fixture:actual-public-api',excerptOrSummary:'Explicit fixture observation.',observedAt:now,collectedBy:'fixture'}],events:[{id:'observed',claimId:`${step}-claim`,status:status==='disputed'?'disputed':'verified',actor:'fixture',method:'validation',evidenceIds:['observation'],createdAt:now,verifiedAt:now}],policies:[{id:'policy',claimType:'execution.observed',requiredEvidence:['test_output'],requiredMethods:['validation'],acceptanceCriteria:['Observed execution'],reviewAuthority:'fixture',validityRule:{kind:'manual'},stalenessTriggers:['expiry'],conflictRules:[],impactLevel:'medium'}]};
}
async function fixture(t,{block=false}={}) {
  const cwd=await mkdtemp(path.join(tmpdir(),'flow-history-reappraisal-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const runId='history-run';
  const definition={id:'historical-reappraisal',version:'1',steps:[{id:'a',next:'b',needs:[]},{id:'b',next:'unrelated',needs:['a']},{id:'unrelated',next:null,needs:[]}],gates:Object.fromEntries(['a','b','unrelated'].map(id=>[`${id}-gate`,{step:id,expects:[{id:`${id}-completion`,kind:'trust.bundle',required:true,description:'Current bound observation.',bundle_claim:{claimType:'execution.observed',subjectId:`${runId}/${id}`,accepted_statuses:['verified']}}],...(!block?{on_route_back:{missing_evidence:id,default:id},route_back_policy:{max_attempts:2,on_exceeded:'block'}}:{})}]))};
  const file=path.join(cwd,'definition.json');await writeFile(file,JSON.stringify(definition));await Flow.startRun(file,{cwd,runId,params:{subject:runId}});
  const receipts=new Map();
  async function attach(step,status='verified') {const file=path.join(cwd,`${step}-${status}-${Math.random()}.json`);await writeFile(file,JSON.stringify(bundle(runId,step,status)));const receipt=await Flow.attachEvidence(runId,{cwd,gate:`${step}-gate`,file,kind:'trust.bundle',...(receipts.has(step)?{supersede:receipts.get(step).id}: {})});receipts.set(step,receipt);return receipt;}
  async function pass(step) {await attach(step);return Flow.evaluateRun(runId,{cwd,gate:`${step}-gate`});}
  return {cwd,runId,attach,pass,definition,receipts};
}

for(const status of ['stale','disputed'])test(`completed run reappraises ${status} prior gate from real unrelated cursor and preserves independent branch`,async t=>{
  const f=await fixture(t);await f.pass('a');await f.pass('b');await f.pass('unrelated');
  const completed=await Flow.loadRun(f.runId,f.cwd);assert.equal(completed.state.status,'completed');assert.equal(completed.state.current_step,'unrelated');
  const unrelated=completed.state.gate_outcomes.find(outcome=>outcome.gate_id==='unrelated-gate');
  await f.attach('a',status);const result=await Flow.evaluateRun(f.runId,{cwd:f.cwd,gate:'a-gate'});
  assert.equal(result.state.current_step,'a');assert.equal(result.state.status,'active');assert.equal(result.outcomes[0].status,'route-back');
  const transition=result.state.transitions.at(-1);assert.equal(transition.from_step,'unrelated');assert.equal(transition.evaluated_step,'a');assert.equal(transition.to_step,'a');assert.deepEqual(transition.invalidated_steps,['b']);
  assert.deepEqual(result.state.gate_outcomes.find(outcome=>outcome.gate_id==='unrelated-gate'),unrelated);
  assert.equal(result.state.gate_outcomes.some(outcome=>outcome.gate_id==='b-gate'&&outcome.status==='pass'),false);
  assert.equal(result.state.gate_outcomes.find(outcome=>outcome.gate_id==='unrelated-gate').status,'pass');
  assert.deepEqual(result.state.transitions.slice(0,-1),completed.state.transitions,'Historical transitions remain byte-for-byte represented');
  assert.equal((await Flow.loadRun(f.runId,f.cwd)).state.current_step,'a','Canonical persisted state passes read-side proof checks');
});

for(const cursor of ['b','unrelated'])test(`active ${cursor} cursor can reappraise occupied failed gate without manufacturing occupancy`,async t=>{
  const f=await fixture(t);await f.pass('a');if(cursor==='unrelated')await f.pass('b');
  await f.attach('a','disputed');const result=await Flow.evaluateRun(f.runId,{cwd:f.cwd,gate:'a-gate'});
  assert.equal(result.state.current_step,'a');assert.equal(result.state.transitions.at(-1).from_step,cursor);assert.equal(result.state.transitions.at(-1).evaluated_step,'a');
});

test('off-current missing evidence without an authored route blocks at the evaluated gate with truthful recovery',async t=>{
  const f=await fixture(t,{block:true});await f.pass('a');await f.pass('b');await f.pass('unrelated');await f.attach('a','stale');
  const result=await Flow.evaluateRun(f.runId,{cwd:f.cwd,gate:'a-gate'});assert.equal(result.state.status,'blocked');assert.equal(result.state.current_step,'a');
  assert.equal(result.state.transitions.at(-1).from_step,'unrelated');assert.equal(result.state.transitions.at(-1).type,'gate_reappraisal');assert.equal(result.state.transitions.at(-1).attempt,undefined);
  assert.equal(result.state.gate_outcomes.some(outcome=>outcome.gate_id==='b-gate'&&outcome.status==='pass'),false);assert.equal(result.state.gate_outcomes.find(outcome=>outcome.gate_id==='unrelated-gate').status,'pass');
});

test('off-current pass and forward never-occupied gate remain read-only refusals',async t=>{
  const f=await fixture(t);const initial=await Flow.loadRun(f.runId,f.cwd);const bytes=await readFile(path.join(initial.dir,'state.json'),'utf8');
  await assert.rejects(Flow.evaluateRun(f.runId,{cwd:f.cwd,gate:'b-gate'}),error=>error.code==='flow.evaluate.gate.not_current');assert.equal(await readFile(path.join(initial.dir,'state.json'),'utf8'),bytes);
  await f.pass('a');const current=await Flow.loadRun(f.runId,f.cwd);const advanced=await readFile(path.join(current.dir,'state.json'),'utf8');
  await assert.rejects(Flow.evaluateRun(f.runId,{cwd:f.cwd,gate:'a-gate'}),error=>error.code==='flow.evaluate.gate.not_current');assert.equal(await readFile(path.join(current.dir,'state.json'),'utf8'),advanced);
});

test('reappraisal metadata keeps the original bounded route loop identity and operator retry proof',async t=>{
  const f=await fixture(t);await f.pass('a');await f.pass('b');await f.pass('unrelated');await f.attach('a','disputed');
  const first=await Flow.evaluateRun(f.runId,{cwd:f.cwd,gate:'a-gate'}),gate=Flow.findGate(first.definition,'a-gate');
  const loop={gateId:gate.id,gate,routeReason:'missing_evidence',fromStep:'a',toStep:'a',failedEvidenceRefs:[]};
  assert.equal(Flow.routeBackAttempt(first.state,loop),1,'Moving from another cursor does not reset or double-count a replay of the same gate failure');
  assert.equal(first.state.transitions.at(-1).max_attempts,2);
  await f.pass('a');await f.pass('b');await f.pass('unrelated');
  // Explicit failed observations are fresh logical failures, not repeated polling.
  for(const attempt of [2,3]){
    const file=path.join(f.cwd,`failed-${attempt}.json`);await writeFile(file,JSON.stringify(bundle(f.runId,'a','disputed')));
    const failed = await Flow.attachEvidence(f.runId,{cwd:f.cwd,gate:'a-gate',file,kind:'trust.bundle',status:'failed',route_reason:'missing_evidence',supersede:f.receipts.get('a').id});
    f.receipts.set('a',failed);
    const evaluated=await Flow.evaluateRun(f.runId,{cwd:f.cwd,gate:'a-gate'});
    assert.equal(evaluated.outcomes[0].attempt,attempt);assert.equal(evaluated.outcomes[0].max_attempts,2);
    if(attempt===2){await f.pass('a');await f.pass('b');await f.pass('unrelated');}
    else {
      assert.equal(evaluated.outcomes[0].limit_exceeded,true);assert.equal(evaluated.state.current_step,'unrelated');
      const blocked=evaluated.state.transitions.at(-1);assert.equal(blocked.from_step,'unrelated');assert.equal(blocked.evaluated_step,'a');
      const recovered=await Flow.authorizeRetry(f.runId,{cwd:f.cwd,request:{reason:'Explicit fixture operator requests bounded retry',target_step:'a',blocked_transition_ref:Flow.flowTransitionRef(blocked),expected_run_head:Flow.flowRunHead(evaluated.state),authority:{kind:'operator_request',actor:'operator:fixture',request_ref:'request:historical-gate-retry',requested_at:new Date().toISOString()}}});
      assert.equal(recovered.state.current_step,'a');assert.equal(recovered.transition.from_step,'unrelated');assert.equal(recovered.transition.evaluated_step,'a');
      assert.equal(Flow.routeBackAttempt(recovered.state,loop),1,'Only explicit retry authorization starts a fresh bounded epoch');
      assert.equal((await Flow.loadRun(f.runId,f.cwd)).state.current_step,'a');
    }
  }
});
