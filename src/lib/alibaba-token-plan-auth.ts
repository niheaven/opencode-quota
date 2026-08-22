import { join } from "node:path";
import { readFile } from "fs/promises";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export interface AlibabaTokenPlanConfig {
  loginTicket: string;
  /** Optional whitelist of AccountName values. Empty/undefined means "show all seats". */
  account?: string[];
  /**
   * Console "agent" id required by the personal Token Plan gateway API
   * (`cornerstoneParam.switchAgent`). Delivered by the Bailian console login flow.
   */
  switchAgent?: number;
}

export const ALIBABA_TOKEN_PLAN_LOGIN_TICKET_COOKIE = "login_aliyunid_ticket";

/**
 * Read the login ticket from a pasted Cookie header, or accept a bare ticket value
 * when no `login_aliyunid_ticket=` name is present. Rejects CR/LF (header injection).
 */
export function extractLoginTicket(raw: string): string | undefined {
  if (/[\r\n]/.test(raw)) return undefined;

  const trimmed = raw.trim();
  if (!trimmed.includes(`${ALIBABA_TOKEN_PLAN_LOGIN_TICKET_COOKIE}=`)) return trimmed || undefined;

  for (const part of trimmed.replace(/^\s*cookie\s*:/i, "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() === ALIBABA_TOKEN_PLAN_LOGIN_TICKET_COOKIE) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

export type ResolvedAlibabaTokenPlanAuth =
  | { state: "none" }
  | { state: "configured"; config: AlibabaTokenPlanConfig; source: string }
  | { state: "invalid"; source: string; error: string };

const ALIBABA_TOKEN_PLAN_COOKIE_ENV = "ALIBABA_TOKEN_PLAN_COOKIE";
const ALIBABA_TOKEN_PLAN_ACCOUNT_ENV = "ALIBABA_TOKEN_PLAN_ACCOUNT";
const ALIBABA_TOKEN_PLAN_SWITCH_AGENT_ENV = "ALIBABA_TOKEN_PLAN_SWITCH_AGENT";

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

/** Positive finite integer, accepting either a number or a numeric string. */
export function parseSwitchAgent(record: Record<string, unknown>): number | undefined {
  for (const key of ["switchAgent", "switch_agent"]) {
    const value = record[key];
    const parsed =
      typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
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

/** Single credential input: a Cookie header or a bare login ticket, plus the optional account filter / switchAgent. */
function resolveCredential(
  credential: string | undefined,
  account?: string[],
  switchAgent?: number,
): ParsedConfig {
  const loginTicket = credential ? extractLoginTicket(credential) : undefined;
  if (!loginTicket) return { ok: false, error: "missing loginTicket" };
  return {
    ok: true,
    config: {
      loginTicket,
      ...(account ? { account } : {}),
      ...(switchAgent !== undefined ? { switchAgent } : {}),
    },
  };
}

export function sanitizeAlibabaTokenPlanConfig(record: Record<string, unknown>): ParsedConfig {
  return resolveCredential(
    pickString(record, ["cookie", "loginTicket", "login_ticket"]),
    parseAccountList(record),
    parseSwitchAgent(record),
  );
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
      "cookie",
      "loginTicket",
      "login_ticket",
      "account",
      "switchAgent",
      "switch_agent",
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

function pickEnvString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return env[key]?.trim() || undefined;
}

function resolveFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedAlibabaTokenPlanAuth | null {
  const cookie = pickEnvString(env, ALIBABA_TOKEN_PLAN_COOKIE_ENV);
  if (cookie === undefined) return null;

  const accountRaw = pickEnvString(env, ALIBABA_TOKEN_PLAN_ACCOUNT_ENV);
  const accountList = accountRaw
    ? [...new Set(accountRaw.split(",").map((s) => s.trim()))].filter(Boolean)
    : [];
  const account = accountList.length > 0 ? accountList : undefined;

  const switchAgent = parseSwitchAgent({ switchAgent: env[ALIBABA_TOKEN_PLAN_SWITCH_AGENT_ENV] });

  const resolved = resolveCredential(cookie, account, switchAgent);
  if (!resolved.ok) {
    return {
      state: "invalid",
      source: `env:${ALIBABA_TOKEN_PLAN_COOKIE_ENV}`,
      error: resolved.error,
    };
  }

  return {
    state: "configured",
    config: resolved.config,
    source: `env:${ALIBABA_TOKEN_PLAN_COOKIE_ENV}`,
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
