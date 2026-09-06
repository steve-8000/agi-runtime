#!/usr/bin/env node
import { readdirSync,readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../src/contracts.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));let files=0;
for(const dir of ['src','extension','scripts','tests'])for(const name of readdirSync(join(root,dir)))if(name.endsWith('.mjs')){execFileSync(process.execPath,['--check',join(root,dir,name)],{stdio:'pipe'});files++;}
config(JSON.parse(readFileSync(join(root,'config/runtime.json'),'utf8')));
console.log(JSON.stringify({check:'syntax-and-config',files,status:'passed',scope:'JavaScript parser and runtime options; not an OMP SDK build or live tool integration'}));
