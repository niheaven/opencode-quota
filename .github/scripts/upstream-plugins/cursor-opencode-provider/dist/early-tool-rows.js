import { createHash } from "node:crypto";
/** Shown when an announced edit ends with its Run, never becoming a host tool call. */
export const EARLY_ROW_CLOSED = "Cursor did not finish this tool call.";
/**
 * Shown when the announced call runs as a host tool the row did not predict,
 * such as a rewrite with unchanged content, which stays a `write`. The row's
 * tool name cannot change once started (OpenCode 2 rejects a renamed call),
 * so it completes and names the call that carries on.
 */
export function earlyRowHandoff(toolName) {
    return `Cursor continued this call as \`${toolName}\`.`;
}
/**
 * Shown when the step ends on another call's exec while this one is still
 * running in Cursor: its exec, if any, comes in a later step under its own id.
 */
export const EARLY_ROW_DEFERRED = "Cursor runs this call after the step's other tool calls.";
export function earlyRowResult(close) {
    switch (close.kind) {
        case "abandoned": return { result: EARLY_ROW_CLOSED, isError: true };
        case "deferred": return { result: EARLY_ROW_DEFERRED, isError: false };
        case "handoff": return { result: earlyRowHandoff(close.toolName), isError: false };
        case "outcome": return { result: close.text, isError: close.isError };
    }
}
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function text(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
export function cursorEditFailure(filePath, detail) {
    return { text: `Cursor's edit of ${filePath} failed: ${detail}`, isError: true };
}
/**
 * The outcome Cursor reports for an edit it finished without a write exec,
 * such as an `old_string` it could not find. The model saw this result.
 */
export function cursorEditOutcome(toolCall, filePath) {
    const result = record(record(record(toolCall)?.edit_tool_call)?.result);
    if (!result)
        return undefined;
    const failed = (detail) => cursorEditFailure(filePath, detail);
    const success = record(result.success);
    if (success) {
        return { text: text(success.message) ?? `Cursor finished this edit of ${filePath} without changing the file.`, isError: false };
    }
    if (record(result.file_not_found))
        return failed("file not found.");
    if (record(result.read_permission_denied))
        return failed("permission denied reading the file.");
    const writeDenied = record(result.write_permission_denied);
    if (writeDenied)
        return failed(text(writeDenied.error) ?? "permission denied writing the file.");
    const rejected = record(result.rejected);
    if (rejected)
        return failed(text(rejected.reason) ?? "rejected.");
    const error = record(result.error);
    if (error)
        return failed(text(error.model_visible_error) ?? text(error.error) ?? "unknown error.");
    return undefined;
}
const EARLY_ROW_PREFIX = "cursor-early_";
/**
 * Does not match `cursor_<session>_<execId>`. Continuation finds a bound row
 * through the session route table; a row that was closed never gets a route.
 * Cursor's call id is digested, not embedded: it can hold a newline and run to
 * ~90 characters, and the host keeps this id in history for every provider.
 */
export function earlyRowToolCallId(sessionId, cursorCallId) {
    const digest = createHash("sha256").update(cursorCallId).digest("hex").slice(0, 12);
    return `${EARLY_ROW_PREFIX}${sessionId}_${digest}`;
}
/** Distinct from the call's early row, which an earlier step may have closed. */
export function cursorEditFailureToolCallId(sessionId, cursorCallId) {
    return earlyRowToolCallId(sessionId, `${cursorCallId}\nfailed`);
}
/** No exec has this id: the result is this provider's, but its exec is unknown. */
export const UNBOUND_EXEC_ID = -1;
/**
 * An early-row id whose route is gone (process restart, evicted route) still
 * belongs to this provider. Its result proves the Run lost a completed call,
 * so it must rebuild from host history like any other orphaned result.
 * The session id is a UUID, so it ends at the first underscore.
 */
export function parseEarlyRowToolCallId(toolCallId) {
    if (!toolCallId.startsWith(EARLY_ROW_PREFIX))
        return undefined;
    const rest = toolCallId.slice(EARLY_ROW_PREFIX.length);
    const separator = rest.indexOf("_");
    if (separator <= 0 || separator === rest.length - 1)
        return undefined;
    return { sessionId: rest.slice(0, separator), execId: UNBOUND_EXEC_ID };
}
/** Edit path from a `partial_tool_call`, once Cursor has included one. */
export function cursorEditAnnouncement(partial) {
    if (!partial || typeof partial !== "object")
        return undefined;
    const callId = partial.call_id;
    const toolCall = partial.tool_call;
    const edit = toolCall && typeof toolCall === "object"
        ? toolCall.edit_tool_call
        : undefined;
    const args = edit && typeof edit === "object" ? edit.args : undefined;
    const filePath = args && typeof args === "object" ? args.path : undefined;
    if (typeof callId !== "string" || callId.length === 0)
        return undefined;
    if (typeof filePath !== "string" || filePath.trim().length === 0)
        return undefined;
    return { callId, path: filePath };
}
/**
 * Open only while this step cannot end before the exec arrives. A parallel
 * step that is holding can take another row. Otherwise the step ends on the
 * first host call, so a row is useful only before any call or owed exec.
 */
export function shouldOpenEarlyRow(input) {
    if (!input.allowTools || input.hostInterrupted)
        return false;
    if (input.holdingParallelStep)
        return true;
    return input.emittedHostTools === 0 && input.owedPending === 0;
}
export class EarlyToolRows {
    open = new Map();
    skipped = new Set();
    seen(callId) {
        return this.open.has(callId) || this.skipped.has(callId);
    }
    openRow(row) {
        this.open.set(row.cursorCallId, row);
    }
    skip(callId) {
        this.skipped.add(callId);
    }
    claim(callId) {
        if (!callId)
            return undefined;
        const row = this.open.get(callId);
        if (!row)
            return undefined;
        this.open.delete(callId);
        return row;
    }
    drain() {
        const rows = [...this.open.values()];
        this.open.clear();
        return rows;
    }
}
