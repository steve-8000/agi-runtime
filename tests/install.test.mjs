import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readlinkSync,symlinkSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/install.mjs',import.meta.url));
const root=fileURLToPath(new URL('../',import.meta.url));
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'runtime-install-')),agent=join(dir,'agent'),state=join(dir,'runtime');t.after(()=>rmSync(dir,{recursive:true,force:true}));return{dir,agent,state,link:join(agent,'extensions','agi-runtime'),run:(...args)=>JSON.parse(execFileSync(process.execPath,[script,'--agent-dir',agent,...args],{env:{...process.env,OMP_RUNTIME_DIR:state,OMP_RUNTIME_CONFIG:join(state,'config.json')},encoding:'utf8',stdio:['ignore','pipe','pipe']}))};}
test('installation defaults to a read-only plan',t=>{const f=fixture(t);assert.equal(f.run().changed,false);assert.equal(existsSync(f.agent),false);assert.equal(existsSync(f.state),false);});
test('explicit activation and rollback preserve config and use only one extension link',t=>{const f=fixture(t),old=join(f.dir,'old');mkdirSync(old);writeFileSync(join(old,'package.json'),'{"name":"@clab/omp-agi-runtime"}');mkdirSync(join(f.agent,'extensions'),{recursive:true});symlinkSync(old,f.link);mkdirSync(f.state);const config='{"maxWallMs":3600000,"old":"kept"}\n';writeFileSync(join(f.state,'config.json'),config);assert.equal(f.run('--activate').changed,true);assert.equal(readFileSync(join(f.state,'config.json'),'utf8'),config);assert.equal(f.run('--activate').changed,false);assert.equal(f.run('--rollback').changed,true);assert.equal(resolve(readlinkSync(f.link)),old);});
test('a foreign regular file at the extension target is never overwritten',t=>{const f=fixture(t);mkdirSync(join(f.agent,'extensions'),{recursive:true});writeFileSync(f.link,'foreign');assert.throws(()=>f.run('--activate'));assert.equal(readFileSync(f.link,'utf8'),'foreign');});
test('a different extension package is never replaced',t=>{const f=fixture(t),old=join(f.dir,'foreign');mkdirSync(old);writeFileSync(join(old,'package.json'),'{"name":"unrelated"}');mkdirSync(join(f.agent,'extensions'),{recursive:true});symlinkSync(old,f.link);assert.throws(()=>f.run('--activate'));assert.equal(readlinkSync(f.link),old);});

test('the ompupdate installer is a fixed point and its removal restores the original rc', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ompupdate-rc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rc = join(dir, '.zshrc');
  const original = 'export PATH="$HOME/bin:$PATH"\n\n# other tool\nalias x=y\n';
  writeFileSync(rc, original);
  const install = (...args) => {
    const r = spawnSync(process.execPath, [join(root, 'scripts/install-ompupdate-alias.mjs'), '--rc', rc, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };

  const first = install();
  assert.equal(first.changed, true); assert.equal(first.hadBlock, false);
  const afterFirst = readFileSync(rc, 'utf8');
  assert.match(afterFirst, /^ompupdate\(\) \{$/m);
  assert.ok(afterFirst.startsWith(original.trimEnd()), 'existing rc content is kept verbatim');

  const second = install();
  assert.equal(second.hadBlock, true);
  assert.equal(second.changed, false, 're-installing must not rewrite the rc file');
  assert.equal(readFileSync(rc, 'utf8'), afterFirst);

  const removed = install('--uninstall');
  assert.equal(removed.changed, true);
  assert.equal(readFileSync(rc, 'utf8'), original, 'uninstall restores the rc byte for byte');
  assert.equal(install('--uninstall').changed, false, 'removing an absent block is a no-op');
});

test('an unbalanced managed block is refused instead of corrupting the rc file', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ompupdate-rc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rc = join(dir, '.zshrc');
  const broken = 'alias x=y\n# >>> ompupdate (agi-runtime) >>>\nompupdate() { :; }\n';
  writeFileSync(rc, broken);
  const r = spawnSync(process.execPath, [join(root, 'scripts/install-ompupdate-alias.mjs'), '--rc', rc], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(readFileSync(rc, 'utf8'), broken);
});
