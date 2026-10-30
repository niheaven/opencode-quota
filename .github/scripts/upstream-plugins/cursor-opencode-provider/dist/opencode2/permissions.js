/** Use the same public permission service as native tools; never evaluate rules here. */
export async function assertToolPermission(ctx, context, input) {
    if (!ctx?.permission?.assert)
        throw new Error("This host did not provide a permission assertion for the tool.");
    await ctx.permission.assert({
        ...input,
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
    });
}
