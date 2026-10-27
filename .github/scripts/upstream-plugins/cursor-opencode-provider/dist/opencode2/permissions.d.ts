import type { PermissionAssertInput, PluginContext, ToolExecutionContext } from "./types.js";
/** Use the same public permission service as native tools; never evaluate rules here. */
export declare function assertToolPermission(ctx: Pick<PluginContext, "permission"> | undefined, context: ToolExecutionContext, input: Omit<PermissionAssertInput, "sessionID" | "agent" | "source">): Promise<void>;
