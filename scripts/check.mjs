#!/usr/bin/env node
import { readdirSync,readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../src/contracts.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));let files=0;
const targets=['src','extension'].flatMap(dir=>readdirSync(join(root,dir)).filter(name=>name.endsWith('.mjs')).map(name=>join(dir,name)));
targets.push('scripts/check.mjs','scripts/measure.mjs','scripts/live-probe.mjs','scripts/upgrade-check.mjs','tests/helpers.mjs','tests/runtime.test.mjs','tests/extension.test.mjs','tests/memory.test.mjs');
for(const path of targets){execFileSync(process.execPath,['--check',join(root,path)],{stdio:'pipe'});files++;}
config(JSON.parse(readFileSync(join(root,'config/runtime.json'),'utf8')));
console.log(JSON.stringify({check:'syntax-and-config',files,status:'passed',scope:'JavaScript parser and runtime options; not an OMP SDK build or live tool integration'}));
