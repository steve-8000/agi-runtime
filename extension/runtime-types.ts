// Named contracts for values owned by the JavaScript kernel modules in ../src.

/** Per-session writer lease returned by `RuntimeStore.acquire`. */
export interface Lease {
	workspace: string;
	session: string;
	epoch: number;
	ttl: number;
}

/** Exact-input approval request passed to the kernel's `confirm` callback. */
export interface ConfirmRequest {
	tool: string;
	input: unknown;
	operation: { kind: string };
	actionHash: string;
}

/** An effect whose outcome the journal could not observe (crash or lease lapse mid-execution). */
export interface UncertainAction {
	id: string;
	tool: string;
	input_hash: string;
	session: string;
	updated: number;
}

/** Counters the kernel keeps about the event contract it observed. */
export interface ContractCounters {
	intents: number;
	starts: number;
	results: number;
	ends: number;
	unmatchedStarts: number;
	unmatchedResults: number;
	revisions: number;
	rewrites: number;
	blocks: number;
	turns: number;
}
