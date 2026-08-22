import {
  type AlibabaTokenPlanSeat,
  queryAlibabaTokenPlanQuota,
} from "../lib/alibaba-token-plan-api.js";
import {
  DEFAULT_ALIBABA_TOKEN_PLAN_AUTH_CACHE_MAX_AGE_MS,
  getAlibabaTokenPlanConfigCandidatePaths,
  resolveAlibabaTokenPlanAuthCached,
} from "../lib/alibaba-token-plan-auth.js";
import {
  ALIBABA_TOKEN_PLAN_QUOTA_URLS,
  type AlibabaTokenPlanEndpointId,
} from "../lib/alibaba-token-plan-endpoints.js";
import type {
  AccountingMetadata,
  AccountingPercentageBasis,
  AccountingSemantic,
  AccountingUnit,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { type CanonicalQuotaProviderId, QUOTA_PROVIDER_CATALOG } from "../lib/provider-metadata.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import {
  attemptedErrorResult,
  attemptedResult,
  configStatusDetails,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const ALIBABA_TOKEN_PLAN_ACCOUNTING: AccountingMetadata = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};

const CREDIT_UNIT: AccountingUnit = { kind: "count", unit: "credit" };

function truncateCredits(value: number): number {
  return Math.round(value * 100) / 100;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function buildAlibabaTokenPlanEntries(
  seats: readonly AlibabaTokenPlanSeat[],
  providerLabel: string,
  accountFilter: readonly string[] | undefined,
): QuotaToastEntry[] {
  const entries: QuotaToastEntry[] = [];
  const filterSet = accountFilter && accountFilter.length > 0 ? new Set(accountFilter) : null;

  for (const seat of seats) {
    if (seat.Status !== "NORMAL") continue;
    if (filterSet && !filterSet.has(seat.AccountName)) continue;
    const equity = seat.EquityList[0];
    if (!equity) continue;
    if (equity.EquityType !== "CREDITS") continue;
    if (!isFiniteNumber(equity.CycleTotalValue) || !isFiniteNumber(equity.CycleSurplusValue)) {
      continue;
    }

    const total = truncateCredits(equity.CycleTotalValue);
    const surplus = truncateCredits(equity.CycleSurplusValue);
    const used = Math.max(0, truncateCredits(total - surplus));
    const percentRemaining = total > 0 ? Math.min(100, Math.round((surplus / total) * 100)) : 0;
    // CycleEndTime marks when the monthly credit pool resets; all seats on one account share it.
    const resetTimeIso = isFiniteNumber(equity.CycleEndTime)
      ? new Date(equity.CycleEndTime).toISOString()
      : undefined;

    const basis: AccountingPercentageBasis = {
      used: {
        quantity: { decimal: accountingDecimalFromNumber(used), unit: CREDIT_UNIT },
        authority: "provider_reported",
      },
      limit: {
        quantity: { decimal: accountingDecimalFromNumber(total), unit: CREDIT_UNIT },
        authority: "provider_reported",
      },
      remaining: {
        quantity: { decimal: accountingDecimalFromNumber(surplus), unit: CREDIT_UNIT },
        authority: "provider_reported",
      },
    };

    const semantic: AccountingSemantic = {
      metric: { kind: "window", window: "month" },
      prominence: "primary",
    };

    entries.push({
      name: `alibaba-token-plan-${seat.AccountName}`,
      group: providerLabel,
      label: `${seat.AccountName}:`,
      percentRemaining,
      basis,
      semantic,
      accounting: ALIBABA_TOKEN_PLAN_ACCOUNTING,
      ...(resetTimeIso ? { resetTimeIso } : {}),
    });
  }

  return entries;
}

const ALIBABA_TOKEN_PLAN_PROVIDERS = [
  {
    id: "alibaba-token-plan",
    endpoint: "international",
  },
  {
    id: "alibaba-token-plan-cn",
    endpoint: "china",
  },
] as const satisfies readonly {
  id: CanonicalQuotaProviderId;
  endpoint: AlibabaTokenPlanEndpointId;
}[];

function createAlibabaTokenPlanProvider(
  spec: (typeof ALIBABA_TOKEN_PLAN_PROVIDERS)[number],
): QuotaProvider {
  const label = QUOTA_PROVIDER_CATALOG[spec.id].label;
  return {
    id: spec.id,

    async isAvailable(): Promise<boolean> {
      const auth = await resolveAlibabaTokenPlanAuthCached({
        maxAgeMs: DEFAULT_ALIBABA_TOKEN_PLAN_AUTH_CACHE_MAX_AGE_MS,
      });
      return auth.state === "configured";
    },

    matchesCurrentModel(model: string): boolean {
      const [provider] = model.toLowerCase().split("/", 2);
      return provider === spec.id;
    },

    async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
      const auth = await resolveAlibabaTokenPlanAuthCached({
        maxAgeMs: DEFAULT_ALIBABA_TOKEN_PLAN_AUTH_CACHE_MAX_AGE_MS,
      });
      const statusDetails = [
        ...configStatusDetails({
          state: auth.state,
          source: auth.state === "none" ? null : auth.source,
          error: auth.state === "invalid" ? auth.error : undefined,
          checkedPaths: getAlibabaTokenPlanConfigCandidatePaths(),
        }),
        ...statusDetailsFromRecord({
          api_endpoint: spec.endpoint,
          api_base_url: ALIBABA_TOKEN_PLAN_QUOTA_URLS[spec.endpoint],
        }),
      ];

      if (auth.state === "none") {
        return withStatusDetails(notAttemptedResult(), statusDetails);
      }
      if (auth.state === "invalid") {
        return withStatusDetails(
          attemptedErrorResult(label, `Invalid auth (${auth.source}): ${auth.error}`),
          statusDetails,
        );
      }

      const result = await queryAlibabaTokenPlanQuota({
        requestTimeoutMs: ctx.config?.requestTimeoutMs,
        endpoint: spec.endpoint,
        secToken: auth.config.secToken,
        loginTicket: auth.config.loginTicket,
      });

      if (!result.success) {
        return withStatusDetails(attemptedErrorResult(label, result.message), [
          ...statusDetails,
          { key: "live_fetch_error", value: result.message },
          { key: "live_fetch_code", value: result.code },
        ]);
      }

      const seats = result.data.Data.Items;
      const entries = buildAlibabaTokenPlanEntries(seats, label, auth.config.account);
      const providerResult = attemptedResult(entries);

      return withStatusDetails(providerResult, [
        ...statusDetails,
        ...statusDetailsFromRecord({
          live_state: entries.length === 0 ? `no reportable ${label} quota` : undefined,
        }),
      ]);
    },
  };
}

export const alibabaTokenPlanProvider: QuotaProvider = createAlibabaTokenPlanProvider(
  ALIBABA_TOKEN_PLAN_PROVIDERS[0],
);
export const alibabaTokenPlanCnProvider: QuotaProvider = createAlibabaTokenPlanProvider(
  ALIBABA_TOKEN_PLAN_PROVIDERS[1],
);
