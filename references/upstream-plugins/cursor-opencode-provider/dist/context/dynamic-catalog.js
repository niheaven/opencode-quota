import { resolveToolServerIdentity } from "../protocol/tools.js";
/**
 * Issue #29: Cursor keeps OpenCode `skill` and MCP tools off its native
 * top-level function list. Both OpenCode 1.x and OpenCode 2.0 reach the model
 * as MCP-shaped RequestContext ads, then GetDynamicTools / CallDynamicTool
 * (exec `mcp_args`). This module builds the shared routing guidance and the
 * OpenCode-shaped Mid-Conversation skill-catalog update used on both hosts.
 *
 * OpenCode itself does **not** per-turn nudge matched skill ids. It:
 * - Puts name/description guidance in the frozen baseline (`SystemPrompt.skills`
 *   / `SkillGuidance` / `SkillInstructions`)
 * - Emits a Mid-Conversation update only when the available-skills list changes
 * - OpenCode 2: skips re-invoke when `<skill_content>` is already in the turn
 *
 * OpenCode 2 still needs `exposeDirectMcpTools` so MCP tools leave Code Mode
 * and enter the AI SDK catalog; without that step they never reach this
 * advertisement path at all.
 */
const MAX_MCP_SERVERS_IN_GUIDANCE = 8;
/** Synthetic server builtins and unknown tools are advertised under (`toolsToMcpDescriptors`). */
const DEFAULT_TOOL_SERVER = "opencode";
/**
 * Skill ids already admitted to the model for a conversation (baseline RequestContext
 * freeze, or the last Mid-Conversation catalog update). First admission is silent —
 * OpenCode puts that list in the system baseline, not a per-turn reminder.
 */
const admittedSkillIdsByConversation = new Map();
function listWithOverflow(items, limit) {
    const shown = items.slice(0, limit).map((item) => `\`${item}\``).join(", ");
    const hidden = items.length - limit;
    return hidden > 0 ? `${shown} (+${hidden} more)` : shown;
}
/**
 * Configured MCP servers that own at least one advertised tool. Uses the same
 * server resolution as the RequestContext descriptors, so guidance never names
 * a server Cursor was not given. `toolNames` are OpenCode ids (alias
 * `sourceName` when present).
 */
