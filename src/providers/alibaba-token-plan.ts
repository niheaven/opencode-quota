import {
  type AlibabaTokenPlanClosedResult,
  type AlibabaTokenPlanWindow,
  isAlibabaTokenPlanSupportedPlatform,
  queryAlibabaTokenPlanQuota,
} from "../lib/alibaba-token-plan.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import {
  failedAccount,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
} from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";

const GROUP = "Alibaba Personal Token Plan";

/** The monthly window the local Alibaba CLI reported. */
function windowRow(window: AlibabaTokenPlanWindow): ProviderRow {
  return {
    ...quotaRow({
      ...MONTHLY,
      percentRemaining: window.percentRemaining,
      resetsAt: window.resetTimeIso,
    }),
    method: "local_cli",
  };
}

function statusDetailsFromResult(result: AlibabaTokenPlanClosedResult) {
  if (result.ok) {
    return statusDetailsFromRecord({
      cli_available: "true",
      platform: process.platform,
      windows: result.monthly ? MONTHLY.key : "(none)",
    });
  }
  return statusDetailsFromRecord({
    cli_available: result.error.kind === "executable_not_found" ? "false" : "true",
    platform: process.platform,
    failure_kind: result.error.kind,
  });
}

export const alibabaTokenPlanProvider: QuotaProvider = {
  id: "alibaba-token-plan",

  // Never probes PATH: availability comes from selection or the current runtime identity.
  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    if (!isAlibabaTokenPlanSupportedPlatform()) return false;

    const selected = await isCanonicalProviderAvailable({
      ctx,
      providerId: "alibaba-token-plan",
      fallbackOnError: false,
    });
    if (selected || ctx.config.currentProviderID === "alibaba-token-plan") return true;
    const currentModel = ctx.config.currentModel;
    return !!currentModel && modelProviderMatchesRuntimeId(currentModel, "alibaba-token-plan");
  },

  matchesCurrentModel(model: string, context): boolean {
    if (context?.currentProviderID) {
      return context.currentProviderID === "alibaba-token-plan";
    }
    return modelProviderMatchesRuntimeId(model, "alibaba-token-plan");
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const result = await queryAlibabaTokenPlanQuota({
      requestTimeoutMs: ctx.config.requestTimeoutMs,
      runtime: { cwd: ctx.workspaceRoot },
    });
    const debug = statusDetailsFromResult(result);
    if (result.ok) {
      const rows = result.monthly ? [windowRow(result.monthly)] : [];
      return { attempted: true, accounts: [{ name: GROUP, rows, errors: [] }], debug };
    }
    if (result.error.kind === "unsupported_platform") {
      return { attempted: false, accounts: [], debug };
    }
    return {
      attempted: true,
      accounts: [failedAccount(GROUP, result.error.message)],
      debug,
    };
  },
};
