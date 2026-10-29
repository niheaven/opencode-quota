import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QuotaSnapshot } from "../src/core/types.js";
import type { AnthropicQuotaResult } from "../src/lib/anthropic.js";
import { anthropicProvider } from "../src/providers/anthropic.js";
import { createQuotaClient } from "../src/tui/client.js";
import { useOpencodeFolders } from "./helpers/opencode-folders.js";
import { createServerContext, writePluginTestSettings } from "./helpers/plugin-test-harness.js";
import { createQuotaRpcBridge, createQuotaRpcEvents } from "./helpers/quota-rpc-bridge.js";

const credentials = vi.hoisted(() => ({
  available: vi.fn(),
  cli: vi.fn(),
  oauth: vi.fn(),
}));

// Only the credential/transport boundary is fake. Selection, availability, source, store,
// server RPC, JSON broadcasts and TUI clients all run their real code.
vi.mock("../src/lib/anthropic.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/anthropic.js")>()),
  hasAnthropicCredentialsConfigured: credentials.available,
  readAnthropicLogins: async () => [
    {
      row: {
        id: "account-A",
        integrationId: "anthropic",
        label: "Account A",
        active: true,
        value: { type: "oauth", access: "fake-account-A" },
      },
      auth: { state: "configured", accessToken: "fake-account-A" },
    },
  ],
  anthropicLoginsIdentity: async (logins: unknown[]) =>
    logins.length ? "opencode-account-A" : null,
  getAnthropicDiagnostics: credentials.cli,
  queryAnthropicQuotaWithOAuth: credentials.oauth,
}));

const folders = useOpencodeFolders();
const cleanups: Array<() => unknown> = [];

function quota(percentRemaining: number): AnthropicQuotaResult {
  return {
    success: true,
    five_hour: { percentRemaining },
    seven_day: { percentRemaining },
  };
}

function cliQuota(percentRemaining: number) {
  return {
    installed: true,
    authStatus: "authenticated",
    quotaSupported: true,
    quotaSource: "claude-auth-status-json",
    checkedCommands: [],
    quota: quota(percentRemaining),
  };
}

function remaining(snapshot: QuotaSnapshot | undefined) {
  return snapshot?.providers.find((provider) => provider.providerId === "anthropic")?.rows[0]
    ?.percentRemaining;
}

async function setup() {
  const loginChange = Promise.withResolvers<void>();
  const fake = createServerContext({
    directory: folders.root,
    openCodeProviders: ["anthropic", "claude-code"],
    sessionGet: vi.fn(async ({ sessionID }) => ({
      model: { id: "claude-sonnet-4-5", providerID: sessionID },
    })),
    events: {
      async *[Symbol.asyncIterator]() {
        await loginChange.promise;
        yield { type: "credential.switched" };
      },
    },
  });
  const events = createQuotaRpcEvents();
  fake.emit.mockImplementation(events.emit);
  const { createQuotaServerPlugin } = await import("../src/plugin.js");
  const cleanup = await createQuotaServerPlugin({ providers: () => [anthropicProvider] }).setup(
    fake.ctx as never,
  );
  if (typeof cleanup === "function") cleanups.push(cleanup);
  const handlers = fake.ctx.rpc.register.mock.calls[0]?.[1];
  if (!handlers) throw new Error("quota RPC was not registered");
  function client() {
    const client = createQuotaClient({
      location: { directory: folders.root },
      data: {},
      client: { rpc: createQuotaRpcBridge(handlers, events) as never },
    });
    cleanups.push(client.start());
    return client;
  }
  return {
    client,
    emit: fake.emit,
    loginChanged: () => loginChange.resolve(),
    saveSettings: (patch: object) =>
      handlers.saveSettings({ patch }, { signal: new AbortController().signal }),
  };
}

