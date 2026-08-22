import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../src/core/errors.js";
import {
  clearAlibabaTokenPlanSecTokenCacheForTests,
  queryAlibabaPersonalUsage,
  queryAlibabaTokenPlanSeatQuota,
  resolveAlibabaTokenPlanSecToken,
} from "../src/lib/alibaba-token-plan-api.js";
import {
  extractLoginTicket,
  getAlibabaTokenPlanConfigCandidatePaths,
  resolveAlibabaTokenPlanAuth,
  resolveAlibabaTokenPlanAuthCached,
  sanitizeAlibabaTokenPlanConfig,
} from "../src/lib/alibaba-token-plan-auth.js";
import { alibabaTokenPlanProvider as cliAlibabaTokenPlanProvider } from "../src/providers/alibaba-token-plan.js";
import {
  alibabaTokenPlanCnProvider,
  alibabaTokenPlanRoutedProvider,
  clearAlibabaTokenPlanSourceBackoffForTests,
} from "../src/providers/alibaba-token-plan-routed.js";
import { fetchRows, rowSummary, useProviderWorld } from "./helpers/provider-fetch.js";

vi.mock("../src/lib/alibaba-token-plan-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/alibaba-token-plan-auth.js")>();
  return {
    ...actual,
    resolveAlibabaTokenPlanAuthCached: vi.fn(),
  };
});

vi.mock("../src/providers/alibaba-token-plan.js", () => ({
  alibabaTokenPlanProvider: {
    id: "alibaba-token-plan",
    isAvailable: vi.fn(async () => false),
    matchesCurrentModel: vi.fn(() => false),
    fetch: vi.fn(async () => ({ attempted: false, accounts: [], debug: [] })),
  },
}));

const SWITCH_AGENT = 12345;
const PERSONAL_URL = "https://bailian-cs.console.aliyun.com/data/api.json";
const TEAM_URL = "https://bailian.console.aliyun.com/data/api.json";

const RESET = "2026-08-23T08:00:00.000Z";

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

const EMPTY_TEAM = { code: "200", successResponse: true, data: { Data: { Items: [] } } };

/** Personal gateway success envelope (data.DataV2.data.data carries the usage fields). */
function personalEnvelope(usage: Record<string, number>) {
  return {
    code: "200",
    successResponse: true,
    data: {
      success: true,
      httpStatus: 200,
      errorCode: "",
      api: "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage",
      errorMsg: "",
      DataV2: {
        ret: ["SUCCESS::接口调用成功"],
        data: { msg: "Success.", code: "SUCCESS", success: true, data: usage },
      },
    },
  };
}

const PERSONAL_MONTHLY = personalEnvelope({
  per1MonthPercentage: 0.25,
  per1MonthResetTime: 1787472000000,
});

function mockJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html" } });
}

const fetchResponse = vi.fn();

const PAGE_TOKEN = "page-token";
const PAGE_HTML = `<script>SEC_TOKEN: "${PAGE_TOKEN}"</script>`;

/** URL-routed mock so parallel personal+team requests are order-independent. */
function mockSources(personal: unknown, team: unknown): void {
  fetchResponse.mockImplementation((url: unknown) => {
    const u = String(url);
    if (u === PERSONAL_URL) return Promise.resolve(mockJson(personal));
    if (u === TEAM_URL) return Promise.resolve(mockJson(team));
    return Promise.resolve(htmlResponse(PAGE_HTML));
  });
}

const calledUrls = () => fetchResponse.mock.calls.map(([url]) => String(url));

function setAuth(
  state: "configured" | "none",
  account: string[] = ["team-lead"],
  switchAgent: number | null = SWITCH_AGENT,
) {
  vi.mocked(resolveAlibabaTokenPlanAuthCached).mockResolvedValue(
    state === "configured"
      ? {
          state: "configured",
          config: {
            loginTicket: "test-ticket",
            ...(account.length > 0 ? { account } : {}),
            ...(switchAgent !== null ? { switchAgent } : {}),
          },
          source: "test",
        }
      : { state: "none" },
  );
}

