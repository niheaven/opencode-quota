/**
 * Route-switch dispatcher for the Alibaba Token Plan provider.
 *
 * One canonical id (`alibaba-token-plan`). When our cookie config resolves, the
 * API backend (personal monthly percentage + team seat credits) serves the
 * request. Otherwise the request is delegated to the official CLI backend that
 * ships with main, so the zero-config path keeps working.
 */
import {
  type AlibabaTokenPlanPersonalUsage,
  type AlibabaTokenPlanSeat,
  queryAlibabaPersonalUsage,
  queryAlibabaTokenPlanQuota,
} from "../lib/alibaba-token-plan-api.js";
import {
  DEFAULT_ALIBABA_TOKEN_PLAN_AUTH_CACHE_MAX_AGE_MS,
  getAlibabaTokenPlanConfigCandidatePaths,
  resolveAlibabaTokenPlanAuthCached,
} from "../lib/alibaba-token-plan-auth.js";
import {
  ALIBABA_TOKEN_PLAN_PERSONAL_URLS,
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
  QuotaProviderMatchContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { type CanonicalQuotaProviderId, QUOTA_PROVIDER_CATALOG } from "../lib/provider-metadata.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import { alibabaTokenPlanProvider as cliAlibabaTokenPlanProvider } from "./alibaba-token-plan.js";
import {
  attemptedErrorResult,
  attemptedResult,
  configStatusDetails,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const PROVIDER_ID = "alibaba-token-plan" as const;
const CN_PROVIDER_ID = "alibaba-token-plan-cn" as const;

const ACCOUNTING: AccountingMetadata = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};

const CREDIT_UNIT: AccountingUnit = { kind: "count", unit: "credit" };

// Year 2100; toISOString() throws RangeError beyond ±8.64e15, so clamp garbage API values out.
const MAX_RESET_EPOCH_MS = 4_102_444_800_000;

/**
 * A source that produced no rows (empty OR failed) is skipped for this long, so a
 * slow/empty backend is not re-hit on every sidebar refresh.
 */
const EMPTY_SOURCE_BACKOFF_MS = 60_000;

const sourceBackoffUntil = new Map<string, number>();

/** Test-only: drop all per-source empty-result backoff state. */
export function clearAlibabaTokenPlanSourceBackoffForTests(): void {
  sourceBackoffUntil.clear();
}

function isBackedOff(key: string, now: number): boolean {
  const until = sourceBackoffUntil.get(key);
  return until !== undefined && now < until;
}

function markSourceResult(key: string, producedRows: boolean, now: number): void {
  if (producedRows) sourceBackoffUntil.delete(key);
  else sourceBackoffUntil.set(key, now + EMPTY_SOURCE_BACKOFF_MS);
}

function truncateCredits(value: number): number {
  return Math.round(value * 100) / 100;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toResetTimeIso(value: number | undefined): string | undefined {
  return isFiniteNumber(value) && value > 0 && value <= MAX_RESET_EPOCH_MS
    ? new Date(value).toISOString()
    : undefined;
}

function buildTeamEntries(
  seats: readonly AlibabaTokenPlanSeat[],
  providerId: string,
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
    const resetTimeIso = toResetTimeIso(equity.CycleEndTime);
    const accountName = seat.AccountName?.trim() || "";

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
      name: `${providerId}-${accountName || "seat"}`,
      group: `${providerLabel} (team)`,
      percentRemaining,
      basis,
      semantic,
      accounting: ACCOUNTING,
      ...(resetTimeIso ? { resetTimeIso } : {}),
    });
  }

  return entries;
}

/**
 * The personal plan currently reports only a monthly window. `per1MonthPercentage`
 * is the USED fraction in [0,1], so remaining is `(1 - p) * 100`.
 */
function buildPersonalEntries(
  usage: AlibabaTokenPlanPersonalUsage,
  providerId: string,
  providerLabel: string,
): QuotaToastEntry[] {
  if (!isFiniteNumber(usage.per1MonthPercentage)) return [];

  const percentRemaining = Math.max(
    0,
    Math.min(100, Math.round((1 - usage.per1MonthPercentage) * 100)),
  );
  const resetTimeIso = toResetTimeIso(usage.per1MonthResetTime);

  return [
    {
      name: `${providerId}-personal`,
      group: `${providerLabel} (personal)`,
      percentRemaining,
      semantic: { metric: { kind: "window", window: "month" }, prominence: "primary" },
      accounting: ACCOUNTING,
      ...(resetTimeIso ? { resetTimeIso } : {}),
    },
  ];
}

type ResolvedAuth = Awaited<ReturnType<typeof resolveAlibabaTokenPlanAuthCached>>;
type ConfiguredAuth = Extract<ResolvedAuth, { state: "configured" }>;
type InvalidAuth = Extract<ResolvedAuth, { state: "invalid" }>;

function resolveAuth(): Promise<ResolvedAuth> {
  return resolveAlibabaTokenPlanAuthCached({
    maxAgeMs: DEFAULT_ALIBABA_TOKEN_PLAN_AUTH_CACHE_MAX_AGE_MS,
  });
}

function invalidAuthResult(auth: InvalidAuth, label: string): QuotaProviderResult {
  return withStatusDetails(
    attemptedErrorResult(label, `Invalid auth (${auth.source}): ${auth.error}`),
    configStatusDetails({
      state: auth.state,
      source: auth.source,
      error: auth.error,
      checkedPaths: getAlibabaTokenPlanConfigCandidatePaths(),
    }),
  );
}

