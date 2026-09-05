import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { RuntimeStore } from "../src/store.mjs";
import { RuntimeKernel } from "../src/kernel.mjs";
import { captureEvidence, verifyEvidence } from "../src/evidence.mjs";
import { check, RuntimeFault } from "../src/util.mjs";
import { runtimeLayout, journalPath, loadRuntimeConfig, defaultAgentDir } from "../src/paths.mjs";
import { probeApi, probeContext, writeCompatReport, hostVersion, hostAgentDir, CONTRACT } from "./compat.ts";
import type { Lease, ConfirmRequest, UncertainAction } from "./runtime-types.ts";

// AGI runtime for OMP as an extension, not a fork.
//
// Everything this layer does rides on OMP's public extension surface (tool_call / tool_result /
// tool_execution_* / turn_start / agent_end / goal_updated / session_*), so `brew upgrade omp`
// replaces the binary and this directory keeps loading. No core file is patched. If an upgrade
// changes the contract, the compat probe records it under ~/.omp/runtime/compat/<version>.json and
// the kernel degrades to observation; with OMP_RUNTIME_REQUIRED=1 it fails closed instead.
//
// Authority: the agent holds it. The runtime is observer, gatekeeper and ledger — it forces the
// procedure (recall before the first effect, read-back before a retry, a current citation before an
// uncertain write is closed by reading the record back) and never starts a turn of its own. The only human approval left
// is Kubernetes outside clab-cluster, which kubernetes-approval.ts and the structured policy own.
//
// State lives in ~/.omp/runtime (journals, compat reports, operator config). Nothing is written
// into the workspace, and nothing here is canonical memory - gbrain holds that.

const REQUIRED = process.env.OMP_RUNTIME_REQUIRED === "1";

type Ctx = ExtensionContext;

