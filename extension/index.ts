import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { RuntimeStore } from "../src/store.mjs";
import { RuntimeKernel } from "../src/kernel.mjs";
import { captureEvidence, verifyEvidence } from "../src/evidence.mjs";
import { check, RuntimeFault } from "../src/util.mjs";
import { publishCandidate, reconcileMemory, CanonicalMemoryPort } from "../src/memory.mjs";
import { runtimeLayout, journalPath, loadRuntimeConfig, defaultAgentDir } from "../src/paths.mjs";
import { probeApi, probeContext, writeCompatReport, hostVersion, hostAgentDir, CONTRACT } from "./compat.ts";
import type { Lease, ConfirmRequest, UncertainAction } from "./runtime-types.ts";

// AGI runtime for OMP as an extension, not a fork.
//
// Everything this layer does rides on OMP's public extension surface (tool_call / tool_result /
// tool_execution_* / goal_updated / session_*), so `brew upgrade omp` replaces the binary and this
// directory keeps loading. No core file is patched. If an upgrade changes the contract, the compat
// probe records it under ~/.omp/runtime/compat/<version>.json and the kernel degrades to
// observation; with OMP_RUNTIME_REQUIRED=1 it fails closed instead.
//
// State lives in ~/.omp/runtime (journals, compat reports, operator config). Nothing is written
// into the workspace, and nothing here is canonical memory - Utopia/clab-mem stays canonical.

const memoryKey = Symbol.for("clab.runtime.canonical-memory-port.v1");
const REQUIRED = process.env.OMP_RUNTIME_REQUIRED === "1";