/** The shared API backend (personal monthly percentage + team seat credits). */
async function fetchApi(
  auth: ConfiguredAuth,
  endpoint: AlibabaTokenPlanEndpointId,
  providerId: CanonicalQuotaProviderId,
  label: string,
  ctx: QuotaProviderContext,
): Promise<QuotaProviderResult> {
  const statusDetails = [
    ...configStatusDetails({
      state: auth.state,
      source: auth.source,
      checkedPaths: getAlibabaTokenPlanConfigCandidatePaths(),
    }),
    ...statusDetailsFromRecord({
      api_endpoint: endpoint,
      api_base_url: ALIBABA_TOKEN_PLAN_QUOTA_URLS[endpoint],
      personal_api_base_url: ALIBABA_TOKEN_PLAN_PERSONAL_URLS[endpoint],
    }),
  ];

  const switchAgent = auth.config.switchAgent;
  const account = auth.config.account;
  const now = Date.now();
  const personalKey = `${providerId}:personal`;
  const teamKey = `${providerId}:team`;

  // personal is enabled only by switchAgent; team only by an explicit account list.
  const wantPersonal = switchAgent !== undefined;
  const wantTeam = (account?.length ?? 0) > 0;
  const runPersonal = wantPersonal && !isBackedOff(personalKey, now);
  const runTeam = wantTeam && !isBackedOff(teamKey, now);

  const requestTimeoutMs = ctx.config?.requestTimeoutMs;
  const [personal, team] = await Promise.all([
    runPersonal
      ? queryAlibabaPersonalUsage({
          requestTimeoutMs,
          endpoint,
          loginTicket: auth.config.loginTicket,
          switchAgent,
        })
      : Promise.resolve(null),
    runTeam
      ? queryAlibabaTokenPlanQuota({
          requestTimeoutMs,
          endpoint,
          loginTicket: auth.config.loginTicket,
        })
      : Promise.resolve(null),
  ]);

  const entries: QuotaToastEntry[] = [];
  let firstError: { code: string; message: string } | undefined;

  let personalState = wantPersonal ? "backoff" : "no_switch_agent";
  if (personal) {
    if (personal.success) {
      const personalEntries = buildPersonalEntries(personal.usage, providerId, label);
      entries.push(...personalEntries);
      personalState = personalEntries.length > 0 ? "ok" : "no_data";
      markSourceResult(personalKey, personalEntries.length > 0, now);
    } else {
      personalState = personal.code;
      firstError ??= { code: personal.code, message: personal.message };
      markSourceResult(personalKey, false, now);
    }
  }

  let teamState = wantTeam ? "backoff" : "no_account";
  if (team) {
    if (team.success) {
      const teamEntries = buildTeamEntries(team.data.Data.Items, providerId, label, account);
      entries.push(...teamEntries);
      teamState = teamEntries.length > 0 ? "ok" : "no_data";
      markSourceResult(teamKey, teamEntries.length > 0, now);
    } else {
      teamState = team.code;
      firstError ??= { code: team.code, message: team.message };
      markSourceResult(teamKey, false, now);
    }
  }

  const details = [
    ...statusDetails,
    ...statusDetailsFromRecord({
      personal_state: personalState,
      team_state: teamState,
      live_state: entries.length === 0 ? `no reportable ${label} quota` : undefined,
    }),
  ];

  if (entries.length > 0) {
    return withStatusDetails(attemptedResult(entries), details);
  }
  if (firstError) {
    return withStatusDetails(attemptedErrorResult(label, firstError.message), [
      ...details,
      { key: "live_fetch_error", value: firstError.message },
      { key: "live_fetch_code", value: firstError.code },
    ]);
  }
  return withStatusDetails(attemptedResult(entries), details);
}

/**
 * One implementation for every regional route. A cookie config wins and serves
 * the API backend; otherwise the request is delegated to main's official CLI
 * backend for that region, when main ships one. Regional variants are separate
 * canonical ids (repo convention, e.g. `minimax-china-coding-plan`), and the only
 * difference between routes is the API endpoint (plus the CLI backend, if any).
 */
interface AlibabaRouteSpec {
  id: CanonicalQuotaProviderId;
  /** The API endpoint for this route — the only regional difference. */
  endpoint: AlibabaTokenPlanEndpointId;
  /** Main's CLI backend for this region; absent where main ships none. */
  cli?: QuotaProvider;
}

function createRoutedProvider(spec: AlibabaRouteSpec): QuotaProvider {
  const label = QUOTA_PROVIDER_CATALOG[spec.id].label;
  return {
    id: spec.id,

    async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
      const auth = await resolveAuth();
      // Ours wins: configured serves; invalid surfaces its own error rather than
      // a silent CLI fallback. Only a truly absent config hands off to the CLI.
      if (auth.state !== "none") return true;
      return spec.cli ? spec.cli.isAvailable(ctx) : false;
    },

    matchesCurrentModel(model: string, context?: QuotaProviderMatchContext): boolean {
      if (context?.currentProviderID === spec.id) return true;
      const [provider] = model.toLowerCase().split("/", 2);
      if (provider === spec.id) return true;
      return spec.cli?.matchesCurrentModel?.(model, context) ?? false;
    },

    async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
      const auth = await resolveAuth();
      if (auth.state === "none") {
        return spec.cli ? spec.cli.fetch(ctx) : notAttemptedResult();
      }
      if (auth.state === "invalid") {
        return invalidAuthResult(auth, label);
      }
      return fetchApi(auth, spec.endpoint, spec.id, label, ctx);
    },
  };
}

export const alibabaTokenPlanCnProvider: QuotaProvider = createRoutedProvider({
  id: CN_PROVIDER_ID,
  endpoint: "china",
});

export const alibabaTokenPlanRoutedProvider: QuotaProvider = createRoutedProvider({
  id: PROVIDER_ID,
  endpoint: "international",
  cli: cliAlibabaTokenPlanProvider,
});
