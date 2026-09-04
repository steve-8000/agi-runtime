import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ContractCounters } from "./runtime-types.ts";

/** Bumped whenever this extension starts depending on a new part of OMP's extension surface. */
export const CONTRACT = 2;

/** Members of `ExtensionAPI` / `ExtensionContext` this extension calls. Probed at load, recorded per OMP version. */
const API_MEMBERS = ["on", "registerTool", "registerCommand", "setLabel", "zod", "logger", "pi"] as const;
const HOST_MEMBERS = ["VERSION", "getAgentDir"] as const;
const CONTEXT_MEMBERS = ["hasUI", "cwd", "sessionManager.getSessionId", "ui.select", "ui.notify", "setInterval", "clearTimer", "abort"] as const;
/** Events the kernel consumes; a host that stops emitting one shows up in the counters, not here. */
export const EVENTS = ["session_start", "session_switch", "session_shutdown", "goal_updated", "before_agent_start",
	"tool_call", "tool_execution_start", "tool_result", "tool_execution_end"] as const;

export interface Probe {
	present: string[];
	missing: string[];
}

function has(target: unknown, path: string): boolean {
	let current: unknown = target;
	for (const key of path.split(".")) {
		if (current === null || (typeof current !== "object" && typeof current !== "function") || !(key in current)) return false;
		current = (current as Record<string, unknown>)[key]; // narrowed by the `in` check above
	}
	return current !== undefined;
}
function probe(target: unknown, members: readonly string[]): Probe {
	const present: string[] = [], missing: string[] = [];
	for (const member of members) (has(target, member) ? present : missing).push(member);
	return { present, missing };
}

export function probeApi(pi: ExtensionAPI): Probe {
	const api = probe(pi, API_MEMBERS);
	const host = probe(pi.pi, HOST_MEMBERS);
	return { present: [...api.present, ...host.present.map(x => `pi.${x}`)], missing: [...api.missing, ...host.missing.map(x => `pi.${x}`)] };
}
export function probeContext(ctx: ExtensionContext): Probe {
	return probe(ctx, CONTEXT_MEMBERS);
}
export function hostVersion(pi: ExtensionAPI): string {
	const host: unknown = pi.pi;
	if (host && typeof host === "object" && "VERSION" in host && typeof host.VERSION === "string") return host.VERSION;
	return "unknown";
}
export function hostAgentDir(pi: ExtensionAPI): string | undefined {
	const host: unknown = pi.pi;
	if (host && typeof host === "object" && "getAgentDir" in host && typeof host.getAgentDir === "function") {
		const dir: unknown = host.getAgentDir();
		if (typeof dir === "string") return dir;
	}
	return undefined;
}

export interface CompatReport {
	contract: number;
	version: string;
	at: string;
	verdict: "ok" | "degraded";
	api: Probe;
	context?: Probe;
	counters?: ContractCounters;
	attachError?: string;
}

/** One report per OMP version under ~/.omp/runtime/compat. `omp upgrade` → next session rewrites it; `scripts/doctor.mjs` reads it. */
export function writeCompatReport(layout: { compat: string }, input: Omit<CompatReport, "contract" | "at" | "verdict">): string {
	const counters = input.counters;
	const degraded = input.api.missing.length > 0 || (input.context?.missing.length ?? 0) > 0 || !!input.attachError
		|| (!!counters && (counters.unmatchedStarts > 0 || counters.unmatchedResults > 0));
	const report: CompatReport = { contract: CONTRACT, at: new Date().toISOString(), verdict: degraded ? "degraded" : "ok", ...input };
	mkdirSync(layout.compat, { recursive: true, mode: 0o700 });
	const path = join(layout.compat, `${input.version.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
	renameSync(temporary, path);
	return path;
}