/** A canonical-memory transport is bound by a trusted host module, never by config or model output. */
function boundMemoryPort(): CanonicalMemoryPort | undefined {
	const port: unknown = (globalThis as Record<symbol, unknown>)[memoryKey]; // symbol-keyed global slot; shape checked below
	return port instanceof CanonicalMemoryPort ? port : undefined;
}

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
			catch (error) { ctx.ui.notify(`AGI Runtime: writer lease lost (${fault(error)}); aborting`, "error"); ctx.abort(); }
		}, 5000);
		const state = kernel.context();
		if (state.uncertainActions.length) {
			ctx.ui.notify(`AGI Runtime: ${state.uncertainActions.length}건의 결과 불명 변경이 있습니다. /runtime status 확인 후 /runtime reconcile <action-id|all>`, state.blockedUntilReconciled ? "warning" : "info");
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
	pi.on("session_switch", async (_event, ctx) => { await safeAttach(ctx); });
	pi.on("session_shutdown", async () => { await detach(); });
	pi.on("goal_updated", event => { if (kernel && store && lease) store.mirrorGoal(lease, event.goal ?? null); });
	pi.on("before_agent_start", () => {
		if (!kernel) return;
		const c = kernel.context();
		// Compact operational facts for the model. Not permissions. `search` is the one routing hint this layer
		// carries: zvec-grep discovers, native tools verify; the runtime itself never touches a search's input.
		const state = { runtime: "agi-runtime", mode: c.mode, paused: c.paused, uncertainActions: c.uncertainActions.length, blockedUntilReconciled: c.blockedUntilReconciled,
			usage: { toolCalls: c.toolCalls, effects: c.effectsUsed }, checkpoint: c.checkpoint, pendingMemory: c.pendingMemory,
			search: { semanticDiscovery: "mcp__zvec_grep_search", exactAndExhaustive: "native grep/rg/lsp", authority: "current source, not index excerpts" } };
		return { message: { customType: "agi-runtime-state", content: JSON.stringify(state), display: false } };
	});

	// ---- execution boundary -------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (!kernel) return REQUIRED ? { block: true, reason: `RUNTIME_HANDLER_REQUIRED: ${attachError ?? "not attached"}` } : undefined;
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
		description: "Read AGI runtime operational state: pause, uncertain effects awaiting reconciliation, usage counters, contract counters.", parameters: z.object({}),
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
	pi.registerTool({ name: "runtime_memory_candidate", label: "Memory Candidate", approval: "write",
		description: "Stage a verified durable decision/constraint/incident/procedure/checkpoint for Utopia. Operator review (/runtime publish) is required; nothing is sent remotely here.",
		parameters: z.object({ kind: z.enum(["decision", "constraint", "incident", "procedure", "checkpoint"]), title: z.string(), content: z.string(), evidenceIds: z.array(z.string()) }),
		async execute(_id, params: { kind: string; title: string; content: string; evidenceIds: string[] }) {
			requireKernel(); return text({ candidateId: store!.candidate(lease!, params), canonical: false });
		} });

	// ---- operator commands ---------------------------------------------------------------------
	pi.registerCommand("runtime", {
		description: "AGI runtime: /runtime status|pause|resume|reconcile <id|all> [evidence…]|publish <id>|reject <id>|reconcile-memory <id>|compat",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [command = "status", target, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (command === "compat") { const path = report(); ctx.ui.notify(`compat report: ${path}\ncontract v${CONTRACT}, OMP ${version}, missing: ${api.missing.join(", ") || "none"}`, api.missing.length ? "warning" : "info"); return; }
				const k = requireKernel();
				if (command === "pause") { k.paused = true; ctx.abort(); }
				else if (command === "resume") { check(!k.config.blockOnUnknown || store!.unknownActions(lease!.workspace).length === 0, "RECONCILIATION_REQUIRED"); k.paused = false; }
				else if (command === "reconcile") {
					check(ctx.hasUI, "INTERACTIVE_APPROVAL_REQUIRED"); check(target, "USAGE", "/runtime reconcile <action-id|all> [evidence-id…]");
					const pending: UncertainAction[] = store!.unknownActions(lease!.workspace).filter((x: UncertainAction) => target === "all" || x.id === target);
					check(pending.length > 0, "ACTION_STATE_CONFLICT", "no matching uncertain action");
					if (rest.length) { store!.assertEvidence(lease!.workspace, rest); for (const id of rest) check(verifyEvidence(k.root, store!.evidence(id)!.record), "STALE_RECONCILIATION_EVIDENCE"); }
					// Human attestation, not automated proof of a remote effect's outcome.
					const prompt = `실제 대상 상태를 확인했고, 자동 재실행 없이 아래 ${pending.length}건의 불확실성을 해소했습니까?\n${pending.map(x => `${x.id} ${x.tool} ${x.input_hash.slice(0, 12)} (session ${x.session.slice(0, 8)})`).join("\n")}`;
					if ((await ctx.ui.select(prompt, ["확인 완료", "취소"])) !== "확인 완료") return;
					for (const x of pending) store!.reconcile(lease!, x.id, rest);
				} else if (command === "reconcile-memory") {
					check(ctx.hasUI, "INTERACTIVE_APPROVAL_REQUIRED"); check(target, "USAGE", "/runtime reconcile-memory <candidate-id>");
					await reconcileMemory(store!, lease!, target, boundMemoryPort());
				} else if (command === "reject") {
					check(ctx.hasUI, "INTERACTIVE_APPROVAL_REQUIRED"); check(target, "USAGE", "/runtime reject <candidate-id>");
					const row = store!.outbox(target);
					check(row?.workspace === lease!.workspace && ["candidate", "approved"].includes(row.state), "OUTBOX_STATE_CONFLICT");
					if ((await ctx.ui.select("이 메모리 후보를 폐기합니까?", ["폐기", "취소"])) !== "폐기") return;
					store!.setOutbox(lease!, target, row.state, "rejected");
				} else if (command === "publish") {
					check(ctx.hasUI, "INTERACTIVE_APPROVAL_REQUIRED"); check(target, "USAGE", "/runtime publish <candidate-id>");
					const port = boundMemoryPort();
					check(port, "MEMORY_PORT_UNBOUND", "no canonical memory transport with server-enforced idempotency is bound");
					const row = store!.outbox(target);
					check(row?.workspace === lease!.workspace && ["candidate", "approved"].includes(row.state), "MEMORY_NOT_CANDIDATE");
					if ((await ctx.ui.select(`Utopia에 이 기록을 게시합니까?\n${row.payload}`, ["게시", "취소"])) !== "게시") return;
					if (row.state === "candidate") store!.setOutbox(lease!, target, "candidate", "approved");
					await publishCandidate(store!, lease!, k.root, target, port);
				} else check(command === "status", "UNKNOWN_RUNTIME_COMMAND", `unknown: ${command}`);
				ctx.ui.notify(JSON.stringify(k.context(), null, 1), "info");
			} catch (error) { ctx.ui.notify(`/runtime ${command}: ${fault(error)}`, "error"); }
		} });
}