/** A QuotaProviderContext whose runtime provider ids the caller chooses. */
const ctxFor = (runtimeIds: string[]) =>
  ({ resolveRuntimeProviderIds: async () => new Set(runtimeIds), config: {} }) as never;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchResponse);
  clearAlibabaTokenPlanSecTokenCacheForTests();
  clearAlibabaTokenPlanSourceBackoffForTests();
  vi.mocked(cliAlibabaTokenPlanProvider.fetch).mockResolvedValue({
    attempted: false,
    accounts: [],
    debug: [],
  });
  vi.mocked(cliAlibabaTokenPlanProvider.isAvailable).mockResolvedValue(false);
  setAuth("configured");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("alibaba-token-plan provider", () => {
  it("is registered with the canonical ids", () => {
    expect(alibabaTokenPlanRoutedProvider.id).toBe("alibaba-token-plan");
    expect(alibabaTokenPlanCnProvider.id).toBe("alibaba-token-plan-cn");
  });

  describe("isAvailable", () => {
    it("is available on a cookie alone, with no OpenCode runtime provider id", async () => {
      // Deliberately NOT gated on isCanonicalProviderAvailable. Live CLI check: OpenCode's runtime
      // id list here was [zenmux, igw, copilot, minimax-cn-coding-plan, kimi-for-coding,
      // deepseek] — our id is never in it, because our credential is a pasted console cookie
      // rather than an opencode.json provider. A selection gate would disable this feature
      // entirely while all 3239 unit tests still passed.
      await expect(alibabaTokenPlanCnProvider.isAvailable(ctxFor([]))).resolves.toBe(true);
      await expect(alibabaTokenPlanRoutedProvider.isAvailable(ctxFor([]))).resolves.toBe(true);
    });

    it("is unavailable with no cookie and no CLI backend", async () => {
      setAuth("none");

      await expect(alibabaTokenPlanCnProvider.isAvailable(ctxFor([]))).resolves.toBe(false);
    });

    it("delegates an international route with no cookie to the CLI backend", async () => {
      setAuth("none");
      vi.mocked(cliAlibabaTokenPlanProvider.isAvailable).mockResolvedValue(true);

      expect(await alibabaTokenPlanRoutedProvider.isAvailable(ctxFor([]))).toBe(true);
    });

    it("has no CLI fallback on the China route", async () => {
      setAuth("none");

      expect(await alibabaTokenPlanCnProvider.isAvailable(ctxFor(["alibaba-token-plan-cn"]))).toBe(
        false,
      );
    });
  });

  describe("personal + team fetch", () => {
    it("shows the personal monthly percent and one credits account per seat", async () => {
      mockSources(PERSONAL_MONTHLY, ONE_SEAT);

      const fetched = await fetchRows(alibabaTokenPlanCnProvider);

      expect(rowSummary(fetched.rows)).toEqual([
        ["alibaba-token-plan-cn.monthly", "personal", "Monthly", "month", 75, RESET],
        [
          "alibaba-token-plan-cn.credits",
          "team",
          "Credits",
          "month",
          "0 (211291 credit of 211291 credit)",
          RESET,
        ],
      ]);
      expect(fetched.error).toBeUndefined();
      expect(fetched.debug).toEqual(
        expect.arrayContaining([
          { key: "config_state", value: "configured" },
          { key: "config_source", value: "test" },
          { key: "api_endpoint", value: "china" },
          { key: "api_base_url", value: TEAM_URL },
          { key: "personal_api_base_url", value: PERSONAL_URL },
          { key: "personal_state", value: "ok" },
          { key: "team_state", value: "ok" },
        ]),
      );
    });

    it("sends personal + team as one parallel batch sharing the page sec_token", async () => {
      mockSources(PERSONAL_MONTHLY, ONE_SEAT);
      await alibabaTokenPlanCnProvider.fetch({ config: {} } as never);

      const urls = calledUrls();
      expect(urls.filter((u) => u.endsWith(".com/"))).toHaveLength(1); // one page fetch
      expect(urls).toContain(PERSONAL_URL);
      expect(urls).toContain(TEAM_URL);

      const [personalCall] = fetchResponse.mock.calls.filter(([u]) => String(u) === PERSONAL_URL);
      expect(personalCall![1].headers.Cookie).toBe("login_aliyunid_ticket=test-ticket");
      expect(personalCall![1].body).toContain("sec_token=page-token");
      expect(personalCall![1].body).toContain(`%22switchAgent%22%3A${SWITCH_AGENT}`);

      const [teamCall] = fetchResponse.mock.calls.filter(([u]) => String(u) === TEAM_URL);
      expect(teamCall![1].body).toBe(
        `product=ModelStudio&action=GetSubscriptionSeatDetails&sec_token=${PAGE_TOKEN}`,
      );
    });

    it("skips personal (no_switch_agent) and still queries team", async () => {
      setAuth("configured", ["team-lead"], null);
      mockSources(PERSONAL_MONTHLY, ONE_SEAT);

      const fetched = await fetchRows(alibabaTokenPlanCnProvider);

      expect(rowSummary(fetched.rows).map(([id]) => id)).toEqual(["alibaba-token-plan-cn.credits"]);
      expect(calledUrls()).not.toContain(PERSONAL_URL);
      expect(fetched.debug).toContainEqual({ key: "personal_state", value: "no_switch_agent" });
    });

    it("skips team (no_account) and still queries personal", async () => {
      setAuth("configured", [], SWITCH_AGENT);
      mockSources(PERSONAL_MONTHLY, ONE_SEAT);

      const fetched = await fetchRows(alibabaTokenPlanCnProvider);

      expect(rowSummary(fetched.rows).map(([id]) => id)).toEqual(["alibaba-token-plan-cn.monthly"]);
      expect(calledUrls()).not.toContain(TEAM_URL);
      expect(fetched.debug).toContainEqual({ key: "team_state", value: "no_account" });
    });

    it("blames stale data, not setup, when neither source can run", async () => {
      // A dead login ticket makes the console answer with an empty seat list, which is
      // indistinguishable from a missing account filter. Saying "not configured" would be a lie
      // (config_state is "configured") and would render as "Not set up".
      setAuth("configured", [], null);
      mockSources(PERSONAL_MONTHLY, ONE_SEAT);

      const fetched = await fetchRows(alibabaTokenPlanCnProvider);

      expect(fetched.rows).toEqual([]);
      expect(fetched.error).toMatchObject({ code: "no_data" });
      expect(fetchResponse).not.toHaveBeenCalled();
      expect(fetched.debug).toEqual(
        expect.arrayContaining([
          { key: "personal_state", value: "no_switch_agent" },
          { key: "team_state", value: "no_account" },
        ]),
      );
    });

    it("keeps team data and surfaces the personal failure as an error", async () => {
      const personalFailure = {
        code: "200",
        successResponse: true,
        data: { success: false, errorCode: "BailianGateway.Login.NotLogined", errorMsg: "nope" },
      };
      mockSources(personalFailure, ONE_SEAT);

      const fetched = await fetchRows(alibabaTokenPlanCnProvider);

      // The failure reaches `errors` (and there through rows.ts) even though team rows survive.
      expect(fetched.error).toMatchObject({ code: "internal" });
      expect(fetched.debug).toContainEqual({
        key: "error",
        value: "Alibaba Token Plan (CN): nope",
      });
      expect(rowSummary(fetched.rows).map(([id, account]) => [id, account])).toEqual([
        ["alibaba-token-plan-cn.credits", "team"],
      ]);
      expect(fetched.debug).toContainEqual({ key: "personal_state", value: "failed" });
    });

    it("says so, with both source states, when neither source has data", async () => {
      mockSources(personalEnvelope({}), EMPTY_TEAM);

      const fetched = await fetchRows(alibabaTokenPlanCnProvider);

      expect(fetched.rows).toEqual([]);
      expect(fetched.error).toMatchObject({ code: "no_data" });
      expect(fetched.debug).toEqual(
        expect.arrayContaining([
          { key: "personal_state", value: "no_data" },
          { key: "team_state", value: "no_data" },
        ]),
      );
    });

    it("delegates to the CLI backend, with its cache context, when auth is none", async () => {
      setAuth("none");
      vi.mocked(cliAlibabaTokenPlanProvider.fetch).mockResolvedValue({
        attempted: true,
        accounts: [{ name: "Alibaba Personal Token Plan", rows: [], errors: [] }],
        debug: [{ key: "cli_available", value: "true" }],
      });
      const cacheContext = { runtimeEligibleQuotaProviders: [] };

      const out = await alibabaTokenPlanRoutedProvider.fetch({ config: {} } as never, cacheContext);

      expect(fetchResponse).not.toHaveBeenCalled();
      expect(cliAlibabaTokenPlanProvider.fetch).toHaveBeenCalledWith(
        expect.anything(),
        cacheContext,
      );
      expect(out).toMatchObject({
        attempted: true,
        debug: [{ key: "cli_available", value: "true" }],
      });
    });

    it("keeps the -cn route on china and never delegates to the CLI", async () => {
      setAuth("none");

      const out = await alibabaTokenPlanCnProvider.fetch({ config: {} } as never);

      expect(out).toEqual({ attempted: false, accounts: [], debug: [] });
      expect(fetchResponse).not.toHaveBeenCalled();
      expect(cliAlibabaTokenPlanProvider.fetch).not.toHaveBeenCalled();
    });
  });

  describe("empty-result backoff", () => {
    it("backs off a source that returns no rows and skips it next fetch", async () => {
      mockSources(personalEnvelope({}), EMPTY_TEAM); // both empty

      const first = await alibabaTokenPlanCnProvider.fetch({ config: {} } as never);
      expect(first.debug).toContainEqual({ key: "personal_state", value: "no_data" });
      expect(first.debug).toContainEqual({ key: "team_state", value: "no_data" });
      const firstCallCount = fetchResponse.mock.calls.length;

      const second = await alibabaTokenPlanCnProvider.fetch({ config: {} } as never);
      expect(second.debug).toContainEqual({ key: "personal_state", value: "backoff" });
      expect(second.debug).toContainEqual({ key: "team_state", value: "backoff" });
      expect(fetchResponse.mock.calls.length).toBe(firstCallCount); // no new requests
    });

    it("clears backoff once a source produces rows again", async () => {
      mockSources(personalEnvelope({}), EMPTY_TEAM);
      await alibabaTokenPlanCnProvider.fetch({ config: {} } as never);

      clearAlibabaTokenPlanSourceBackoffForTests();
      mockSources(PERSONAL_MONTHLY, ONE_SEAT);
      const fetched = await fetchRows(alibabaTokenPlanCnProvider);

      expect(
        rowSummary(fetched.rows)
          .map(([id]) => id)
          .sort(),
      ).toEqual(["alibaba-token-plan-cn.credits", "alibaba-token-plan-cn.monthly"]);
    });
  });

  describe("account whitelist filter", () => {
    it.each([
      ["team-lead", 1],
      ["other-account", 0],
    ] as const)("account=%s → %i team account", async (account, expectedCount) => {
      setAuth("configured", [account]);
      mockSources(personalEnvelope({}), ONE_SEAT);

      const fetched = await fetchRows(alibabaTokenPlanCnProvider);

      const seatRows = fetched.rows.filter((row) => row.id.endsWith(".credits"));
      expect(seatRows).toHaveLength(expectedCount);
    });
  });
});

