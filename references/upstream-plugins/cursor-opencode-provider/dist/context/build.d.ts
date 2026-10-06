import { type OpencodeToolDef } from "../protocol/tools.js";
import { type OpencodeJson } from "./rules.js";
export type BuildRequestContextInput = {
    workspaceRoot: string;
    tools?: OpencodeToolDef[];
    providerIdentifier?: string;
    /** When set, skills/subagents/plugins are epoch-held for this conversation. */
    conversationId?: string;
    /**
     * Preloaded merged `opencode.json` from the same Run (e.g. for interaction
     * guidance MCP server ids). Skips a second `loadMergedConfig` disk read.
     */
    mergedConfig?: OpencodeJson;
    /** Host system context to deliver as the frozen system-instructions rule. */
    systemInstructions?: SystemInstructions;
};
/**
 * Host system context (OpenCode's system prompt plus this provider's
 * interaction guidance) for one Cursor conversation.
 */
export type SystemInstructions = {
    text: string;
    /**
     * True when `text` is this conversation's own frozen baseline (a Context
     * Epoch started in this process, or an ephemeral Run's prompt): it replaces
     * any rule already frozen. False when a restart recovered the epoch without
     * its bytes: the persisted rule wins and `text` only fills a missing one.
     */
    authoritative: boolean;
};
/** Rule name Cursor shows for the host system context (not a file). */
export declare const SYSTEM_INSTRUCTIONS_RULE_PATH = "OpenCode system instructions";
/**
 * Cursor does not follow a client-seeded `system` message, and applies a rule
 * only by its type. The Cursor CLI sends AGENTS.md as `alwaysApply`
 * (`CursorRuleType.global`) and the IDE ships its own guidance as a non-file
 * global rule; the host system context goes out the same way, once, frozen
 * with the RequestContext base.
 */
export declare function systemInstructionsRule(text: string): Record<string, unknown>;
/** Text of the frozen system-instructions rule, if the context carries one. */
export declare function systemInstructionsRuleText(context: Record<string, unknown>): string | undefined;
/**
 * Return `context` with the system-instructions rule applied, or the same
 * object when nothing changes (see `SystemInstructions.authoritative`).
 */
export declare function withSystemInstructions(context: Record<string, unknown>, instructions: SystemInstructions | undefined): Record<string, unknown>;
export declare const DYNAMIC_REQUEST_CONTEXT_KEYS: readonly ["tools", "custom_subagents", "mcp_file_system_options", "mcp_meta_tool_options", "web_search_enabled", "web_fetch_enabled", "custom_subagents_info_complete", "mcp_file_system_info_complete", "mcp_info_complete", "hooks_additional_context"];
export type DynamicRequestContextKey = typeof DYNAMIC_REQUEST_CONTEXT_KEYS[number];
/**
 * The host system context (delivered as the system-instructions rule) already
 * carries these; never keep them on a frozen base.
 */
export declare const HOST_DUPLICATED_REQUEST_CONTEXT_KEYS: readonly ["agent_skills", "agent_skills_info_complete"];
/**
 * Full RequestContext payload for live UMA + exec #10 reply.
 * Workspace env/git/layout, the host system-instructions rule, and
 * host-advertised tools and subagents. The provider never looks in Cursor's
 * own directories.
 */
export declare function buildRequestContext(input: BuildRequestContextInput): Promise<Record<string, unknown>>;
/** Rediscover only capability/plugin sections that may change during a chat. */
export declare function buildDynamicRequestContext(input: BuildRequestContextInput): Promise<Record<string, unknown>>;
/** Keep expensive workspace state frozen while replacing every live capability field. */
export declare function materializeRequestContext(base: Record<string, unknown>, dynamic: Record<string, unknown>): Record<string, unknown>;
/** Strip live capability fields before retaining/persisting a conversation base. */
export declare function requestContextBase(context: Record<string, unknown>): Record<string, unknown>;
