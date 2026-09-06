#!/usr/bin/env node
// Explicit activation only. The default is a read-only plan. Never load two runtime versions.
import {existsSync,lstatSync,readlinkSync,realpathSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,renameSync,unlinkSync,copyFileSync,chmodSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
const argv=process.argv.slice(2),root=realpathSync(fileURLToPath(new URL('../',import.meta.url)));
let agentDir=process.env.PI_CODING_AGENT_DIR??join(homedir(),'.omp','agent'),action='plan';
for(let i=0;i<argv.length;i++){
 if(argv[i]==='--agent-dir'&&argv[i+1])agentDir=resolve(argv[++i]);
 else if(argv[i]==='--activate'&&action==='plan')action='activate';
 else if(argv[i]==='--rollback'&&action==='plan')action='rollback';
 else throw new Error(`Unknown or conflicting argument: ${argv[i]}`);
}
const state=resolve(process.env.OMP_RUNTIME_DIR??join(dirname(agentDir),'runtime'));
const target=join(agentDir,'extensions','agi-runtime'),record=join(state,'activation.json');
const linkInfo=()=>{try{const stat=lstatSync(target);if(!stat.isSymbolicLink())throw new Error('FOREIGN_FILE_AT_EXTENSION_TARGET');return resolve(dirname(target),readlinkSync(target));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
let current=linkInfo(),changed=false;
if(action==='activate'&&current!==root){
 if(current){const pkg=JSON.parse(readFileSync(join(current,'package.json'),'utf8'));if(pkg.name!=='@clab/omp-agi-runtime')throw new Error('FOREIGN_EXTENSION_AT_TARGET');}
 mkdirSync(dirname(target),{recursive:true});mkdirSync(state,{recursive:true,mode:0o700});
 const cp=process.env.OMP_RUNTIME_CONFIG??join(state,'config.json');
 if(!existsSync(cp)){mkdirSync(dirname(cp),{recursive:true,mode:0o700});copyFileSync(join(root,'config/runtime.json'),cp);chmodSync(cp,0o600);}
 writeFileSync(record,JSON.stringify({previousTarget:current,candidate:root},null,2)+'\n',{mode:0o600});
 const temp=`${target}.${process.pid}.tmp`;try{symlinkSync(root,temp,'dir');renameSync(temp,target);}finally{try{unlinkSync(temp);}catch{}}
 current=linkInfo();changed=true;
}else if(action==='rollback'){
 const saved=JSON.parse(readFileSync(record,'utf8'));
 if(current!==saved.candidate)throw new Error('TARGET_CHANGED_SINCE_ACTIVATION');
 if(saved.previousTarget){const temp=`${target}.${process.pid}.tmp`;try{symlinkSync(saved.previousTarget,temp,'dir');renameSync(temp,target);}finally{try{unlinkSync(temp);}catch{}}}
 else unlinkSync(target);
 current=linkInfo();changed=true;
}
console.log(JSON.stringify({action,candidate:root,target,current,runtimeDir:state,changed,preserved:['OMP config.yml','AGENTS.md','Kubernetes approval hook','MCP credentials','journal data'],note:'Restart the OMP process to load a different extension version. No running process was altered.'},null,2));
