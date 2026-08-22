/**
 * Route-switch dispatcher for the Alibaba Token Plan provider.
 *
 * One canonical id per console region: `alibaba-token-plan` (international) and
 * `alibaba-token-plan-cn` (China). When our cookie config resolves, this provider talks to the
 * Alibaba Cloud console HTTP API itself: the personal usage gateway (a monthly percentage) and
 * the team seat API (credits per seat, which no local tool can report). Without a cookie the
 * international route hands the request to the official `bl` CLI backend that ships with main,
 * so the zero-config path keeps working; the China route has no CLI backend.
 *
 * A configured cookie always wins. An invalid one surfaces its own error, and a cookie route
 * whose APIs answer with nothing reports `no_data` in its debug details instead of falling back
 * to the CLI: the CLI reports one personal international monthly window, so a fallback would
 * hide the team seats this route exists for and could show another region's plan.
 */
import type { Amount } from "../core/types.js";
import {
  type AlibabaTokenPlanPersonalUsage,
  type AlibabaTokenPlanSeat,
  queryAlibabaPersonalUsage,
  queryAlibabaTokenPlanSeatQuota,
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
  QuotaProvider,
  QuotaProviderCacheContext,
  QuotaProviderContext,
  QuotaProviderMatchContext,
} from "../lib/entries.js";
import { finiteNumber } from "../lib/json-guards.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { type CanonicalQuotaProviderId, QUOTA_PROVIDER_CATALOG } from "../lib/provider-metadata.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import { alibabaTokenPlanProvider as cliAlibabaTokenPlanProvider } from "./alibaba-token-plan.js";
import {
  type AccountResult,
  failedAccount,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
} from "./contract.js";
import { configStatusDetails, statusDetailsFromRecord } from "./result-helpers.js";

const PROVIDER_ID = "alibaba-token-plan" as const;
const CN_PROVIDER_ID = "alibaba-token-plan-cn" as const;

/** The team seat API reports credits, not a percentage, so its rows carry amounts. */
const CREDIT_UNIT = { kind: "count", unit: "credit" } as const;

/** The team seat row's key; the seat itself is the account. */
const SEAT_ROW_KEY = "credits";

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

function toResetTimeIso(value: number | undefined): string | undefined {
  const epochMs = finiteNumber(value);
  return epochMs !== undefined && epochMs > 0 && epochMs <= MAX_RESET_EPOCH_MS
    ? new Date(epochMs).toISOString()
    : undefined;
}

function creditAmount(value: number): Amount {
  return { decimal: accountingDecimalFromNumber(value), unit: CREDIT_UNIT };
}

/**
 * One seat's monthly credits. The seat API reports amounts (`CycleTotalValue` /
 * `CycleSurplusValue`), so used/limit/remaining stay credits; the percent left is derived from
 * them the way `kilo.ts` does. `amount` is kept so a seat with no positive total still renders.
 */
