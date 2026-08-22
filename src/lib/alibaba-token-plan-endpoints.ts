export type AlibabaTokenPlanEndpointId = "international" | "china";

export const ALIBABA_TOKEN_PLAN_QUOTA_URLS: Readonly<Record<AlibabaTokenPlanEndpointId, string>> = {
  international: "https://modelstudio.console.alibabacloud.com/data/api.json",
  china: "https://bailian.console.aliyun.com/data/api.json",
};

export const ALIBABA_TOKEN_PLAN_REQUEST_DEFAULTS = Object.freeze({
  action: "GetSubscriptionSeatDetails",
  product: "ModelStudio",
});

/**
 * Console gateway hosts for the PERSONAL Token Plan usage API (monthly percentage).
 * Distinct from {@link ALIBABA_TOKEN_PLAN_QUOTA_URLS} (the team seat API hosts).
 */
export const ALIBABA_TOKEN_PLAN_PERSONAL_URLS: Readonly<
  Record<AlibabaTokenPlanEndpointId, string>
> = {
  international: "https://bailian-singapore-cs.alibabacloud.com/data/api.json",
  china: "https://bailian-cs.console.aliyun.com/data/api.json",
};

/** Console gateway API name for the personal Token Plan usage (percentage windows). */
export const ALIBABA_TOKEN_PLAN_PERSONAL_API =
  "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
