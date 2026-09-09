#!/usr/bin/env node
// Compile the public API consumed by this extension against an explicitly pinned OMP checkout.
// This is an SDK type compatibility check, not a live model or host approval probe.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/check-omp-contract.mjs OMP_CHECKOUT');
const root=path.resolve(process.argv[2]);
const scratch=await mkdtemp(path.join(root,'.runtime-contract-'));
try {
  const types=path.join(root,'packages/coding-agent/src/extensibility/extensions/types.ts');
  await writeFile(path.join(scratch,'consumer.ts'),`import type { ExtensionAPI, ExtensionContext } from ${JSON.stringify(types)};
declare const api: ExtensionAPI;
declare const ctx: ExtensionContext;
const session: string = ctx.sessionManager.getSessionId();
ctx.sessionManager.getSessionFile();
const root: string = ctx.cwd;
const ui: boolean = ctx.hasUI;
ctx.clearTimer(ctx.setInterval(() => {}, 5000));
ctx.abort();
ctx.memory?.status().then(status => { const scope: string | undefined = status.scope; });
api.pi.getAgentDir();
api.logger.warn('contract');
api.on('session_start', (_event, context) => { context.sessionManager.getSessionId(); });
api.on('session_switch', () => {});
api.on('session_branch', () => {});
api.on('session_tree', () => {});
api.on('session_shutdown', () => {});
api.on('session_compact', () => {});
api.on('auto_compaction_end', () => {});
api.on('goal_updated', event => { event.goal; });
api.on('tool_call', event => { event.toolName; event.toolCallId; event.input; return { block: true, reason: 'advisory' }; });
api.on('tool_execution_start', event => { event.args; event.toolCallId; event.toolName; });
api.on('tool_result', event => { event.content; event.details; event.isError; });
api.on('tool_execution_end', event => { event.result; event.isError; });
api.on('turn_end', () => {});
api.on('context', event => ({ messages: event.messages }));
const parameters=api.zod.object({offset:api.zod.number().optional()});
api.registerTool({name:'contract_probe',label:'Contract',description:'Typecheck only',approval:'read',parameters,async execute(_id,params,_signal,_update,context){ context.cwd; return { content: [], details: parameters.parse(params) }; }});
api.registerCommand('contract_probe',{description:'Typecheck only',async handler(args,context){args.trim();context.abort();}});
void session;void root;void ui;
`);
  await writeFile(path.join(scratch,'tsconfig.json'),JSON.stringify({extends:path.join(root,'packages/coding-agent/tsconfig.json'),compilerOptions:{noUnusedLocals:false,noUnusedParameters:false},include:['consumer.ts'],exclude:[]}));
  execFileSync(path.join(root,'node_modules/.bin/tsgo'),['-p',path.join(scratch,'tsconfig.json'),'--noEmit'],{stdio:'inherit',cwd:root});
  const pkg=JSON.parse(await readFile(path.join(root,'packages/coding-agent/package.json'),'utf8'));
  console.log(JSON.stringify({status:'PASS',ompVersion:pkg.version,scope:'Public extension API type compatibility only; no live model or native approval execution'}));
} finally { await rm(scratch,{recursive:true,force:true}); }