function seatRow(equity: AlibabaTokenPlanSeat["EquityList"][number]): ProviderRow {
  const total = truncateCredits(equity.CycleTotalValue);
  const surplus = truncateCredits(equity.CycleSurplusValue);
  const used = Math.max(0, truncateCredits(total - surplus));
  const resetsAt = toResetTimeIso(equity.CycleEndTime);
  return {
    key: SEAT_ROW_KEY,
    label: "Credits",
    type: "quota",
    method: "remote_api",
    authority: "provider_reported",
    window: "month",
    prominence: "primary",
    amount: creditAmount(surplus),
    // A cycle quota pool with a real total, so it reports the percent left like every other quota
    // row -- unlike a deepseek-style balance, which has no total to be a percentage of.
    ...(total > 0 ? { percentRemaining: Math.min(100, Math.max(0, (surplus / total) * 100)) } : {}),
    used: creditAmount(used),
    limit: creditAmount(total),
    remaining: creditAmount(surplus),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/** One account for each seat that reported usable credits. */
function seatAccounts(
  label: string,
  seats: readonly AlibabaTokenPlanSeat[],
  accountFilter: readonly string[] | undefined,
): AccountResult[] {
  const filterSet = accountFilter && accountFilter.length > 0 ? new Set(accountFilter) : null;
  const accounts: AccountResult[] = [];

  for (const seat of seats) {
    if (seat.Status !== "NORMAL") continue;
    if (filterSet && !filterSet.has(seat.AccountName)) continue;
    const equity = seat.EquityList?.[0];
    if (!equity) continue;
    if (equity.EquityType !== "CREDITS") continue;
    if (
      finiteNumber(equity.CycleTotalValue) === undefined ||
      finiteNumber(equity.CycleSurplusValue) === undefined
    ) {
      continue;
    }
    const name = seat.AccountName?.trim();
    if (!name) continue;
    // The seat's account name is an Alibaba id ("etfpubacc_..."), so label the account by tier
    // instead, the way copilot labels "Copilot (pro)".
    accounts.push({ name: `${label} (team)`, rows: [seatRow(equity)], errors: [] });
  }

  return accounts;
}

/**
 * The personal plan reports only a monthly window. `per1MonthPercentage` is the USED fraction
 * in [0,1], so remaining is `(1 - p) * 100`. A reply without it makes no row.
 */
function personalRow(usage: AlibabaTokenPlanPersonalUsage): ProviderRow | undefined {
  const usedFraction = finiteNumber(usage.per1MonthPercentage);
  if (usedFraction === undefined) return undefined;
  return quotaRow({
    ...MONTHLY,
    percentRemaining: Math.max(0, Math.min(100, Math.round((1 - usedFraction) * 100))),
    resetsAt: toResetTimeIso(usage.per1MonthResetTime),
  });
}

type ResolvedAuth = Awaited<ReturnType<typeof resolveAlibabaTokenPlanAuthCached>>;
type ConfiguredAuth = Extract<ResolvedAuth, { state: "configured" }>;
type InvalidAuth = Extract<ResolvedAuth, { state: "invalid" }>;

function resolveAuth(): Promise<ResolvedAuth> {
  return resolveAlibabaTokenPlanAuthCached({
    maxAgeMs: DEFAULT_ALIBABA_TOKEN_PLAN_AUTH_CACHE_MAX_AGE_MS,
  });
}

function configDetails(auth: ConfiguredAuth | InvalidAuth) {
  return configStatusDetails({
    state: auth.state,
    source: auth.source,
    checkedPaths: getAlibabaTokenPlanConfigCandidatePaths(),
    ...(auth.state === "invalid" ? { error: auth.error } : {}),
  });
}

function invalidAuthResult(auth: InvalidAuth, label: string): ProviderFetchResult {
  return {
    attempted: true,
    accounts: [failedAccount(label, `Invalid auth (${auth.source}): ${auth.error}`)],
    debug: configDetails(auth),
  };
}

/** The shared cookie backend: personal monthly percentage + team seat credits. */
async function fetchApi(
  auth: ConfiguredAuth,
  endpoint: AlibabaTokenPlanEndpointId,
  providerId: CanonicalQuotaProviderId,
  label: string,
  ctx: QuotaProviderContext,
): Promise<ProviderFetchResult> {
  const statusDetails = [
    ...configDetails(auth),
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

  const requestTimeoutMs = ctx.config.requestTimeoutMs;
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
      ? queryAlibabaTokenPlanSeatQuota({
          requestTimeoutMs,
          endpoint,
          loginTicket: auth.config.loginTicket,
        })
      : Promise.resolve(null),
  ]);

  const accounts: AccountResult[] = [];
  let firstError: { code: string; message: string } | undefined;

  let personalState: string = wantPersonal ? "backoff" : "no_switch_agent";
  if (personal) {
    if (personal.success) {
      const row = personalRow(personal.usage);
      if (row) {
        accounts.push({ name: `${label} (personal)`, rows: [row], errors: [] });
      }
      personalState = row ? "ok" : "no_data";
      markSourceResult(personalKey, row !== undefined, now);
    } else {
      personalState = "failed";
      firstError ??= { code: personal.code, message: personal.message };
      markSourceResult(personalKey, false, now);
    }
  }

  let teamState: string = wantTeam ? "backoff" : "no_account";
  if (team) {
    if (team.success) {
      const seatAccountsFound = seatAccounts(label, team.data.Data.Items, account);
      accounts.push(...seatAccountsFound);
      teamState = seatAccountsFound.length > 0 ? "ok" : "no_data";
      markSourceResult(teamKey, seatAccountsFound.length > 0, now);
    } else {
      teamState = "failed";
      firstError ??= { code: team.code, message: team.message };
      markSourceResult(teamKey, false, now);
    }
  }

  const details = [
    ...statusDetails,
    ...statusDetailsFromRecord({ personal_state: personalState, team_state: teamState }),
  ];

  if (accounts.length > 0) {
    // A failed source beside working rows: the rows stay, and the failure is its own account
    // so rows.ts classifies it (see mimo.ts, the other multi-source provider).
    return {
      attempted: true,
      accounts: firstError ? [...accounts, failedAccount(label, firstError.message)] : accounts,
      debug: firstError
        ? [...details, { key: "live_fetch_error", value: firstError.message }]
        : details,
    };
  }
  if (firstError) {
    return {
      attempted: true,
      accounts: [failedAccount(label, firstError.message)],
      debug: details,
    };
  }

  // Nothing to show: say so rather than report an empty section. Never invent a row, and never
  // fall back to the CLI here — see this file's header.
  if (!wantPersonal && !wantTeam) {
    // A dead ticket makes the console answer with an empty seat list, so "not configured" would
    // contradict config_state and render as "Not set up".
    return {
      attempted: true,
      accounts: [
        failedAccount(
          label,
          `${label} reported no data: personal needs switchAgent, team needs account. A stale login ticket also reports nothing — re-copy it from the console.`,
        ),
      ],
      debug: details,
    };
  }
  const states = [
    wantPersonal ? `personal: ${personalState}` : undefined,
    wantTeam ? `team: ${teamState}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  return {
    attempted: true,
    accounts: [failedAccount(label, `No quota data reported by ${label} (${states}).`)],
    debug: details,
  };
}

/**
 * One implementation for every regional route. A cookie config wins and serves the API backend;
 * otherwise the request is delegated to main's official CLI backend for that region, when main
 * ships one. The two regions are separate canonical ids (repo convention, e.g.
 * `minimax-china-coding-plan`), and the only difference between routes is the console host.
 */
interface AlibabaRouteSpec {
  id: CanonicalQuotaProviderId;
  /** The console region for this route — the only regional difference. */
  endpoint: AlibabaTokenPlanEndpointId;
  /** Main's CLI backend for this region; absent where main ships none. */
  cli?: QuotaProvider;
}

function createRoutedProvider(spec: AlibabaRouteSpec): QuotaProvider {
  const label = QUOTA_PROVIDER_CATALOG[spec.id].label;
  return {
    id: spec.id,

    async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
      // Not gated on isCanonicalProviderAvailable: that asks whether OpenCode lists this id, and
      // our credential is a pasted cookie, so no opencode.json entry ever exists.
      const auth = await resolveAuth();
      // Ours wins: configured serves; invalid surfaces its own error rather than
      // a silent CLI fallback. Only a truly absent config hands off to the CLI, and the CLI
      // backend applies its own selection gate.
      if (auth.state !== "none") return true;
      return spec.cli ? spec.cli.isAvailable(ctx) : false;
    },

    matchesCurrentModel(model: string, context?: QuotaProviderMatchContext): boolean {
      if (context?.currentProviderID === spec.id) return true;
      if (modelProviderMatchesRuntimeId(model, spec.id)) return true;
      return spec.cli?.matchesCurrentModel?.(model, context) ?? false;
    },

    async fetch(
      ctx: QuotaProviderContext,
      cacheContext?: QuotaProviderCacheContext,
    ): Promise<ProviderFetchResult> {
      const auth = await resolveAuth();
      if (auth.state === "none") {
        return spec.cli
          ? spec.cli.fetch(ctx, cacheContext)
          : { attempted: false, accounts: [], debug: [] };
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