describe("resolveAlibabaTokenPlanAuth", () => {
  const world = useProviderWorld();
  const configPath = () => join(world.configDir, "opencode-quota", "alibaba-token-plan.json");

  it("resolves the cookie, account filter and switchAgent from the environment", async () => {
    process.env.ALIBABA_TOKEN_PLAN_COOKIE = "Cookie: login_aliyunid_ticket=env-ticket; x=1";
    process.env.ALIBABA_TOKEN_PLAN_ACCOUNT = " team-lead, other , team-lead ";
    process.env.ALIBABA_TOKEN_PLAN_SWITCH_AGENT = "12345";

    await expect(resolveAlibabaTokenPlanAuth()).resolves.toEqual({
      state: "configured",
      config: { loginTicket: "env-ticket", account: ["team-lead", "other"], switchAgent: 12345 },
      source: "env:ALIBABA_TOKEN_PLAN_COOKIE",
    });
  });

  it("resolves the config file when the environment has no cookie", async () => {
    world.writeConfigFile(
      "opencode-quota/alibaba-token-plan.json",
      JSON.stringify({ cookie: "file-ticket", account: ["team-lead"] }),
    );

    await expect(resolveAlibabaTokenPlanAuth()).resolves.toEqual({
      state: "configured",
      config: { loginTicket: "file-ticket", account: ["team-lead"] },
      source: configPath(),
    });
    expect(getAlibabaTokenPlanConfigCandidatePaths()).toEqual([configPath()]);
  });

  it.each([
    ["a malformed file", "{", "Failed to parse JSON"],
    ["a non-object root", "[]", "Config file must contain a JSON object"],
    [
      "an unknown field",
      JSON.stringify({ cookie: "abc", extra: 1 }),
      'Config file has unknown field "extra"',
    ],
  ])("reports %s with a fixed message", async (_name, contents, error) => {
    world.writeConfigFile("opencode-quota/alibaba-token-plan.json", contents);

    await expect(resolveAlibabaTokenPlanAuth()).resolves.toEqual({
      state: "invalid",
      source: configPath(),
      error,
    });
  });

  it("is none without a cookie in the environment or a config file", async () => {
    await expect(resolveAlibabaTokenPlanAuth()).resolves.toEqual({ state: "none" });
  });
});

