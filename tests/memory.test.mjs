import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CanonicalMemoryPort, publishCandidate, reconcileMemory } from '../src/memory.mjs';
import { fixture, code } from './helpers.mjs';

function fakePort(overrides={}) {
  const receipts=new Map(); let writes=0;
  const port=new CanonicalMemoryPort({ capabilities:{idempotency:'server-enforced',durableAck:true},validate:()=>true,
    write:async request=>{ writes++; const receipt={idempotencyKey:request.idempotencyKey,payloadHash:request.payloadHash,durable:true,remoteId:'remote-1'};receipts.set(request.idempotencyKey,receipt);return receipt;},
    lookup:async id=>receipts.get(id),...overrides });
  return {port,receipts,writes:()=>writes};
}
test('unbound memory and servers without idempotency are refused', async t=>{
  const f=await fixture(t);const id=f.candidate();
  await assert.rejects(publishCandidate(f.store,f.lease,f.root,id,null),code('MEMORY_PORT_UNBOUND'));
  assert.throws(()=>new CanonicalMemoryPort({capabilities:{}}),code('REMOTE_IDEMPOTENCY_REQUIRED'));
});
test('candidate is not canonical and cannot bypass approval', async t=>{
  const f=await fixture(t);const id=f.candidate();const p=fakePort();
  assert.equal(f.store.outbox(id).state,'candidate');
  await assert.rejects(publishCandidate(f.store,f.lease,f.root,id,p.port),code('MEMORY_NOT_APPROVED'));assert.equal(p.writes(),0);
});
test('approved fresh candidate reaches durable typed acknowledgement', async t=>{
  const f=await fixture(t);const id=f.candidate();const p=fakePort();
  f.store.setOutbox(f.lease,id,'candidate','approved');
  await publishCandidate(f.store,f.lease,f.root,id,p.port);
  assert.equal(f.store.outbox(id).state,'acked');assert.equal(p.writes(),1);
  await assert.rejects(publishCandidate(f.store,f.lease,f.root,id,p.port),code('MEMORY_NOT_APPROVED'));assert.equal(p.writes(),1);
});
test('changed evidence prevents publication before transport starts', async t=>{
  const f=await fixture(t);const id=f.candidate();const p=fakePort();
  f.store.setOutbox(f.lease,id,'candidate','approved');writeFileSync(join(f.root,'source.txt'),'different');
  await assert.rejects(publishCandidate(f.store,f.lease,f.root,id,p.port),code('STALE_MEMORY_EVIDENCE'));
  assert.equal(p.writes(),0);assert.equal(f.store.outbox(id).state,'approved');
});
test('write timeout remains unknown, never silently replays, then reconciles by read', async t=>{
  const f=await fixture(t);const id=f.candidate();let receipt,writes=0;
  const p=fakePort({write:async r=>{writes++;receipt={idempotencyKey:r.idempotencyKey,payloadHash:r.payloadHash,durable:true,remoteId:'committed-before-timeout'};await new Promise(resolve=>setTimeout(resolve,50));return receipt;},lookup:async()=>receipt});
  f.store.setOutbox(f.lease,id,'candidate','approved');
  await assert.rejects(publishCandidate(f.store,f.lease,f.root,id,p.port,{timeoutMs:10}));
  assert.equal(f.store.outbox(id).state,'unknown');
  await assert.rejects(publishCandidate(f.store,f.lease,f.root,id,p.port),code('MEMORY_NOT_APPROVED'));
  assert.equal((await reconcileMemory(f.store,f.lease,id,p.port)).state,'acked');assert.equal(writes,1);
});
test('missing remote receipt is not permission to retry', async t=>{
  const f=await fixture(t);const id=f.candidate();const p=fakePort({write:async()=>{throw new Error('unknown');},lookup:async()=>null});
  f.store.setOutbox(f.lease,id,'candidate','approved');await assert.rejects(publishCandidate(f.store,f.lease,f.root,id,p.port));
  assert.deepEqual(await reconcileMemory(f.store,f.lease,id,p.port),{state:'unknown',retryAllowed:false});
});
test('HTTP-style success without durable receipt never becomes canonical', async t=>{
  const f=await fixture(t);const id=f.candidate();const p=fakePort({write:async()=>({isError:false})});
  f.store.setOutbox(f.lease,id,'candidate','approved');
  await assert.rejects(publishCandidate(f.store,f.lease,f.root,id,p.port),code('INVALID_MEMORY_ACK'));
  assert.equal(f.store.outbox(id).state,'unknown');
});
test('payload mismatch in read-back acknowledgement fails closed', async t=>{
  const f=await fixture(t);const id=f.candidate();const p=fakePort({write:async()=>{throw Error('lost');},lookup:async()=>({idempotencyKey:id,payloadHash:'wrong',durable:true,remoteId:'x'})});
  f.store.setOutbox(f.lease,id,'candidate','approved');await assert.rejects(publishCandidate(f.store,f.lease,f.root,id,p.port));
  await assert.rejects(reconcileMemory(f.store,f.lease,id,p.port),code('INVALID_MEMORY_ACK'));
});
test('memory candidate rejects speculative kinds and obvious credentials', async t=>{
  const f=await fixture(t);const e=f.evidence();
  assert.throws(()=>f.store.candidate(f.lease,{kind:'speculation',title:'x',content:'y',evidenceIds:[e]}),code('INVALID_MEMORY_KIND'));
  assert.throws(()=>f.store.candidate(f.lease,{kind:'decision',title:'x',content:'Bearer abcdefghijklmnopqrst',evidenceIds:[e]}),code('POSSIBLE_SECRET'));
});
test('crash during sending becomes unknown at lease takeover', async t=>{
  const f=await fixture(t);const id=f.candidate();f.store.setOutbox(f.lease,id,'candidate','approved');f.store.setOutbox(f.lease,id,'approved','sending');
  f.advance(30001);f.store.acquire(f.workspace.id,'new');assert.equal(f.store.outbox(id).state,'unknown');
});
test('schema validation cannot mutate an approved payload', async t=>{
  const f=await fixture(t);const id=f.candidate();const p=fakePort({validate:payload=>{payload.content='mutated after approval';return true;}});
  f.store.setOutbox(f.lease,id,'candidate','approved');
  await assert.rejects(publishCandidate(f.store,f.lease,f.root,id,p.port),code('MEMORY_SCHEMA_MISMATCH'));assert.equal(p.writes(),0);
});