export function listAdvertisedMcpServers(toolNames, knownMcpServers = []) {
    const known = [...knownMcpServers];
    if (known.length === 0)
        return [];
    const servers = new Set();
    for (const name of toolNames) {
        const { server } = resolveToolServerIdentity(name, DEFAULT_TOOL_SERVER, known);
        if (server !== DEFAULT_TOOL_SERVER)
            servers.add(server);
    }
    return [...servers];
}
/** Skill id OpenCode's `skill` tool expects: the discovered id, else `…/skills/<id>/SKILL.md`. */
export function skillNameFromAgentSkill(skill) {
    const id = typeof skill.id === "string" ? skill.id.trim() : "";
    if (id)
        return id;
    const fullPath = typeof skill.full_path === "string" ? skill.full_path.trim() : "";
    const parts = fullPath.split(/[\\/]+/).filter(Boolean);
    if (parts.length < 2 || parts.at(-1).toLowerCase() !== "skill.md")
        return undefined;
    return parts.at(-2);
}
function skillIds(skills) {
    const ids = [];
    const seen = new Set();
    for (const skill of skills) {
        const name = skillNameFromAgentSkill(skill);
        if (!name || seen.has(name))
            continue;
        seen.add(name);
        ids.push(name);
    }
    return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
function sameIdList(left, right) {
    if (left.length !== right.length)
        return false;
    for (let i = 0; i < left.length; i++)
        if (left[i] !== right[i])
            return false;
    return true;
}
/**
 * Shared system-guidance line: name advertised dynamic-catalog tools and prefer
 * them over Grep/Shell when skills or project rules apply. Concrete skill ids
 * stay out of the frozen baseline (they live in RequestContext `agent_skills`
 * and in Mid-Conversation updates when the catalog changes — same split as
 * OpenCode's SkillGuidance / SkillInstructions).
 */
export function buildDynamicCatalogRoutingInstruction(options) {
    const names = [...options.toolNames];
    const hasSkill = names.includes("skill");
    const mcpServers = listAdvertisedMcpServers(names, options.knownMcpServers);
    if (!hasSkill && mcpServers.length === 0)
        return undefined;
    const extras = [];
    if (hasSkill)
        extras.push("`skill`");
    if (mcpServers.length > 0) {
        extras.push(`MCP servers such as ${listWithOverflow(mcpServers, MAX_MCP_SERVERS_IN_GUIDANCE)}`);
    }
    const lines = [
        `- OpenCode host tools that are not in Cursor's native top-level list (including ${extras.join(" and ")}) ` +
            "are reached through GetDynamicTools / CallDynamicTool (or the host's equivalent dynamic catalog). " +
            "When a skill matches or project rules name an MCP server, discover and call those tools that way " +
            "before Grep/Shell fallbacks. Do not narrate that they are unavailable.",
    ];
    if (hasSkill) {
        // Mirror OpenCode 1 SystemPrompt.skills / OC2 SkillInstructions.render.
        lines.push("- Skills provide specialized instructions and workflows for specific tasks. " +
            "Use the `skill` tool to load a skill when a task matches its description " +
            "(RequestContext `agent_skills` lists names and descriptions). " +
            "A skill that is already present in the conversation as a `<skill_content>` block " +
            "does not need to be invoked again.");
    }
    return lines.join("\n");
}
function skillEntriesXml(skills, argKey) {
    const lines = ["<available_skills>"];
    for (const skill of skills) {
        const name = skillNameFromAgentSkill(skill);
        if (!name)
            continue;
        const description = typeof skill.description === "string" ? skill.description : "";
        lines.push("  <skill>");
        if (argKey === "id")
            lines.push(`    <id>${name}</id>`);
        lines.push(`    <name>${name}</name>`);
        if (description)
            lines.push(`    <description>${description}</description>`);
        lines.push("  </skill>");
    }
    lines.push("</available_skills>");
    return lines;
}
/**
 * OpenCode-shaped Mid-Conversation skill update.
 *
 * Pure: compare `previousSkillIds` (null = not yet admitted this conversation)
 * to the current catalog. First admission returns undefined — baseline
 * RequestContext + routing instruction already carry the list. Later turns
 * only speak when the id set changes (agent switch / discovery growth), matching
 * `SkillGuidance.update` / `SkillInstructions.update`.
 */
export function buildSkillCatalogChangeReminder(options) {
    const nextSkillIds = skillIds(options.skills);
    if (!options.hasSkillTool) {
        return { text: undefined, nextSkillIds: options.previousSkillIds ? [...options.previousSkillIds] : [] };
    }
    if (options.previousSkillIds === null) {
        return { text: undefined, nextSkillIds };
    }
    if (sameIdList(options.previousSkillIds, nextSkillIds)) {
        return { text: undefined, nextSkillIds };
    }
    const argKey = options.skillArgKey === "id" ? "id" : "name";
    const callHint = argKey === "id"
        ? "Call `skill` with `{ \"id\": \"<skill-id>\" }` (host schema key is `id`)."
        : "Call `skill` with `{ \"name\": \"<skill-id>\" }` (host schema key is `name`).";
    const body = nextSkillIds.length === 0
        ? ["Skill guidance is no longer available. Do not use any previously listed skill."]
        : [
            "The available skills have changed. This list supersedes the previous available skills list.",
            "Skills provide specialized instructions and workflows for specific tasks.",
            "Use the skill tool to load a skill when a task matches its description.",
            "The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.",
            `OpenCode skills are invoked with the host \`skill\` tool through GetDynamicTools / CallDynamicTool (MCP server \`${DEFAULT_TOOL_SERVER}\`, tool \`skill\`), not by Grep/Read of SKILL.md. ${callHint}`,
            ...skillEntriesXml(options.skills, argKey),
        ];
    return {
        text: `<system_reminder>\n${body.join("\n")}\n</system_reminder>`,
        nextSkillIds,
    };
}
/**
 * Admit the current skill catalog for a conversation and return a Mid-Conversation
 * reminder only when OpenCode would (catalog changed after baseline admission).
 */
export function takeSkillCatalogChangeReminder(conversationId, options) {
    const previous = conversationId
        ? (admittedSkillIdsByConversation.get(conversationId) ?? null)
        : null;
    const { text, nextSkillIds } = buildSkillCatalogChangeReminder({
        ...options,
        previousSkillIds: previous,
    });
    if (!conversationId)
        return text;
    if (!options.hasSkillTool && previous === null && nextSkillIds.length === 0) {
        return text;
    }
    admittedSkillIdsByConversation.delete(conversationId);
    admittedSkillIdsByConversation.set(conversationId, nextSkillIds);
    while (admittedSkillIdsByConversation.size > 256) {
        const oldest = admittedSkillIdsByConversation.keys().next().value;
        if (!oldest)
            break;
        admittedSkillIdsByConversation.delete(oldest);
    }
    return text;
}
export function clearSkillCatalogAdmission(conversationId) {
    admittedSkillIdsByConversation.delete(conversationId);
}
export function transferSkillCatalogAdmission(previousConversationId, nextConversationId) {
    if (!previousConversationId || !nextConversationId)
        return;
    const prior = admittedSkillIdsByConversation.get(previousConversationId);
    admittedSkillIdsByConversation.delete(previousConversationId);
    admittedSkillIdsByConversation.delete(nextConversationId);
    if (prior)
        admittedSkillIdsByConversation.set(nextConversationId, prior);
}
export function resetSkillCatalogAdmissionsForTests() {
    admittedSkillIdsByConversation.clear();
}
/**
 * @deprecated Prefer `buildSkillCatalogChangeReminder` / `takeSkillCatalogChangeReminder`.
 * Kept as a thin alias for callers that still expect the old name; always returns
 * undefined for userText-based matching (OpenCode never did per-turn id nudges).
 */
export function buildSkillCatalogNudge(options) {
    return buildSkillCatalogChangeReminder({
        hasSkillTool: options.hasSkillTool,
        skills: options.skills,
        previousSkillIds: options.previousSkillIds ?? null,
        skillArgKey: options.skillArgKey,
    }).text;
}