export default function agiRuntime(pi: ExtensionAPI): void {
	const z = pi.zod;
	const api = probeApi(pi);
	if (typeof pi.setLabel === "function") pi.setLabel("AGI Runtime");
	const version = hostVersion(pi);
	const layout = runtimeLayout(hostAgentDir(pi) ?? defaultAgentDir());

	let kernel: RuntimeKernel | undefined;
	let store: RuntimeStore | undefined;
	let lease: Lease | undefined;
	let timer: unknown;
	let activeCtx: Ctx | undefined;
	let attachError: string | undefined;
	let resumeCard = false;

	const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
	const requireKernel = () => { check(kernel, "RUNTIME_NOT_READY", attachError ?? "runtime is not attached"); return kernel!; };
	const fault = (error: unknown) => error instanceof RuntimeFault ? `${error.code}: ${error.message}` : String((error as Error)?.message ?? error);
	const report = () => writeCompatReport(layout, { version, api, context: activeCtx ? probeContext(activeCtx) : undefined, counters: kernel?.counters, attachError });

	async function attach(ctx: Ctx): Promise<void> {
		if (store) await detach();
		attachError = undefined;
		const missing = [...api.missing, ...probeContext(ctx).missing];
		check(missing.length === 0, "EXTENSION_CONTRACT_MISMATCH", `OMP ${version} lacks ${missing.join(", ")}`);
		const config = loadRuntimeConfig(layout);
		const session = ctx.sessionManager.getSessionId();
		const opened = await RuntimeStore.open(journalPath(layout, ctx.cwd));
		try {
			const workspace = opened.workspace(ctx.cwd);
			lease = opened.acquire(workspace.id, session, { hasUI: ctx.hasUI });
			store = opened;
		} catch (error) { opened.close(); throw error; }
		activeCtx = ctx;
		kernel = new RuntimeKernel({ store, lease, root: ctx.cwd, config, required: REQUIRED,
			confirm: async (request: ConfirmRequest) => {
				if (!ctx.hasUI) return false;
				const body = `도구: ${request.tool}\n입력: ${JSON.stringify(request.input, null, 2)}\n범위: ${JSON.stringify(request.operation)}\n승인 해시: ${request.actionHash}\n\n이 정확한 호출을 한 번 승인합니까?`;
				return (await ctx.ui.select(body, ["승인", "거부"])) === "승인";
			} });
		timer = ctx.setInterval(() => {
			try { store!.heartbeat(lease!); }
			catch (error) {
				// Losing the lease means another process owns the journal now. Stop journaling, keep working.
				ctx.ui.notify(`AGI Runtime: writer lease lost (${fault(error)}); continuing without the journal`, "warning");
				attachError = fault(error); if (timer) ctx.clearTimer(timer as never); kernel = undefined;
			}
		}, 5000);
		// A re-attach (resume, switch, crash recovery) is a boundary the model did not see: hand it the journal's facts once.
		resumeCard = lease!.epoch > 1;
		const state = kernel.context();
		if (state.uncertainActions.length) {
			ctx.ui.notify(`AGI Runtime: ${state.uncertainActions.length}건의 결과 불명 변경이 있습니다. 실제 상태를 읽고 runtime_reconcile 또는 /runtime reconcile <action-id|all>`, state.blockedUntilReconciled ? "warning" : "info");
		}
		report();
	}
	async function detach(): Promise<void> {
		if (!store) return;
		if (timer && activeCtx) activeCtx.clearTimer(timer as never);
		try { report(); } catch { /* best effort */ }
		try { if (lease) store.release(lease); } catch { /* an expired lease is already released */ }
		finally { store.close(); store = kernel = lease = timer = activeCtx = undefined; }
	}
	async function safeAttach(ctx: Ctx): Promise<void> {
		try { await attach(ctx); }
		catch (error) {
			attachError = fault(error);
			if (store) { try { await detach(); } catch { /* original failure remains authoritative */ } }
			try { report(); } catch { /* best effort */ }
			ctx.ui.notify(`AGI Runtime ${REQUIRED ? "blocked" : "disabled"}: ${attachError}`, REQUIRED ? "error" : "warning");
			pi.logger.error?.(`agi-runtime attach failed: ${attachError}`);
		}
	}

	pi.on("session_start", async (_event, ctx) => { await safeAttach(ctx); });
	pi.on("session_switch", async (_event, ctx) => { await safeAttach(ctx); resumeCard = true; });
	pi.on("session_shutdown", async () => { await detach(); });
	pi.on("session_compact", () => { resumeCard = true; });
	pi.on("auto_compaction_end", () => { resumeCard = true; });
	pi.on("turn_start", () => { kernel?.turnStart(); });
	pi.on("goal_updated", event => { if (kernel && store && lease) store.mirrorGoal(lease, event.goal ?? null); });
	// Notification only. The runtime never continues or blocks a stop; the user is the continuation authority.
	pi.on("agent_end", (_event, ctx) => {
		if (!kernel) return;
		const c = kernel.context();
		if (c.memory.effectsSinceNote > 0 && ctx.hasUI) ctx.ui.notify(`AGI Runtime: ${c.memory.effectsSinceNote} effects since the last canonical-memory write`, "info");
	});
	pi.on("before_agent_start", () => {
		if (!kernel) return;
		// A new prompt is a new model call even on a host that never emits turn_start: counting a turn twice only
		// delays a recall gate by one message; never counting would hold it closed for the whole session.
		kernel.turnStart();
		const c = kernel.context();
		// Compact operational facts for the model. Not permissions. `search` is the one routing hint this layer
		// carries: semantic and cross-file discovery goes to zvec first, exact and exhaustive lookups to native tools,
		// and the current source is authoritative over any index excerpt.
		const state: Record<string, unknown> = { runtime: "agi-runtime", mode: c.mode, turn: c.turn, paused: c.paused,
			uncertainActions: c.uncertainActions.length, blockedUntilReconciled: c.blockedUntilReconciled, uncertainRemote: c.uncertainRemote,
			usage: { toolCalls: c.toolCalls, effects: c.effectsUsed }, checkpoint: c.checkpoint,
			recall: c.recall, memory: c.memory, discovery: c.discovery,
			search: { semanticDiscovery: "mcp__zvec_grep_search", exactAndExhaustive: "native grep/rg/lsp", authority: "current source, not index excerpts", root: c.search.root, index: c.search.index } };
		if (resumeCard && store && lease) {
			resumeCard = false;
			state.resume = { epoch: c.epoch, nativeGoal: c.nativeGoal, effectsSinceNote: c.memory.effectsSinceNote,
				uncertain: (c.uncertainActions as UncertainAction[]).map(x => ({ id: x.id.slice(0, 12), tool: x.tool })), recent: store.recentActions(lease.session) };
		}
		return { message: { customType: "agi-runtime-state", content: JSON.stringify(state), display: false } };
	});

	// ---- execution boundary -------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		// REQUIRED means "this host must be able to journal", which is a contract question. A stale
		// operator config or a second session holding the writer lease must not stop the work.
		if (!kernel) return REQUIRED && api.missing.length ? { block: true, reason: `RUNTIME_HANDLER_REQUIRED: ${attachError ?? "not attached"}` } : undefined;
		return kernel.intent({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, hasUI: ctx.hasUI }) as never;
	});
	pi.on("tool_execution_start", event => { kernel?.revise(event.toolCallId, event.toolName, event.args); });
	pi.on("tool_result", event => {
		try { kernel?.settle(event.toolCallId, event.toolName, { result: { content: event.content, details: event.details }, isError: event.isError, phase: "result" }); }
		catch (error) { activeCtx?.ui.notify(`AGI Runtime journal failure: ${fault(error)}`, "error"); }
	});
	pi.on("tool_execution_end", event => {
		try { kernel?.settle(event.toolCallId, event.toolName, { result: event.result, isError: event.isError, phase: "end" }); }
		catch (error) { activeCtx?.ui.notify(`AGI Runtime journal failure: ${fault(error)}`, "error"); }
	});

	// ---- tools ---------------------------------------------------------------------------------
	// Registration is guarded so a host that dropped a member still loads this module: the tool_call
	// hook above is what fails closed under OMP_RUNTIME_REQUIRED, and it must be installed to do so.
	if (typeof pi.registerTool !== "function" || typeof pi.registerCommand !== "function") return;
	pi.registerTool({ name: "runtime_status", label: "Runtime Status", approval: "read",
		description: "Read AGI runtime operational state: pause, uncertain effects awaiting reconciliation, recall and memory state, usage and contract counters.", parameters: z.object({}),
		async execute() { return text(requireKernel().context()); } });
	pi.registerTool({ name: "runtime_evidence", label: "Verify Source Evidence", approval: "read",
		description: "Read and hash a current workspace file range. Rejects secret paths and symlinks. Returns an evidence receipt id, not permission or truth.",
		parameters: z.object({ path: z.string(), start: z.number().int().min(1), end: z.number().int().min(1) }),
		async execute(_id, params: { path: string; start: number; end: number }) {
			const k = requireKernel(); const record = captureEvidence(k.root, params.path, params.start, params.end);
			return text({ evidenceId: store!.saveEvidence(lease!, record), ...record });
		} });
	pi.registerTool({ name: "runtime_checkpoint", label: "Runtime Checkpoint", approval: "write",
		description: "Save a concise operational checkpoint bound to evidence receipts. NOT canonical memory; does not complete an OMP goal.",
		parameters: z.object({ summary: z.string(), nextAction: z.string(), evidenceIds: z.array(z.string()) }),
		async execute(_id, params: { summary: string; nextAction: string; evidenceIds: string[] }) {
			requireKernel(); store!.assertEvidence(lease!.workspace, params.evidenceIds);
			store!.checkpoint(lease!, params); return text({ saved: true });
		} });
	pi.registerTool({ name: "runtime_reconcile", label: "Reconcile Uncertain Effects", approval: "write",
		description: "Close uncertain (unknown-outcome) effects after reading back the real target state: the working tree, git, or the memory record itself. State what was observed; this is an attestation, never a retry. Optional evidence receipt ids support it.",
		parameters: z.object({ actionIds: z.array(z.string()), observed: z.string(), evidenceIds: z.array(z.string()) }),
		async execute(_id, params: { actionIds: string[]; observed: string; evidenceIds: string[] }) {
			const k = requireKernel(); store!.discoverLapsed(lease!.workspace);
			const pending: UncertainAction[] = store!.unknownActions(lease!.workspace);
			const targets = params.actionIds.includes("all") ? pending : pending.filter(x => params.actionIds.some(id => x.id === id || (id.length >= 12 && x.id.startsWith(id))));
			check(targets.length > 0, "ACTION_STATE_CONFLICT", "no matching uncertain action");
			if (params.evidenceIds.length) { store!.assertEvidence(lease!.workspace, params.evidenceIds); for (const id of params.evidenceIds) check(verifyEvidence(k.root, store!.evidence(id)!.record), "STALE_EVIDENCE"); }
			for (const x of targets) store!.reconcile(lease!, x.id, params.evidenceIds, { by: "session", observed: params.observed });
			return text({ reconciled: targets.map(x => x.id), remaining: store!.unknownActions(lease!.workspace).length });
		} });

	// ---- operator commands ---------------------------------------------------------------------
	pi.registerCommand("runtime", {
		description: "AGI runtime: /runtime status|pause|resume|reconcile <id|all> [evidence…]|recall skip|compat",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [command = "status", target, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (command === "compat") { const path = report(); ctx.ui.notify(`compat report: ${path}\ncontract v${CONTRACT}, OMP ${version}, missing: ${api.missing.join(", ") || "none"}`, api.missing.length ? "warning" : "info"); return; }
				const k = requireKernel();
				if (command === "pause") { k.paused = true; ctx.abort(); }
				else if (command === "resume") { check(!k.config.blockOnUnknown || !k.context().blockedUntilReconciled, "RECONCILIATION_REQUIRED"); k.paused = false; }
				else if (command === "reconcile") {
					check(ctx.hasUI, "INTERACTIVE_APPROVAL_REQUIRED"); check(target, "USAGE", "/runtime reconcile <action-id|all> [evidence-id…]");
					store!.discoverLapsed(lease!.workspace);
					const pending: UncertainAction[] = store!.unknownActions(lease!.workspace).filter((x: UncertainAction) => target === "all" || x.id === target);
					check(pending.length > 0, "ACTION_STATE_CONFLICT", "no matching uncertain action");
					if (rest.length) { store!.assertEvidence(lease!.workspace, rest); for (const id of rest) check(verifyEvidence(k.root, store!.evidence(id)!.record), "STALE_EVIDENCE"); }
					const prompt = `실제 대상 상태를 확인했고, 자동 재실행 없이 아래 ${pending.length}건의 불확실성을 해소했습니까?\n${pending.map(x => `${x.id} ${x.tool} ${x.input_hash.slice(0, 12)} (session ${x.session.slice(0, 8)})`).join("\n")}`;
					if ((await ctx.ui.select(prompt, ["확인 완료", "취소"])) !== "확인 완료") return;
					for (const x of pending) store!.reconcile(lease!, x.id, rest, { by: "session", observed: "operator confirmed via /runtime reconcile" });
				} else if (command === "recall") {
					check(ctx.hasUI, "INTERACTIVE_APPROVAL_REQUIRED"); check(target === "skip", "USAGE", "/runtime recall skip");
					k.recallSkip("operator");
				} else check(command === "status", "UNKNOWN_RUNTIME_COMMAND", `unknown: ${command}`);
				ctx.ui.notify(JSON.stringify(k.context(), null, 1), "info");
			} catch (error) { ctx.ui.notify(`/runtime ${command}: ${fault(error)}`, "error"); }
		} });
}
