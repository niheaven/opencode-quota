import { join } from "node:path";
import { readFile } from "fs/promises";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export interface AlibabaTokenPlanConfig {
  secToken: string;
  loginTicket: string;
  /** Optional whitelist of AccountName values. Empty/undefined means "show all seats". */
  account?: string[];
}

export type ResolvedAlibabaTokenPlanAuth =
  | { state: "none" }
  | { state: "configured"; config: AlibabaTokenPlanConfig; source: string }
  | { state: "invalid"; source: string; error: string };

const ALIBABA_TOKEN_PLAN_SEC_TOKEN_ENV = "ALIBABA_TOKEN_PLAN_SEC_TOKEN";
const ALIBABA_TOKEN_PLAN_TICKET_ENV = "ALIBABA_TOKEN_PLAN_LOGIN_TICKET";
const ALIBABA_TOKEN_PLAN_ACCOUNT_ENV = "ALIBABA_TOKEN_PLAN_ACCOUNT";

export function getAlibabaTokenPlanConfigCandidatePaths(): string[] {
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  return configDirs.map((dir) => join(dir, "opencode-quota", "alibaba-token-plan.json"));
}

async function readConfigFile(path: string): Promise<unknown | null> {
  try {
    const data = await readFile(path, "utf8");
    return JSON.parse(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    throw error;
  }
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

type ParsedConfig = { ok: true; config: AlibabaTokenPlanConfig } | { ok: false; error: string };

function parseAccountList(record: Record<string, unknown>): string[] | undefined {
  const raw = record.account;
  if (!Array.isArray(raw)) return undefined;
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed && !names.includes(trimmed)) names.push(trimmed);
  }
  return names.length > 0 ? names : undefined;
}

export function sanitizeAlibabaTokenPlanConfig(record: Record<string, unknown>): ParsedConfig {
  const secToken = pickString(record, ["secToken", "sec_token"]);
  const loginTicket = pickString(record, ["loginTicket", "login_ticket"]);
  if (!secToken) return { ok: false, error: "Config file must contain secToken / sec_token" };
  if (!loginTicket) {
    return {
      ok: false,
      error: "Config file must contain loginTicket / login_ticket",
    };
  }
  const account = parseAccountList(record);
  return { ok: true, config: { secToken, loginTicket, account } };
}

async function resolveFromConfig(): Promise<ResolvedAlibabaTokenPlanAuth | null> {
  for (const path of getAlibabaTokenPlanConfigCandidatePaths()) {
    let raw: unknown;
    try {
      raw = await readConfigFile(path);
    } catch (error) {
      return {
        state: "invalid",
        source: path,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (raw === null) continue;

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { state: "invalid", source: path, error: "Config file must contain a JSON object" };
    }

    const record = raw as Record<string, unknown>;
    const allowedKeys = new Set([
      "secToken",
      "sec_token",
      "loginTicket",
      "login_ticket",
      "account",
    ]);
    for (const key of Object.keys(record)) {
      if (!allowedKeys.has(key)) {
        return {
          state: "invalid",
          source: path,
          error: `Config file has unknown field "${key}"`,
        };
      }
    }

    const parsed = sanitizeAlibabaTokenPlanConfig(record);
    if (!parsed.ok) {
      return { state: "invalid", source: path, error: parsed.error };
    }

    return {
      state: "configured",
      config: parsed.config,
      source: path,
    };
  }
  return null;
}

function resolveFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedAlibabaTokenPlanAuth | null {
  const secTokenRaw = env[ALIBABA_TOKEN_PLAN_SEC_TOKEN_ENV];
  const ticketRaw = env[ALIBABA_TOKEN_PLAN_TICKET_ENV];
  if (secTokenRaw === undefined && ticketRaw === undefined) return null;

  if (secTokenRaw === undefined || secTokenRaw.trim() === "") {
    return {
      state: "invalid",
      source: `env:${ALIBABA_TOKEN_PLAN_SEC_TOKEN_ENV}`,
      error: "Empty sec token",
    };
  }
  if (ticketRaw === undefined || ticketRaw.trim() === "") {
    return {
      state: "invalid",
      source: `env:${ALIBABA_TOKEN_PLAN_TICKET_ENV}`,
      error: "Empty login ticket",
    };
  }

  const accountRaw = env[ALIBABA_TOKEN_PLAN_ACCOUNT_ENV];
  let account: string[] | undefined;
  if (accountRaw !== undefined && accountRaw.trim() !== "") {
    account = accountRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s, i, arr) => s.length > 0 && arr.indexOf(s) === i);
    if (account.length === 0) account = undefined;
  }

  return {
    state: "configured",
    config: { secToken: secTokenRaw.trim(), loginTicket: ticketRaw.trim(), account },
    source: `env:${ALIBABA_TOKEN_PLAN_SEC_TOKEN_ENV} + env:${ALIBABA_TOKEN_PLAN_TICKET_ENV}`,
  };
}

export async function resolveAlibabaTokenPlanAuth(): Promise<ResolvedAlibabaTokenPlanAuth> {
  const fromEnv = resolveFromEnv();
  if (fromEnv) return fromEnv;

  const fromConfig = await resolveFromConfig();
  if (fromConfig) return fromConfig;

  return { state: "none" };
}

export const DEFAULT_ALIBABA_TOKEN_PLAN_AUTH_CACHE_MAX_AGE_MS = 30_000;

let cachedAuth: ResolvedAlibabaTokenPlanAuth | null = null;
let cachedAt = 0;

export async function resolveAlibabaTokenPlanAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedAlibabaTokenPlanAuth> {
  const maxAgeMs = Math.max(
    0,
    params?.maxAgeMs ?? DEFAULT_ALIBABA_TOKEN_PLAN_AUTH_CACHE_MAX_AGE_MS,
  );
  const now = Date.now();
  if (cachedAuth && now - cachedAt < maxAgeMs) {
    return cachedAuth;
  }

  cachedAuth = await resolveAlibabaTokenPlanAuth();
  cachedAt = now;
  return cachedAuth;
}
