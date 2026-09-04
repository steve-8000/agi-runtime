/**
 * Minimal declaration of the OMP extension surface this package depends on.
 *
 * At runtime OMP's loader resolves `@oh-my-pi/pi-coding-agent` to the host-bundled package; this
 * file only exists so `tsc --noEmit` can check extension/ without a source checkout. Shapes were
 * transcribed from packages/coding-agent/src/extensibility/extensions/types.ts and
 * shared-events.ts at the tag recorded in compat/tested-versions.json. It is deliberately narrow:
 * anything not listed here is not part of the contract this extension relies on.
 */
declare module "@oh-my-pi/pi-coding-agent" {
	export type TextContent = { type: "text"; text: string };
	export type ImageContent = { type: "image"; data: string; mimeType: string };
	export interface AgentToolResult<TDetails = unknown> {
		content: (TextContent | ImageContent)[];
		details?: TDetails;
		isError?: boolean;
	}

	export interface ExtensionUIContext {
		select(title: string, options: string[], dialogOptions?: unknown): Promise<string | undefined>;
		confirm(title: string, message: string, dialogOptions?: unknown): Promise<boolean>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
	}
	export interface ReadonlySessionManager {
		getSessionId(): string;
	}
	export interface ExtensionContext {
		ui: ExtensionUIContext;
		hasUI: boolean;
		cwd: string;
		sessionManager: ReadonlySessionManager;
		abort(): void;
		setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): unknown;
		setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): unknown;
		clearTimer(timer: unknown): void;
	}
	export interface ExtensionCommandContext extends ExtensionContext {
		waitForIdle(): Promise<void>;
	}

	export interface SessionEvent { type: "session_start" | "session_switch" | "session_shutdown" }
	export interface GoalUpdatedEvent { type: "goal_updated"; goal: { id?: string; status?: string } | null }
	export interface BeforeAgentStartEvent { type: "before_agent_start"; prompt: string; systemPrompt: string[] }
	export interface BeforeAgentStartEventResult {
		message?: { customType: string; content: string; display?: boolean };
		systemPrompt?: string[];
	}
	export interface ToolCallEvent { type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown> }
	export interface ToolCallEventResult { block?: boolean; reason?: string; input?: unknown }
	export interface ToolResultEvent {
		type: "tool_result"; toolCallId: string; toolName: string; input: Record<string, unknown>;
		content: (TextContent | ImageContent)[]; details: unknown; isError: boolean;
	}
	export interface ToolResultEventResult { content?: (TextContent | ImageContent)[]; details?: unknown; isError?: boolean }
	export interface ToolExecutionStartEvent { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	export interface ToolExecutionEndEvent { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }

	type Handler<E, R = void> = (event: E, ctx: ExtensionContext) => R | undefined | void | Promise<R | undefined | void>;

	export interface ZodLike {
		object(shape: Record<string, unknown>): unknown;
		string(): unknown;
		number(): { int(): { min(n: number): unknown } };
		array(item: unknown): unknown;
		enum(values: readonly string[]): unknown;
	}
	export interface ToolDefinition<TParams = Record<string, never>> {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		approval?: "read" | "write" | "exec";
		execute(toolCallId: string, params: TParams, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult>;
	}
	export interface CommandDefinition {
		description: string;
		handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
	}
	export interface HostPackage {
		VERSION: string;
		getAgentDir(): string;
	}
	export interface ExtensionAPI {
		on(event: "session_start" | "session_switch" | "session_shutdown", handler: Handler<SessionEvent>): void;
		on(event: "goal_updated", handler: Handler<GoalUpdatedEvent>): void;
		on(event: "before_agent_start", handler: Handler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
		on(event: "tool_call", handler: Handler<ToolCallEvent, ToolCallEventResult>): void;
		on(event: "tool_result", handler: Handler<ToolResultEvent, ToolResultEventResult>): void;
		on(event: "tool_execution_start", handler: Handler<ToolExecutionStartEvent>): void;
		on(event: "tool_execution_end", handler: Handler<ToolExecutionEndEvent>): void;
		registerTool<TParams>(tool: ToolDefinition<TParams>): void;
		registerCommand(name: string, command: CommandDefinition): void;
		setLabel(label: string): void;
		zod: ZodLike;
		logger: { error?(message: string): void; warn?(message: string): void; info?(message: string): void };
		pi: HostPackage;
	}
}
