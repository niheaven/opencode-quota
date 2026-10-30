import type { PluginContext, ToolDraft } from "./types.js";
/**
 * Register the handle-only image commit tool on the OpenCode 2.0 direct
 * catalog. Catalog permission filtering cannot enforce path-specific rules;
 * permission.assert checks the actual target with the executing agent/session.
 */
export declare function registerCursorImageSaveTool(draft: ToolDraft, ctx: PluginContext): void;
