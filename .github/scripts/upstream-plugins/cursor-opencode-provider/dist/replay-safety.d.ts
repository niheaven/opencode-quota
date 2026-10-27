import type { CursorProviderError } from "./errors.js";
export type ReplayBarrierReason = "visible-text" | "visible-reasoning" | "visible-tool-row" | "display-tool-lifecycle" | "non-control-exec" | "stateful-interaction" | "unknown-or-malformed-frame";
/** Plain Run-owned state retained across host tool-step pump calls. */
export type ReplaySafetyState = {
    statefulBarrier?: ReplayBarrierReason;
    /**
     * Every exec needs its owner's host result; ids can restart on a resumed Run.
     * `callId` is the display call the exec claims.
     */
    execs?: Array<{
        sessionId: string;
        id: number;
        callId?: string;
    }>;
    /** Display calls Cursor announced; history holds one only through the host exec that claims it. */
    announcedCalls?: string[];
    /** History cannot represent opaque interactions, unknown frames or unclaimed display work. */
    historyRebaseUnsafe?: boolean;
};
/** Whether a host exec claimed every display call Cursor announced, so history holds each one. */
export declare function announcedCallsClaimed(state: ReplaySafetyState | undefined): boolean;
export declare class AttemptReplaySafety {
    private readonly sessionId;
    private readonly state;
    private barrierReason;
    private stateful;
    constructor(sessionId: string, state?: ReplaySafetyState);
    markBarrier(reason: ReplayBarrierReason): void;
    /**
     * A display lifecycle frame. A started call stays a stateful barrier but
     * blocks a history rebuild only until a host exec claims it; completion of a
     * claimed call adds nothing history lacks. Calls Cursor runs itself, and
     * frames without a call id, cannot be rebuilt.
     */
    recordToolLifecycle(lifecycle: ReplayToolLifecycle | undefined): void;
    recordExec(id: unknown, callId?: string): void;
    private mark;
    applyTo(failure: CursorProviderError): CursorProviderError;
}
export type DecodedReplayFrame = {
    interactionUpdate?: Record<string, unknown>;
    exec?: Record<string, unknown>;
    kv?: Record<string, unknown>;
    execControl?: Record<string, unknown>;
    interactionQuery?: Record<string, unknown>;
};
export type ReplayToolLifecycle = {
    kind: "started" | "completed";
    callId: string;
};
export type ReplayFrameAnalysis = {
    barrier?: ReplayBarrierReason;
    /** Set for a well-formed lifecycle frame with a call id. */
    toolLifecycle?: ReplayToolLifecycle;
};
/**
 * Field numbers and wire types of a frame, nested three levels, without any
 * payload bytes: `1:2{16:2{1:0}}`. Compare it with `agent.proto` when a frame
 * is classified unknown.
 */
export declare function describeFrameLayout(payload: Uint8Array, depth?: number): string;
/** Classify one decoded server frame without performing any protocol side effects. */
export declare function analyzeReplayFrame(payload: Uint8Array, decoded: DecodedReplayFrame): ReplayFrameAnalysis;