describe("sanitizeAlibabaTokenPlanConfig", () => {
  it.each([
    [
      "full Cookie header",
      { cookie: "login_aliyunid_ticket=abc; other=1" },
      { loginTicket: "abc" },
    ],
    ["bare ticket value", { cookie: "abc123.def" }, { loginTicket: "abc123.def" }],
    ["loginTicket / login_ticket alias keys", { login_ticket: "abc" }, { loginTicket: "abc" }],
    [
      "account whitelist dropping empty/non-string/duplicate entries",
      { cookie: "abc", account: ["", "  ", 42, null, "etfpub", "etfpub"] },
      { loginTicket: "abc", account: ["etfpub"] },
    ],
    [
      "switchAgent as a positive integer string",
      { cookie: "abc", switch_agent: "12345" },
      { loginTicket: "abc", switchAgent: 12345 },
    ],
    [
      "switchAgent ignored when not a positive number",
      { cookie: "abc", switchAgent: 0 },
      { loginTicket: "abc" },
    ],
  ])("%s", (_label, input, expected) => {
    expect(sanitizeAlibabaTokenPlanConfig(input as Record<string, unknown>)).toEqual({
      ok: true,
      config: expected,
    });
  });

  it.each([
    ["no credential", {}, "missing loginTicket"],
    ["a CRLF-injected header", { cookie: "a=1\r\nInjected: x" }, "missing loginTicket"],
  ])("rejects %s", (_label, input, error) => {
    expect(sanitizeAlibabaTokenPlanConfig(input as Record<string, unknown>)).toEqual({
      ok: false,
      error,
    });
  });
});

