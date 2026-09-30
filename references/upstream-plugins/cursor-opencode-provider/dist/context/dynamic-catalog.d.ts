export type AgentSkillLike = {
    /** OpenCode skill id (frontmatter `name`, else directory name). */
    id?: unknown;
    full_path?: unknown;
    description?: unknown;
    content?: unknown;
};
/**
 * Configured MCP servers that own at least one advertised tool. Uses the same
 * server resolution as the RequestContext descriptors, so guidance never names
 * a server Cursor was not given. `toolNames` are OpenCode ids (alias
 * `sourceName` when present).
 */
export declare function listAdvertisedMcpServers(toolNames: Iterable<string>, knownMcpServers?: Iterable<string>): string[];
/** Skill id OpenCode's `skill` tool expects: the discovered id, else `…/skills/<id>/SKILL.md`. */
export declare function skillNameFromAgentSkill(skill: AgentSkillLike): string | undefined;
/**
 * Shared system-guidance line: name advertised dynamic-catalog tools and prefer
 * them over Grep/Shell when skills or project rules apply. Concrete skill ids
 * stay out of the frozen baseline (they live in RequestContext `agent_skills`
 * and in Mid-Conversation updates when the catalog changes — same split as
 * OpenCode's SkillGuidance / SkillInstructions).
 */
export declare function buildDynamicCatalogRoutingInstruction(options: {
    toolNames: Iterable<string>;
    knownMcpServers?: Iterable<string>;
}): string | undefined;
/**
 * OpenCode-shaped Mid-Conversation skill update.
 *
 * Pure: compare `previousSkillIds` (null = not yet admitted this conversation)
 * to the current catalog. First admission returns undefined — baseline
 * RequestContext + routing instruction already carry the list. Later turns
 * only speak when the id set changes (agent switch / discovery growth), matching
 * `SkillGuidance.update` / `SkillInstructions.update`.
 */
export declare function buildSkillCatalogChangeReminder(options: {
    hasSkillTool: boolean;
    skills: readonly AgentSkillLike[];
    /** Sorted skill ids already admitted; `null` means first admission this conversation. */
    previousSkillIds: readonly string[] | null;
    /**
     * Host skill parameter key from the advertised schema.
     * OpenCode 1.x: `name`. OpenCode 2.0: `id`.
     */
    skillArgKey?: "name" | "id";
}): {
    text: string | undefined;
    nextSkillIds: string[];
};
/**
 * Admit the current skill catalog for a conversation and return a Mid-Conversation
 * reminder only when OpenCode would (catalog changed after baseline admission).
 */
export declare function takeSkillCatalogChangeReminder(conversationId: string, options: {
    hasSkillTool: boolean;
    skills: readonly AgentSkillLike[];
    skillArgKey?: "name" | "id";
}): string | undefined;
export declare function clearSkillCatalogAdmission(conversationId: string): void;
export declare function transferSkillCatalogAdmission(previousConversationId: string, nextConversationId: string): void;
export declare function resetSkillCatalogAdmissionsForTests(): void;
/**
 * @deprecated Prefer `buildSkillCatalogChangeReminder` / `takeSkillCatalogChangeReminder`.
 * Kept as a thin alias for callers that still expect the old name; always returns
 * undefined for userText-based matching (OpenCode never did per-turn id nudges).
 */
export declare function buildSkillCatalogNudge(options: {
    hasSkillTool: boolean;
    skills: readonly AgentSkillLike[];
    userText?: string;
    skillArgKey?: "name" | "id";
    previousSkillIds?: readonly string[] | null;
}): string | undefined;
