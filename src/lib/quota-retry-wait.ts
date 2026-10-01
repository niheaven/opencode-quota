/**
 * `waitForQuotaReset` (on by default): when a model request hits a provider limit and the quota data
 * shows a used-up window for that model's provider, OpenCode retries once that window resets
 * instead of following its normal retry timing.
 */
import { isPercentEntry, type QuotaProviderResult } from "./entries.js";
import { collectQuotaRenderData } from "./quota-render-data.js";
import {
  createQuotaRuntimeRequestContext,
  resolveQuotaRuntimeContext,
} from "./quota-runtime-context.js";
import type { QuotaSurfaceHost } from "./quota-surface-data.js";

/** Extra wait after the reset time, so the provider has reset the window when the retry runs. */
export const QUOTA_RESET_RETRY_BUFFER_MS = 60_000;
/** Longest single wait. If the window is still used up, the next retry waits again. */
export const QUOTA_RESET_RETRY_MAX_DELAY_MS = 5 * 60 * 60 * 1000;

/** The parts of OpenCode's retry event this feature reads. */
export type QuotaRetryEvent = {
  readonly model: { readonly id: string; readonly providerID: string };
  readonly error: { readonly type: string; readonly status?: number };
};

/** OpenCode's error types for a provider rate limit or used-up quota, or any HTTP 429. */
export function isQuotaLimitError(error: QuotaRetryEvent["error"]): boolean {
  return (
    error.type === "provider.rate-limit" || error.type === "provider.quota" || error.status === 429
  );
}

/**
 * Milliseconds until the earliest reset among used-up (0% left) windows, plus the buffer, at
 * most the cap. Undefined when no used-up window has a reset time still ahead.
 */
export function getQuotaResetRetryDelayMs(
  results: readonly QuotaProviderResult[],
  nowMs: number,
): number | undefined {
  let earliestResetMs: number | undefined;
  for (const result of results) {
    for (const entry of result.entries) {
      if (!isPercentEntry(entry) || !(entry.percentRemaining <= 0) || !entry.resetTimeIso) continue;
      const resetMs = Date.parse(entry.resetTimeIso);
      if (!(resetMs > nowMs)) continue;
      if (earliestResetMs === undefined || resetMs < earliestResetMs) earliestResetMs = resetMs;
    }
  }
  if (earliestResetMs === undefined) return undefined;
  return Math.min(
    earliestResetMs - nowMs + QUOTA_RESET_RETRY_BUFFER_MS,
    QUOTA_RESET_RETRY_MAX_DELAY_MS,
  );
}

/**
 * The retry delay for a limit error on `event.model`, or undefined to keep OpenCode's decision.
 * Quota comes from the same provider refresh path as the sidebar and toasts, but skips the cache:
 * the limit error itself shows the quota changed, so the provider is asked once for fresh data.
 */
export async function resolveQuotaResetRetryDelayMs(
  host: Pick<QuotaSurfaceHost, "client" | "roots">,
  event: QuotaRetryEvent,
): Promise<number | undefined> {
  if (!isQuotaLimitError(event.error)) return undefined;
  const runtime = await resolveQuotaRuntimeContext({
    client: host.client,
    roots: host.roots,
    sessionMeta: { modelID: event.model.id, providerID: event.model.providerID },
  });
  if (!runtime.config.waitForQuotaReset) return undefined;
  const collected = await collectQuotaRenderData({
    client: runtime.client,
    resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
    // Only the provider of the model that hit the limit counts, whatever onlyCurrentModel says.
    config: { ...runtime.config, onlyCurrentModel: true },
    configMeta: runtime.configMeta,
    request: createQuotaRuntimeRequestContext(runtime),
    workspaceRoot: runtime.roots.workspaceRoot,
    surfaceExplicitProviderIssues: false,
    bypassProviderCache: true,
    providers: runtime.providers,
  });
  return getQuotaResetRetryDelayMs(
    collected.providerResults.map((probe) => probe.result),
    Date.now(),
  );
}