describe("extractLoginTicket", () => {
  it("strips a Cookie: prefix and keeps the first duplicate or = inside the value", () => {
    expect(extractLoginTicket("Cookie: login_aliyunid_ticket=a=1; x=2")).toBe("a=1");
    expect(extractLoginTicket("login_aliyunid_ticket=first; login_aliyunid_ticket=second")).toBe(
      "first",
    );
  });

  it("accepts a bare ticket value when no ticket name is present", () => {
    expect(extractLoginTicket("  bare-ticket.value  ")).toBe("bare-ticket.value");
    expect(extractLoginTicket("other=1; another=2")).toBe("other=1; another=2");
  });

  it("returns undefined for CR/LF injection or an empty value", () => {
    expect(extractLoginTicket("login_aliyunid_ticket=a\r\nInjected: x")).toBeUndefined();
    expect(extractLoginTicket("   ")).toBeUndefined();
  });
});

const TICKET = "abc";
const SEC_TOKEN = "abc123";
const NO_TOKEN_HTML = "<html>nothing here</html>";
const resolve = (fetchFn: typeof fetch, loginTicket = TICKET) =>
  resolveAlibabaTokenPlanSecToken({ endpoint: "china", loginTicket, fetchFn });

const secTokenHtml = (value = SEC_TOKEN) => htmlResponse(`<script>SEC_TOKEN: "${value}"</script>`);
const okToken = { ok: true, value: SEC_TOKEN } as const;

