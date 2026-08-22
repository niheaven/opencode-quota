export type AlibabaTokenPlanEndpointId = "international" | "china";

export const ALIBABA_TOKEN_PLAN_QUOTA_URLS: Readonly<Record<AlibabaTokenPlanEndpointId, string>> = {
  international: "https://modelstudio.console.alibabacloud.com/data/api.json",
  china: "https://bailian.console.aliyun.com/data/api.json",
};

export const ALIBABA_TOKEN_PLAN_REQUEST_DEFAULTS = Object.freeze({
  action: "GetSubscriptionSeatDetails",
  product: "ModelStudio",
});
