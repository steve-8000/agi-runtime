#!/usr/bin/env node
// Is the AGI runtime installed for the OMP on this machine, and did the last session find the contract intact?
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runtimeLayout, defaultAgentDir, loadRuntimeConfig } from '../src/paths.mjs';

const repo = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const layout = runtimeLayout(defaultAgentDir());
const tested = JSON.parse(readFileSync(join(repo, 'compat', 'tested-versions.json'), 'utf8'));
const checks = [];

const omp = spawnSync('omp', ['--version'], { encoding: 'utf8' });
const version = omp.status === 0 ? omp.stdout.trim().replace(/^omp\//, '') : null;
checks.push({ name: 'omp-binary', status: version ? 'present' : 'missing', version });
checks.push({ name: 'tested-version', status: version && tested.versions[version] ? 'tested' : 'untested', contract: tested.contract, tested: Object.keys(tested.versions) });

let link = 'absent';
try { link = lstatSync(layout.extensionLink).isSymbolicLink() ? (realpathSync(layout.extensionLink) === repo ? 'ours' : 'foreign-link') : 'foreign-file'; } catch { /* absent */ }
checks.push({ name: 'extension-link', status: link === 'ours' ? 'installed' : link, path: layout.extensionLink });

try {
  const config = loadRuntimeConfig(layout);
  checks.push({ name: 'runtime-config', status: 'valid', path: layout.config, mode: config.mode, headlessEffects: config.headlessEffects, blockOnUnknown: config.blockOnUnknown, recall: config.recall.mode });
  // Without the server's public key every receipt is telemetry: uncertain memory writes then close only by attestation.
  checks.push({ name: 'memory-receipts', status: config.memoryReceiptPublicKey ? 'verifiable' : 'attestation-only', writeTools: config.memoryWriteTools.length, publishTool: config.memoryPublishTool || null });
} catch (error) { checks.push({ name: 'runtime-config', status: 'invalid', path: layout.config, reason: error.code ?? error.message }); }

const reportPath = version ? join(layout.compat, `${version}.json`) : null;
if (reportPath && existsSync(reportPath)) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  checks.push({ name: 'compat-report', status: report.verdict, at: report.at, contract: report.contract, missing: [...report.api.missing, ...(report.context?.missing ?? [])], counters: report.counters ?? null, attachError: report.attachError ?? null });
} else checks.push({ name: 'compat-report', status: 'none', reason: 'no OMP session has loaded the extension for this version yet' });

const ready = checks.filter(x => x.name !== 'memory-receipts' && x.name !== 'tested-version').every(x => ['present', 'installed', 'valid', 'ok'].includes(x.status));
console.log(JSON.stringify({ ready, ompVersion: version, runtimeDir: layout.root, checks }, null, 2));
if (!ready) process.exitCode = 1;
