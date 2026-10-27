/**
 * Cursor unified-mode ids and the OpenCode primary agents that serve them.
 *
 * Cursor CLI's SwitchMode handler sends `chat`, `ask` and `search` to its
 * read-only Ask mode, and derives `UserMessage.mode` (`agent.v1.AgentMode`)
 * from the current mode: plan, Ask and debug are their own wire modes; every
 * other mode (agent, spec, triage, …) runs as agent. This provider serves
 * `plan` and `spec` with the host plan agent and every implementing mode with
 * the host build agent; a read-only mode keeps the current agent.
 */
export type CursorModeRole = "plan" | "read-only" | "implement";
/** Which Cursor CLI-shaped reminder describes the mode. */
export type CursorModeGuidance = "plan" | "ask" | "debug" | "multitask" | "triage" | "project" | "background" | "agent";
/** OpenCode primary agent a Cursor mode selects, on both host generations. */
export type HostPrimaryAgent = "plan" | "build";
export declare const HOST_PLAN_AGENT = "plan";
export type CursorModeSpec = {
    role: CursorModeRole;
    /** `agent.v1.AgentMode`. */
    wire: number;
    guidance: CursorModeGuidance;
};
/** Normalize Cursor mode ids for comparison. */
export declare function normalizeCursorModeId(modeId: string | undefined): string;
/** undefined only for an empty id. */
export declare function cursorModeSpec(modeId: string | undefined): CursorModeSpec | undefined;
export declare function cursorModeRole(modeId: string | undefined): CursorModeRole | undefined;
/** A read-only mode selects no primary agent. */
export declare function hostAgentForCursorMode(modeId: string | undefined): HostPrimaryAgent | undefined;
/** `UserMessage.mode` for a Cursor mode id; no recorded mode runs as agent. */
export declare function cursorAgentModeWireValue(modeId: string | undefined): number;
export declare function isHostPlanAgent(agent: string | undefined): boolean;
