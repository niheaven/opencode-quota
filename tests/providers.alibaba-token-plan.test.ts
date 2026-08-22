import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveAlibabaTokenPlanAuthCached,
  sanitizeAlibabaTokenPlanConfig,
} from "../src/lib/alibaba-token-plan-auth.js";
import {
  alibabaTokenPlanCnProvider,
  alibabaTokenPlanProvider,
} from "../src/providers/alibaba-token-plan.js";

vi.mock("../src/lib/alibaba-token-plan-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/alibaba-token-plan-auth.js")>();
  return {
    ...actual,
    resolveAlibabaTokenPlanAuthCached: vi.fn(),
  };
});

const ONE_SEAT = {
  code: "200",
  successResponse: true,
  data: {
    Data: {
      Items: [
        {
          Status: "NORMAL",
          AccountName: "team-lead",
          EquityList: [
            {
              EquityType: "CREDITS",
              CycleTotalValue: 211291,
              CycleSurplusValue: 0,
              CycleEndTime: 1787472000000,
            },
          ],
        },
      ],
    },
  },
};

function mockJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const fetchResponse = vi.fn();

function setAuth(state: "configured" | "none", account?: string[]) {
  vi.mocked(resolveAlibabaTokenPlanAuthCached).mockResolvedValue(
    state === "configured"
      ? {
          state: "configured",
          config: { secToken: "test-sec-token", loginTicket: "test-ticket", account },
          source: "test",
        }
      : { state: "none" },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchResponse);
  setAuth("configured");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("alibaba-token-plan provider", () => {
  it.each([
    ["alibaba-token-plan", alibabaTokenPlanProvider],
    ["alibaba-token-plan-cn", alibabaTokenPlanCnProvider],
  ] as const)("%s is registered with the right id", (id, provider) => {
    expect(provider.id).toBe(id);
  });

  describe("entry shape", () => {
    it("emits one entry with credit basis (3 facts, count unit)", async () => {
      fetchResponse.mockResolvedValueOnce(mockJson(ONE_SEAT));

      const out = await alibabaTokenPlanCnProvider.fetch({ config: {} } as any);

      expect(out.attempted).toBe(true);
      expect(out.errors).toEqual([]);
      expect(out.entries).toHaveLength(1);

      const entry = out.entries[0];
      expect(entry).toMatchObject({
        name: "alibaba-token-plan-team-lead",
        label: "team-lead:",
        percentRemaining: 0,
        semantic: { metric: { kind: "window", window: "month" }, prominence: "primary" },
        resetTimeIso: "2026-08-23T08:00:00.000Z",
      });
      expect(entry.basis).toEqual({
        used: {
          quantity: { decimal: "211291", unit: { kind: "count", unit: "credit" } },
          authority: "provider_reported",
        },
        limit: {
          quantity: { decimal: "211291", unit: { kind: "count", unit: "credit" } },
          authority: "provider_reported",
        },
        remaining: {
          quantity: { decimal: "0", unit: { kind: "count", unit: "credit" } },
          authority: "provider_reported",
        },
      });
    });

    it("sends form-urlencoded body and Cookie with login_aliyunid_ticket", async () => {
      fetchResponse.mockResolvedValueOnce(mockJson(ONE_SEAT));
      await alibabaTokenPlanCnProvider.fetch({ config: {} } as any);

      const [url, init] = fetchResponse.mock.calls[0];
      expect(url).toBe("https://bailian.console.aliyun.com/data/api.json");
      expect(init.headers.Cookie).toBe("login_aliyunid_ticket=test-ticket");
      expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(init.body).toBe(
        "product=ModelStudio&action=GetSubscriptionSeatDetails&sec_token=test-sec-token",
      );
    });

    it("skips non-NORMAL seats", async () => {
      const body = {
        code: "200",
        data: { Data: { Items: [{ ...ONE_SEAT.data.Data.Items[0], Status: "EXPIRED" }] } },
      };
      fetchResponse.mockResolvedValueOnce(mockJson(body));
      const out = await alibabaTokenPlanCnProvider.fetch({ config: {} } as any);
      expect(out.entries).toEqual([]);
    });
  });

  describe("account whitelist filter", () => {
    it.each([
      ["team-lead", 1, "alibaba-token-plan-team-lead"],
      ["other-account", 0, null],
    ] as const)("account=%s → %i entry", async (account, expectedCount, expectedName) => {
      setAuth("configured", [account]);
      fetchResponse.mockResolvedValueOnce(mockJson(ONE_SEAT));
      const out = await alibabaTokenPlanCnProvider.fetch({ config: {} } as any);
      expect(out.entries).toHaveLength(expectedCount);
      if (expectedName) expect(out.entries[0]?.name).toBe(expectedName);
    });
  });

  describe("error handling", () => {
    it.each([
      ["ConsoleNeedLogin", "missing login_ticket"],
      ["ParamsInvalid", "missing product param"],
      ["PostonlyOrTokenError", "expired sec_token"],
    ] as const)("surfaces %s as an attempted error", async (code, scenario) => {
      fetchResponse.mockResolvedValueOnce(mockJson({ code, successResponse: false }));
      const out = await alibabaTokenPlanCnProvider.fetch({ config: {} } as any);
      expect(out.attempted).toBe(true);
      expect(out.entries).toEqual([]);
      expect(out.errors[0]?.message).toContain(code);
    });

    it("treats successResponse: true as success even when code is missing", async () => {
      fetchResponse.mockResolvedValueOnce(mockJson({ successResponse: true, data: ONE_SEAT.data }));
      const out = await alibabaTokenPlanCnProvider.fetch({ config: {} } as any);
      expect(out.attempted).toBe(true);
      expect(out.entries).toHaveLength(1);
    });
  });
});

describe("sanitizeAlibabaTokenPlanConfig", () => {
  const VALID = { secToken: "s", loginTicket: "t" };

  it.each([
    ["required fields only", VALID, { secToken: "s", loginTicket: "t" }],
    [
      "login_ticket as snake_case",
      { secToken: "s", login_ticket: "t" },
      { secToken: "s", loginTicket: "t" },
    ],
    [
      "account whitelist",
      { ...VALID, account: ["etfpub", "rmpub"] },
      { secToken: "s", loginTicket: "t", account: ["etfpub", "rmpub"] },
    ],
    [
      "drops empty / non-string / duplicate account entries",
      { ...VALID, account: ["", "  ", 42, null, "etfpub", "etfpub"] },
      { secToken: "s", loginTicket: "t", account: ["etfpub"] },
    ],
    [
      "omits account when list is empty",
      { ...VALID, account: [] },
      { secToken: "s", loginTicket: "t" },
    ],
    [
      "omits account when not an array",
      { ...VALID, account: "nope" },
      { secToken: "s", loginTicket: "t" },
    ],
  ])("%s", (_label, input, expected) => {
    expect(sanitizeAlibabaTokenPlanConfig(input as Record<string, unknown>)).toEqual({
      ok: true,
      config: expected,
    });
  });

  it.each([
    ["missing secToken", { loginTicket: "t" }],
    ["missing ticket", { secToken: "s" }],
  ])("rejects %s", (_label, input) => {
    expect(sanitizeAlibabaTokenPlanConfig(input as Record<string, unknown>)).toMatchObject({
      ok: false,
    });
  });
});