describe("resolveAlibabaTokenPlanSecToken", () => {
  it("extracts SEC_TOKEN, sends only the ticket cookie, and caches the result", async () => {
    const fetchFn = vi.fn().mockResolvedValue(secTokenHtml());
    expect(await resolve(fetchFn)).toEqual(okToken);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://bailian.console.aliyun.com/");
    expect(init.headers.Cookie).toBe(`login_aliyunid_ticket=${TICKET}`);
    expect(init.redirect).toBe("manual");
    expect(await resolve(fetchFn)).toEqual(okToken);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures", async () => {
    const fetchFn = vi.fn().mockResolvedValue(htmlResponse(NO_TOKEN_HTML));
    expect(await resolve(fetchFn)).toMatchObject({ ok: false });
    expect(await resolve(fetchFn)).toMatchObject({ ok: false });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a 302", htmlResponse("", 302), "session expired"],
    ["a page without sec_token", htmlResponse(NO_TOKEN_HTML), "not found"],
  ] as const)("rejects %s", async (_label, response, expected) => {
    const out = await resolve(vi.fn().mockResolvedValue(response) as typeof fetch);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining(expected) });
  });
});

describe("queryAlibabaTokenPlanSeatQuota sec_token handling", () => {
  const pageCalls = () => fetchResponse.mock.calls.filter(([url]) => String(url).endsWith(".com/"));
  const query = (loginTicket = TICKET) =>
    queryAlibabaTokenPlanSeatQuota({ endpoint: "china", loginTicket });

  it("sends only the ticket cookie, never other pasted cookies", async () => {
    const pasted = "login_aliyunid_ticket=abc; _bl_uid=xyz; zz_marker=SENTINEL";
    fetchResponse.mockResolvedValueOnce(secTokenHtml()).mockResolvedValueOnce(mockJson(ONE_SEAT));

    expect((await query(extractLoginTicket(pasted) ?? "")).success).toBe(true);
    const calls = JSON.stringify(fetchResponse.mock.calls);
    expect(fetchResponse.mock.calls.map(([, init]) => init.headers.Cookie)).toEqual([
      `login_aliyunid_ticket=${TICKET}`,
      `login_aliyunid_ticket=${TICKET}`,
    ]);
    expect(calls).not.toContain("SENTINEL");
    expect(calls).not.toContain("_bl_uid");
  });

  const postOnly = () => mockJson({ code: "PostonlyOrTokenError", successResponse: false });

  it("retries once in-band on PostonlyOrTokenError with a rotated auto-fetched token", async () => {
    const staleThen = (outcome: () => Response) =>
      fetchResponse
        .mockResolvedValueOnce(secTokenHtml("stale"))
        .mockResolvedValueOnce(postOnly())
        .mockResolvedValueOnce(secTokenHtml("fresh"))
        .mockResolvedValueOnce(outcome());

    staleThen(() => mockJson(ONE_SEAT));
    expect((await query()).success).toBe(true);
    expect(pageCalls()).toHaveLength(2);
    expect(fetchResponse.mock.calls[1][1].body).toContain("sec_token=stale");
    expect(fetchResponse.mock.calls[3][1].body).toContain("sec_token=fresh");

    fetchResponse.mockReset();
    clearAlibabaTokenPlanSecTokenCacheForTests();
    staleThen(postOnly);
    expect(await query()).toMatchObject({
      success: false,
      code: "PostonlyOrTokenError",
      message: expect.stringContaining("PostonlyOrTokenError"),
    });
    expect(pageCalls()).toHaveLength(2);
  });

  it("does not retry when the token is unchanged (re-resolve returns the same secret)", async () => {
    fetchResponse
      .mockResolvedValueOnce(secTokenHtml())
      .mockResolvedValueOnce(postOnly())
      .mockResolvedValueOnce(secTokenHtml());
    expect(await query()).toMatchObject({
      success: false,
      code: "PostonlyOrTokenError",
      message: expect.stringContaining("PostonlyOrTokenError"),
    });
    expect(pageCalls()).toHaveLength(2);
    expect(fetchResponse).toHaveBeenCalledTimes(3);
  });

  it("surfaces a failed page fetch as SecTokenResolutionError without leaking the ticket", async () => {
    const secret = "SUPER_SECRET_TICKET";
    fetchResponse.mockResolvedValueOnce(htmlResponse("", 302));
    const out = await query(secret);
    expect(out).toMatchObject({
      success: false,
      code: "SecTokenResolutionError",
      message: expect.stringContaining("session expired"),
    });
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it("classifies an API 302/401 as LoginRequired without following it", async () => {
    for (const status of [302, 401]) {
      fetchResponse.mockReset();
      clearAlibabaTokenPlanSecTokenCacheForTests();
      fetchResponse
        .mockResolvedValueOnce(secTokenHtml())
        .mockResolvedValueOnce(new Response("", { status, headers: { location: "/signin" } }));
      expect(await query()).toMatchObject({
        success: false,
        code: "LoginRequired",
        message: expect.stringContaining("expired"),
      });
      expect(fetchResponse.mock.calls[1][1].redirect).toBe("manual");
    }
  });

  it("classifies the login failure as login_expired so the store says 'Sign in again'", async () => {
    // The wording of our own failure messages is what classifyError matches on; rewording
    // them silently downgrades the rendered guidance, so pin the classification here.
    for (const status of [401, 403]) {
      fetchResponse.mockReset();
      clearAlibabaTokenPlanSecTokenCacheForTests();
      fetchResponse
        .mockResolvedValueOnce(secTokenHtml())
        .mockResolvedValueOnce(new Response("", { status, headers: { location: "/signin" } }));

      const out = await query();
      expect(out.success).toBe(false);
      expect(classifyError(out.message ?? "")).toMatchObject({ code: "login_expired" });
    }
  });

  it("redacts the sec_token when the API echoes it in an error message", async () => {
    const echoed = `token rejected: ${SEC_TOKEN}`;
    fetchResponse
      .mockResolvedValueOnce(secTokenHtml())
      .mockResolvedValueOnce(mockJson({ code: "Boom", successResponse: false, message: echoed }));

    const out = await query();
    expect(out).toMatchObject({ success: false, message: expect.stringContaining("[redacted]") });
    expect(JSON.stringify(out)).not.toContain(SEC_TOKEN);
  });
});

describe("queryAlibabaPersonalUsage sec_token handling", () => {
  const pageCalls = () => fetchResponse.mock.calls.filter(([url]) => String(url).endsWith(".com/"));
  const query = () =>
    queryAlibabaPersonalUsage({
      endpoint: "china",
      loginTicket: TICKET,
      switchAgent: SWITCH_AGENT,
    });

  const postOnly = () => mockJson({ code: "PostonlyOrTokenError", data: { success: false } });

  it("retries once in-band on PostonlyOrTokenError with a rotated auto-fetched token", async () => {
    fetchResponse
      .mockResolvedValueOnce(secTokenHtml("stale"))
      .mockResolvedValueOnce(postOnly())
      .mockResolvedValueOnce(secTokenHtml("fresh"))
      .mockResolvedValueOnce(mockJson(PERSONAL_MONTHLY));

    expect(await query()).toMatchObject({ success: true });
    expect(pageCalls()).toHaveLength(2);
    expect(fetchResponse.mock.calls[1][1].body).toContain("sec_token=stale");
    expect(fetchResponse.mock.calls[3][1].body).toContain("sec_token=fresh");
  });
});