describe("Anthropic runtime delivery", () => {
  beforeEach(() => {
    credentials.available.mockReset().mockResolvedValue(true);
    credentials.cli.mockReset().mockResolvedValue(cliQuota(40));
    credentials.oauth.mockReset().mockResolvedValue(quota(90));
    writePluginTestSettings(folders.configDir, {
      providers: { checking: { minIntervalMs: 60_000 } },
    });
  });

  afterEach(async () => {
    // Stop clients first, then wait for the server's outstanding fetches and writes.
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it.each(["one TUI", "two TUIs"])(
    "keeps two sessions on their selected logins through RPC answers and broadcasts in %s",
    async (surfaces) => {
      const server = await setup();
      const a = server.client();
      const b = surfaces === "one TUI" ? a : server.client();
      await b.refresh("manual", "claude-code");
      expect(remaining(b.snapshot("claude-code"))).toBe(40);
      await a.refresh("manual", "anthropic");

      expect(server.emit).toHaveBeenCalledWith("changed", expect.anything());
      expect(remaining(a.snapshot("anthropic"))).toBe(90);
      expect(remaining(b.snapshot("claude-code"))).toBe(40);

      // A third client's refresh reaches B only through the server's broadcast.
      credentials.cli.mockResolvedValue(cliQuota(35));
      await server.client().refresh("manual", "claude-code");
      expect(remaining(b.snapshot("claude-code"))).toBe(35);
      expect(remaining(a.snapshot("anthropic"))).toBe(90);
    },
  );

  it("keeps an unavailable Claude Code login out of its session after another runtime broadcasts", async () => {
    credentials.available.mockImplementation(
      async ({ useClaudeCodeCredentials }) => !useClaudeCodeCredentials,
    );
    const server = await setup();
    const a = server.client();
    const b = server.client();
    await b.refresh("manual", "claude-code");
    expect(b.snapshot("claude-code")?.providers).toEqual([]);
    await a.refresh("manual", "anthropic");
    expect(remaining(a.snapshot("anthropic"))).toBe(90);
    expect(b.snapshot("claude-code")?.providers).toEqual([]);
    expect(credentials.cli).not.toHaveBeenCalled();
  });

  it.each(["settings recheck", "settings change", "credential event"])(
    "refreshes the active Claude Code login after a %s",
    async (change) => {
      const server = await setup();
      const b = server.client();
      await b.refresh("manual", "claude-code");
      expect(remaining(b.snapshot("claude-code"))).toBe(40);
      server.emit.mockClear();
      credentials.cli.mockResolvedValue(cliQuota(35));
      if (change === "credential event") server.loginChanged();
      else if (change === "settings recheck") {
        await server.saveSettings({ providers: { checking: { requestTimeoutMs: 12_000 } } });
      } else {
        await server.saveSettings({ words: { percent: "used" } });
      }

      // A plain settings change keeps the minimum interval; a recheck or login event fetches.
      const expected = change === "settings change" ? 40 : 35;
      await vi.waitFor(() => expect(server.emit).toHaveBeenCalled());
      await vi.waitFor(() => expect(remaining(b.snapshot("claude-code"))).toBe(expected));
      if (change !== "settings change") expect(credentials.cli).toHaveBeenCalledTimes(2);
      expect(credentials.available).toHaveBeenLastCalledWith(
        expect.objectContaining({ useClaudeCodeCredentials: true }),
      );
    },
  );

  it("fetches B independently while an account-A refresh is in flight", async () => {
    const pendingA = Promise.withResolvers<AnthropicQuotaResult>();
    credentials.oauth.mockReturnValueOnce(pendingA.promise);
    const server = await setup();
    const a = server.client();
    const b = server.client();
    const refreshingA = a.refresh("manual", "anthropic");
    await vi.waitFor(() => expect(credentials.oauth).toHaveBeenCalledOnce());
    const refreshingB = b.refresh("manual", "claude-code");
    // Resolve A even on failure, so server cleanup cannot wait on the stalled request.
    try {
      await vi.waitFor(() => expect(credentials.cli).toHaveBeenCalledOnce());
      expect(remaining(await refreshingB)).toBe(40);
    } finally {
      pendingA.resolve(quota(90));
      await Promise.all([refreshingA, refreshingB]);
    }
    expect(remaining(a.snapshot("anthropic"))).toBe(90);
    expect(remaining(b.snapshot("claude-code"))).toBe(40);
  });
});
