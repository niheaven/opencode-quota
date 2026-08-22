import { createHash } from "node:crypto";

import { ALIBABA_TOKEN_PLAN_LOGIN_TICKET_COOKIE } from "./alibaba-token-plan-auth.js";
import {
  ALIBABA_TOKEN_PLAN_PERSONAL_API,
  ALIBABA_TOKEN_PLAN_PERSONAL_URLS,
  ALIBABA_TOKEN_PLAN_QUOTA_URLS,
  ALIBABA_TOKEN_PLAN_REQUEST_DEFAULTS,
  type AlibabaTokenPlanEndpointId,
} from "./alibaba-token-plan-endpoints.js";
import { fetchWithTimeout } from "./http.js";

// Real response shape returned by https://bailian.console.aliyun.com/data/api.json
// with action=GetSubscriptionSeatDetails product=ModelStudio
//
// Only fields the provider actually consumes are typed. Unrelated IDs (AccountId,
// CycleInstanceId, SeatId, CycleVersion, etc.) are ignored.
export interface AlibabaTokenPlanEquity {
  EquityType: string;
  CycleTotalValue: number;
  CycleSurplusValue: number;
  CycleEndTime: number;
}

export interface AlibabaTokenPlanSeat {
  Status: string;
  EquityList: AlibabaTokenPlanEquity[];
  AccountName: string;
}

export interface AlibabaTokenPlanDataInner {
  Items: AlibabaTokenPlanSeat[];
}

export interface AlibabaTokenPlanDataEnvelope {
  Data: AlibabaTokenPlanDataInner;
}

export interface AlibabaTokenPlanQuotaSuccess {
  success: true;
  code: string;
  data: AlibabaTokenPlanDataEnvelope;
}

export interface AlibabaTokenPlanQuotaFailure {
  success: false;
  code: string;
  message: string;
}

export type AlibabaTokenPlanQuotaResult =
  | AlibabaTokenPlanQuotaSuccess
  | AlibabaTokenPlanQuotaFailure;

export interface AlibabaTokenPlanQuotaOptions {
  requestTimeoutMs?: number;
  endpoint: AlibabaTokenPlanEndpointId;
  loginTicket: string;
}

const USER_AGENT = "OpenCode-Quota-Toast/1.0";

const COOKIE_EXPIRED_ERROR = "cookie expired, sign in to the console and update the config";
const LOGIN_REQUIRED_ERROR = "login ticket expired, sign in to the console and update the cookie";

const secTokenCache = new Map<string, string>();

// Dedupe concurrent resolutions (personal + team run in parallel) so the console
// page is fetched once per ticket+endpoint.
const secTokenInFlight = new Map<
  string,
  Promise<{ ok: true; value: string } | { ok: false; error: string }>
>();

const isLoginRedirectStatus = (status: number): boolean =>
  (status >= 300 && status < 400) || status === 401 || status === 403;

// Keyed by ticket, so entries die with the ticket; server-side rotation is covered by
// PostonlyOrTokenError invalidation.
const secTokenCacheKey = (endpoint: AlibabaTokenPlanEndpointId, loginTicket: string): string =>
  createHash("sha256").update(`${endpoint}\n${loginTicket}`).digest("hex");

/** Test-only: drop all cached sec_token entries. */
export function clearAlibabaTokenPlanSecTokenCacheForTests(): void {
  secTokenCache.clear();
}

