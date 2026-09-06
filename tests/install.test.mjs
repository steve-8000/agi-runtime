import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readlinkSync,symlinkSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/install.mjs',import.meta.url));
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'runtime-install-')),agent=join(dir,'agent'),state=join(dir,'runtime');t.after(()=>rmSync(dir,{recursive:true,force:true}));return{dir,agent,state,link:join(agent,'extensions','agi-runtime'),run:(...args)=>JSON.parse(execFileSync(process.execPath,[script,'--agent-dir',agent,...args],{env:{...process.env,OMP_RUNTIME_DIR:state,OMP_RUNTIME_CONFIG:join(state,'config.json')},encoding:'utf8',stdio:['ignore','pipe','pipe']}))};}
test('installation defaults to a read-only plan',t=>{const f=fixture(t);assert.equal(f.run().changed,false);assert.equal(existsSync(f.agent),false);assert.equal(existsSync(f.state),false);});
test('explicit activation and rollback preserve config and use only one extension link',t=>{const f=fixture(t),old=join(f.dir,'old');mkdirSync(old);writeFileSync(join(old,'package.json'),'{"name":"@clab/omp-agi-runtime"}');mkdirSync(join(f.agent,'extensions'),{recursive:true});symlinkSync(old,f.link);mkdirSync(f.state);const config='{"maxWallMs":3600000,"old":"kept"}\n';writeFileSync(join(f.state,'config.json'),config);assert.equal(f.run('--activate').changed,true);assert.equal(readFileSync(join(f.state,'config.json'),'utf8'),config);assert.equal(f.run('--activate').changed,false);assert.equal(f.run('--rollback').changed,true);assert.equal(resolve(readlinkSync(f.link)),old);});
test('a foreign regular file at the extension target is never overwritten',t=>{const f=fixture(t);mkdirSync(join(f.agent,'extensions'),{recursive:true});writeFileSync(f.link,'foreign');assert.throws(()=>f.run('--activate'));assert.equal(readFileSync(f.link,'utf8'),'foreign');});
test('a different extension package is never replaced',t=>{const f=fixture(t),old=join(f.dir,'foreign');mkdirSync(old);writeFileSync(join(old,'package.json'),'{"name":"unrelated"}');mkdirSync(join(f.agent,'extensions'),{recursive:true});symlinkSync(old,f.link);assert.throws(()=>f.run('--activate'));assert.equal(readlinkSync(f.link),old);});
