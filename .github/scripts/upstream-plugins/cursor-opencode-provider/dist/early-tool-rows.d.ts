/** Shown when an announced edit ends with its Run, never becoming a host tool call. */
export declare const EARLY_ROW_CLOSED = "Cursor did not finish this tool call.";
/**
 * Shown when the announced call runs as a host tool the row did not predict,
 * such as a rewrite with unchanged content, which stays a `write`. The row's
 * tool name cannot change once started (OpenCode 2 rejects a renamed call),
 * so it completes and names the call that carries on.
 */
export declare function earlyRowHandoff(toolName: string): string;
/**
 * Shown when the step ends on another call's exec while this one is still
 * running in Cursor: its exec, if any, comes in a later step under its own id.
 */
export declare const EARLY_ROW_DEFERRED = "Cursor runs this call after the step's other tool calls.";
export type EarlyRowClose = {
    kind: "abandoned";
} | {
    kind: "deferred";
} | {
    kind: "handoff";
    toolName: string;
} | {
    kind: "outcome";
    text: string;
    isError: boolean;
};
export declare function earlyRowResult(close: EarlyRowClose): {
    result: string;
    isError: boolean;
};
export declare function cursorEditFailure(filePath: string, detail: string): {
    text: string;
    isError: true;
};
/**
 * The outcome Cursor reports for an edit it finished without a write exec,
 * such as an `old_string` it could not find. The model saw this result.
 */
export declare function cursorEditOutcome(toolCall: unknown, filePath: string): {
    text: string;
    isError: boolean;
} | undefined;
export type EarlyToolRow = {
    cursorCallId: string;
    toolCallId: string;
    toolName: string;
    path: string;
};
/**
 * Does not match `cursor_<session>_<execId>`. Continuation finds a bound row
 * through the session route table; a row that was closed never gets a route.
 * Cursor's call id is digested, not embedded: it can hold a newline and run to
 * ~90 characters, and the host keeps this id in history for every provider.
 */
export declare function earlyRowToolCallId(sessionId: string, cursorCallId: string): string;
/** Distinct from the call's early row, which an earlier step may have closed. */
export declare function cursorEditFailureToolCallId(sessionId: string, cursorCallId: string): string;
/** No exec has this id: the result is this provider's, but its exec is unknown. */
export declare const UNBOUND_EXEC_ID = -1;
/**
 * An early-row id whose route is gone (process restart, evicted route) still
 * belongs to this provider. Its result proves the Run lost a completed call,
 * so it must rebuild from host history like any other orphaned result.
 * The session id is a UUID, so it ends at the first underscore.
 */
export declare function parseEarlyRowToolCallId(toolCallId: string): {
    sessionId: string;
    execId: number;
} | undefined;
/** Edit path from a `partial_tool_call`, once Cursor has included one. */
export declare function cursorEditAnnouncement(partial: unknown): {
    callId: string;
    path: string;
} | undefined;
/**
 * Open only while this step cannot end before the exec arrives. A parallel
 * step that is holding can take another row. Otherwise the step ends on the
 * first host call, so a row is useful only before any call or owed exec.
 */
export declare function shouldOpenEarlyRow(input: {
    allowTools: boolean;
    hostInterrupted: boolean;
    holdingParallelStep: boolean;
    emittedHostTools: number;
    owedPending: number;
}): boolean;
export declare class EarlyToolRows {
    private readonly open;
    private readonly skipped;
    seen(callId: string): boolean;
    openRow(row: EarlyToolRow): void;
    skip(callId: string): void;
    claim(callId: string | undefined): EarlyToolRow | undefined;
    drain(): EarlyToolRow[];
}
