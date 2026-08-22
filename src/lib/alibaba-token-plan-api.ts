import {
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
  secToken: string;
  loginTicket: string;
}

const USER_AGENT = "OpenCode-Quota-Toast/1.0";

export async function queryAlibabaTokenPlanQuota(
  options: AlibabaTokenPlanQuotaOptions,
): Promise<AlibabaTokenPlanQuotaResult> {
  const body = new URLSearchParams({
    product: ALIBABA_TOKEN_PLAN_REQUEST_DEFAULTS.product,
    action: ALIBABA_TOKEN_PLAN_REQUEST_DEFAULTS.action,
    sec_token: options.secToken,
  }).toString();

  try {
    return await fetchWithTimeout(ALIBABA_TOKEN_PLAN_QUOTA_URLS[options.endpoint], {
      request: {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `login_aliyunid_ticket=${options.loginTicket}`,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        body,
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (response) => {
        if (!response.ok) {
          const text = await response.text();
          return {
            success: false,
            code: String(response.status),
            message: `Alibaba Token Plan API error ${response.status}: ${sanitizeMessage(text, 120)}`,
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
                ? sanitizeMessage(record.message, 240)
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
      message: sanitizeMessage(err instanceof Error ? err.message : String(err)),
    };
  }
}

function sanitizeMessage(text: string, maxLength = 120): string {
  return (text || "unknown").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