export async function resolveAlibabaTokenPlanSecToken(params: {
  endpoint: AlibabaTokenPlanEndpointId;
  loginTicket: string;
  requestTimeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const key = secTokenCacheKey(params.endpoint, params.loginTicket);
  const cached = secTokenCache.get(key);
  if (cached) return { ok: true, value: cached };

  const inFlight = secTokenInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = resolveSecTokenUncached(params, key).finally(() => {
    secTokenInFlight.delete(key);
  });
  secTokenInFlight.set(key, promise);
  return promise;
}

async function resolveSecTokenUncached(
  params: {
    endpoint: AlibabaTokenPlanEndpointId;
    loginTicket: string;
    requestTimeoutMs?: number;
    fetchFn?: typeof fetch;
  },
  key: string,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  try {
    const consoleOrigin = new URL(ALIBABA_TOKEN_PLAN_QUOTA_URLS[params.endpoint]).origin;
    return await fetchWithTimeout(`${consoleOrigin}/`, {
      request: {
        method: "GET",
        headers: {
          Cookie: `${ALIBABA_TOKEN_PLAN_LOGIN_TICKET_COOKIE}=${params.loginTicket}`,
          Accept: "text/html",
          "User-Agent": USER_AGENT,
        },
        redirect: "manual",
      },
      timeoutMs: params.requestTimeoutMs,
      fetchFn: params.fetchFn,
      consume: async (response) => {
        // redirect:"manual" surfaces the console sign-in redirect as a 3xx here.
        if (isLoginRedirectStatus(response.status)) {
          return { ok: false, error: COOKIE_EXPIRED_ERROR } as const;
        }
        if (!response.ok) {
          return {
            ok: false,
            error: `console page request failed with status ${response.status}`,
          } as const;
        }

        const html = await response.text();
        const value = extractSecToken(html);
        if (!value) {
          return { ok: false, error: "sec_token not found in console page" } as const;
        }

        if (secTokenCache.size >= 64) secTokenCache.clear();
        secTokenCache.set(key, value);
        return { ok: true, value } as const;
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: sanitizeMessage(err instanceof Error ? err.message : String(err), 120, [
        params.loginTicket,
      ]),
    };
  }
}

// sec_token is not a cookie; the console page embeds it as SEC_TOKEN in inline HTML.
function extractSecToken(html: string): string | undefined {
  return /SEC_TOKEN\s*:\s*"([^"]+)"/.exec(html)?.[1];
}

async function attemptAlibabaTokenPlanQuota(
  options: AlibabaTokenPlanQuotaOptions,
  secToken: string,
): Promise<AlibabaTokenPlanQuotaResult> {
  const secrets = [secToken, options.loginTicket];
  const body = new URLSearchParams({
    product: ALIBABA_TOKEN_PLAN_REQUEST_DEFAULTS.product,
    action: ALIBABA_TOKEN_PLAN_REQUEST_DEFAULTS.action,
    sec_token: secToken,
  }).toString();

  try {
    return await fetchWithTimeout(ALIBABA_TOKEN_PLAN_QUOTA_URLS[options.endpoint], {
      request: {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // Other cookies in the pasted header are not required (verified); only the ticket is sent.
          Cookie: `${ALIBABA_TOKEN_PLAN_LOGIN_TICKET_COOKIE}=${options.loginTicket}`,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        body,
        redirect: "manual",
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (response) => {
        // redirect:"manual" surfaces the sign-in redirect here instead of yielding HTML to json().
        const status = response.status;
        if (isLoginRedirectStatus(status)) {
          return {
            success: false,
            code: "LoginRequired",
            message: LOGIN_REQUIRED_ERROR,
          } as AlibabaTokenPlanQuotaFailure;
        }
        if (!response.ok) {
          const text = await response.text();
          return {
            success: false,
            code: String(response.status),
            message: `Alibaba Token Plan API error ${status}: ${sanitizeMessage(text, 120, secrets)}`,
          } as AlibabaTokenPlanQuotaFailure;
        }

        const payload = (await response.json()) as unknown;
        if (!payload || typeof payload !== "object") {
          return {
            success: false,
            code: "InvalidPayload",
            message: "Alibaba Token Plan API returned a non-object payload",
          } as AlibabaTokenPlanQuotaFailure;
        }

        const record = payload as Record<string, unknown>;
        const code = typeof record.code === "string" ? record.code : "UnknownCode";
        const successResponse = record.successResponse;

        if (successResponse !== true) {
          return {
            success: false,
            code,
            message:
              typeof record.message === "string"
                ? sanitizeMessage(record.message, 240, secrets)
                : `Alibaba Token Plan API error code ${code}`,
          } as AlibabaTokenPlanQuotaFailure;
        }

        if (!record.data || typeof record.data !== "object") {
          return {
            success: false,
            code,
            message: "Alibaba Token Plan API success response missing data envelope",
          } as AlibabaTokenPlanQuotaFailure;
        }

        return {
          success: true,
          code,
          data: record.data as AlibabaTokenPlanDataEnvelope,
        } as AlibabaTokenPlanQuotaSuccess;
      },
    });
  } catch (err) {
    return {
      success: false,
      code: "NetworkError",
      message: sanitizeMessage(err instanceof Error ? err.message : String(err), 120, secrets),
    };
  }
}

export async function queryAlibabaTokenPlanQuota(
  options: AlibabaTokenPlanQuotaOptions,
): Promise<AlibabaTokenPlanQuotaResult> {
  if (!options.loginTicket) {
    return {
      success: false,
      code: "SecTokenResolutionError",
      message: "missing login ticket",
    };
  }

  const resolveToken = () =>
    resolveAlibabaTokenPlanSecToken({
      endpoint: options.endpoint,
      loginTicket: options.loginTicket,
      requestTimeoutMs: options.requestTimeoutMs,
    });

  const resolved = await resolveToken();
  if (!resolved.ok) {
    return { success: false, code: "SecTokenResolutionError", message: resolved.error };
  }

  const first = await attemptAlibabaTokenPlanQuota(options, resolved.value);
  if (first.success || first.code !== "PostonlyOrTokenError") return first;

  // One in-band retry: server-side sec_token rotation must not surface as a user error.
  secTokenCache.delete(secTokenCacheKey(options.endpoint, options.loginTicket));
  const refreshed = await resolveToken();
  if (!refreshed.ok) {
    return { success: false, code: "SecTokenResolutionError", message: refreshed.error };
  }
  return refreshed.value === resolved.value
    ? first
    : attemptAlibabaTokenPlanQuota(options, refreshed.value);
}

// ---------------------------------------------------------------------------
// Personal Token Plan usage (console gateway, monthly percentage windows)
// ---------------------------------------------------------------------------

/** Monthly usage fraction in [0,1] plus its reset epoch-ms, as returned by the personal gateway. */
export interface AlibabaTokenPlanPersonalUsage {
  per1MonthPercentage?: number;
  per1MonthResetTime?: number;
}

export type AlibabaTokenPlanPersonalResult =
  | { success: true; usage: AlibabaTokenPlanPersonalUsage }
  | { success: false; code: string; message: string };

export interface AlibabaPersonalQuotaOptions {
  requestTimeoutMs?: number;
  endpoint: AlibabaTokenPlanEndpointId;
  loginTicket: string;
  /** Console "agent" id required by the personal gateway (`cornerstoneParam.switchAgent`). */
  switchAgent?: number;
}

const PERSONAL_USAGE_KEYS = ["per1MonthPercentage", "per1MonthResetTime"] as const;

function pickPersonalUsage(record: Record<string, unknown>): AlibabaTokenPlanPersonalUsage {
  const usage: Record<string, number> = {};
  for (const key of PERSONAL_USAGE_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) usage[key] = value;
  }
  return usage as AlibabaTokenPlanPersonalUsage;
}

/**
 * Query the personal Token Plan usage through the Bailian console gateway.
 *
 * Verified minimal contract: POST the gateway host with a form body of
 * `params={"Api":<personal api>,"V":"1.0","Data":{"cornerstoneParam":{"switchAgent":<N>}}}`
 * and `sec_token`; the cookie only needs `login_aliyunid_ticket`. The URL query
 * string is not required (routing comes from `params.Api`).
 */
export async function queryAlibabaPersonalUsage(
  options: AlibabaPersonalQuotaOptions,
): Promise<AlibabaTokenPlanPersonalResult> {
  if (!options.loginTicket) {
    return { success: false, code: "SecTokenResolutionError", message: "missing login ticket" };
  }

  const switchAgent = options.switchAgent;
  if (typeof switchAgent !== "number" || !Number.isFinite(switchAgent) || switchAgent <= 0) {
    return {
      success: false,
      code: "MissingSwitchAgent",
      message: "personal Token Plan requires a positive switchAgent (console agent id) in config",
    };
  }

  const resolved = await resolveAlibabaTokenPlanSecToken({
    endpoint: options.endpoint,
    loginTicket: options.loginTicket,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  if (!resolved.ok) {
    return { success: false, code: "SecTokenResolutionError", message: resolved.error };
  }

  const secrets = [resolved.value, options.loginTicket];
  const params = JSON.stringify({
    Api: ALIBABA_TOKEN_PLAN_PERSONAL_API,
    V: "1.0",
    Data: { cornerstoneParam: { switchAgent } },
  });
  const body = new URLSearchParams({ params, sec_token: resolved.value }).toString();

  try {
    return await fetchWithTimeout(ALIBABA_TOKEN_PLAN_PERSONAL_URLS[options.endpoint], {
      request: {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `${ALIBABA_TOKEN_PLAN_LOGIN_TICKET_COOKIE}=${options.loginTicket}`,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        body,
        redirect: "manual",
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (response) => {
        const status = response.status;
        if (isLoginRedirectStatus(status)) {
          return {
            success: false,
            code: "LoginRequired",
            message: LOGIN_REQUIRED_ERROR,
          } as AlibabaTokenPlanPersonalResult;
        }
        if (!response.ok) {
          const text = await response.text();
          return {
            success: false,
            code: String(status),
            message: `Alibaba Token Plan personal API error ${status}: ${sanitizeMessage(
              text,
              120,
              secrets,
            )}`,
          } as AlibabaTokenPlanPersonalResult;
        }

        const payload = (await response.json()) as unknown;
        if (!payload || typeof payload !== "object") {
          return {
            success: false,
            code: "InvalidPayload",
            message: "Alibaba Token Plan personal API returned a non-object payload",
          } as AlibabaTokenPlanPersonalResult;
        }

        const record = payload as Record<string, unknown>;
        const envelope = record.data;
        const data =
          envelope && typeof envelope === "object"
            ? (envelope as Record<string, unknown>)
            : undefined;
        const errorCode =
          typeof data?.errorCode === "string" && data.errorCode ? data.errorCode : undefined;
        const code = errorCode ?? (typeof record.code === "string" ? record.code : "UnknownCode");

        if (data?.success !== true) {
          const message =
            typeof data?.errorMsg === "string" && data.errorMsg
              ? data.errorMsg
              : `Alibaba Token Plan personal API error code ${code}`;
          return {
            success: false,
            code: String(code),
            message: sanitizeMessage(message, 240, secrets),
          } as AlibabaTokenPlanPersonalResult;
        }

        const dataV2 = data.DataV2;
        const inner =
          dataV2 && typeof dataV2 === "object"
            ? (dataV2 as Record<string, unknown>).data
            : undefined;
        const innerRecord =
          inner && typeof inner === "object" ? (inner as Record<string, unknown>) : undefined;
        const usageRecord =
          (innerRecord?.data as Record<string, unknown> | undefined) ?? innerRecord ?? {};
        return {
          success: true,
          usage: pickPersonalUsage(usageRecord),
        } as AlibabaTokenPlanPersonalResult;
      },
    });
  } catch (err) {
    return {
      success: false,
      code: "NetworkError",
      message: sanitizeMessage(err instanceof Error ? err.message : String(err), 120, secrets),
    };
  }
}

// Redact known secret values so upstream echoes of sec_token/ticket never reach toasts or logs.
function sanitizeMessage(
  text: string,
  maxLength = 120,
  secrets: readonly (string | undefined)[] = [],
): string {
  let out = text || "unknown";
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out.replace(/\s+/g, " ").trim().slice(0, maxLength);
}
