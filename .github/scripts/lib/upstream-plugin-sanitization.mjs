import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REDACTED_GOOGLE_OAUTH_CLIENT_ID =
  "REDACTED_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com";
const REDACTED_GOOGLE_OAUTH_CLIENT_SECRET = "REDACTED_GOOGLE_OAUTH_CLIENT_SECRET";
const AGY_UNREDACTED_CREDENTIAL_PATTERNS = Object.freeze([
  /\b\d{10,}-[a-z0-9]+\.apps\.googleusercontent\.com\b/i,
  /GOCSPX-[A-Za-z0-9_-]+/,
]);
// cursor-opencode-provider ships no OAuth client secret (browser login is PKCE); these
// patterns fail the sync if a real Cursor API key or access token ever lands in the snapshot.
const CURSOR_UNREDACTED_CREDENTIAL_PATTERNS = Object.freeze([
  /crsr_[A-Za-z0-9]{20,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/,
]);
const GEMINI_BUNDLE_REPLACEMENTS = Object.freeze([
  {
    label: "GEMINI_CLIENT_ID",
    pattern: /(var GEMINI_CLIENT_ID = )(["'])[^"']+\2;/,
    replacement: `$1$2${REDACTED_GOOGLE_OAUTH_CLIENT_ID}$2;`,
  },
  {
    label: "GEMINI_CLIENT_SECRET",
    pattern: /(var GEMINI_CLIENT_SECRET = )(["'])[^"']+\2;/,
    replacement: `$1$2${REDACTED_GOOGLE_OAUTH_CLIENT_SECRET}$2;`,
  },
]);
const GEMINI_SOURCE_MAP_REPLACEMENTS = Object.freeze([
  {
    label: "GEMINI_CLIENT_ID_SOURCE_MAP",
    pattern: /(export const GEMINI_CLIENT_ID = \\")([^\\"]+)(\\";)/,
    replacement: `$1${REDACTED_GOOGLE_OAUTH_CLIENT_ID}$3`,
  },
  {
    label: "GEMINI_CLIENT_SECRET_SOURCE_MAP",
    pattern: /(export const GEMINI_CLIENT_SECRET = \\")([^\\"]+)(\\";)/,
    replacement: `$1${REDACTED_GOOGLE_OAUTH_CLIENT_SECRET}$3`,
  },
]);
const SNAPSHOT_SANITIZERS = Object.freeze({
  "opencode-agy-auth": Object.freeze([
    {
      relativePath: "dist/src/constants.d.ts",
      replacements: [
        {
          label: "AGY_CLIENT_ID",
          pattern: /(export declare const AGY_CLIENT_ID = )(["'])([^"']+)\2;/,
          replacement: `$1$2${REDACTED_GOOGLE_OAUTH_CLIENT_ID}$2;`,
          capturedValueGroup: 3,
          redactedValue: REDACTED_GOOGLE_OAUTH_CLIENT_ID,
        },
        {
          label: "AGY_CLIENT_SECRET",
          pattern: /(export declare const AGY_CLIENT_SECRET = )(["'])([^"']+)\2;/,
          replacement: `$1$2${REDACTED_GOOGLE_OAUTH_CLIENT_SECRET}$2;`,
          capturedValueGroup: 3,
          redactedValue: REDACTED_GOOGLE_OAUTH_CLIENT_SECRET,
        },
      ],
    },
    {
      relativePath: "dist/index.js",
      replacements: [
        {
          label: "AGY_CLIENT_ID",
          pattern: /(var AGY_CLIENT_ID = )(["'])([^"']+)\2;/,
          replacement: `$1$2${REDACTED_GOOGLE_OAUTH_CLIENT_ID}$2;`,
          capturedValueGroup: 3,
          redactedValue: REDACTED_GOOGLE_OAUTH_CLIENT_ID,
        },
        {
          label: "AGY_CLIENT_SECRET",
          pattern: /(var AGY_CLIENT_SECRET = )(["'])([^"']+)\2;/,
          replacement: `$1$2${REDACTED_GOOGLE_OAUTH_CLIENT_SECRET}$2;`,
          capturedValueGroup: 3,
          redactedValue: REDACTED_GOOGLE_OAUTH_CLIENT_SECRET,
        },
      ],
    },
    {
      relativePath: "dist/index.js.map",
      optional: true,
      replacements: [
        {
          label: "AGY_CLIENT_ID_SOURCE_MAP",
          pattern: /(export const AGY_CLIENT_ID = ')([^']+)(';)/,
          replacement: `$1${REDACTED_GOOGLE_OAUTH_CLIENT_ID}$3`,
          capturedValueGroup: 2,
          redactedValue: REDACTED_GOOGLE_OAUTH_CLIENT_ID,
        },
        {
          label: "AGY_CLIENT_SECRET_SOURCE_MAP",
          pattern: /(export const AGY_CLIENT_SECRET = ')([^']+)(';)/,
          replacement: `$1${REDACTED_GOOGLE_OAUTH_CLIENT_SECRET}$3`,
          capturedValueGroup: 2,
          redactedValue: REDACTED_GOOGLE_OAUTH_CLIENT_SECRET,
        },
      ],
    },
  ]),
  "opencode-gemini-auth": Object.freeze([
    {
      relativePath: "src/constants.ts",
      optional: true,
      replacements: [
        {
          label: "GEMINI_CLIENT_ID",
          pattern: /(export const GEMINI_CLIENT_ID = )(["'])[^"']+\2;/,
          replacement: `$1$2${REDACTED_GOOGLE_OAUTH_CLIENT_ID}$2;`,
        },
        {
          label: "GEMINI_CLIENT_SECRET",
          pattern: /(export const GEMINI_CLIENT_SECRET = )(["'])[^"']+\2;/,
          replacement: `$1$2${REDACTED_GOOGLE_OAUTH_CLIENT_SECRET}$2;`,
        },
      ],
    },
    {
      relativePath: "dist/index.js",
      optional: true,
      replacements: GEMINI_BUNDLE_REPLACEMENTS,
    },
    {
      relativePath: "dist/index.js.map",
      optional: true,
      replacements: GEMINI_SOURCE_MAP_REPLACEMENTS,
    },
    {
      relativePath: "dist/server.js",
      optional: true,
      replacements: GEMINI_BUNDLE_REPLACEMENTS,
    },
    {
      relativePath: "dist/server.js.map",
      optional: true,
      replacements: GEMINI_SOURCE_MAP_REPLACEMENTS,
    },
  ]),
});

async function listSnapshotFiles(rootPath) {
  const files = [];

  async function visit(directoryPath) {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  await visit(rootPath);
  return files;
}

async function verifySnapshotHasNoCredentials(
  pluginRoot,
  credentialLabel,
  unredactedPatterns,
  capturedCredentialValues,
) {
  for (const filePath of await listSnapshotFiles(pluginRoot)) {
    const content = await readFile(filePath);

    for (const value of capturedCredentialValues) {
      if (content.includes(value)) {
        throw new Error(`Found unsanitized ${credentialLabel} in ${filePath}.`);
      }
    }

    const text = content.toString("utf8");
    if (unredactedPatterns.some((pattern) => pattern.test(text))) {
      throw new Error(`Found unsanitized ${credentialLabel} in ${filePath}.`);
    }
  }
}

export async function sanitizeUpstreamPluginSnapshot(pluginId, pluginRoot) {
  const sanitizers = SNAPSHOT_SANITIZERS[pluginId] ?? [];
  const redactedLabels = new Set();
  const capturedCredentialValues = new Set();

  for (const sanitizer of sanitizers) {
    const filePath = path.join(pluginRoot, sanitizer.relativePath);
    let content;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (
        sanitizer.optional &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }

    for (const replacement of sanitizer.replacements) {
      if (replacement.alreadySanitizedPattern?.test(content)) {
        continue;
      }

      const match = content.match(replacement.pattern);
      if (!match) {
        throw new Error(
          `Expected ${replacement.label} in ${filePath} while sanitizing ${pluginId} snapshot.`,
        );
      }

      const capturedValue = replacement.capturedValueGroup
        ? match[replacement.capturedValueGroup]
        : undefined;
      if (capturedValue && capturedValue !== replacement.redactedValue) {
        capturedCredentialValues.add(capturedValue);
      }

      content = content.replace(replacement.pattern, replacement.replacement);
      redactedLabels.add(replacement.label);
    }

    await writeFile(filePath, content, "utf8");
  }

  if (
    pluginId === "opencode-agy-auth" &&
    (!redactedLabels.has("AGY_CLIENT_ID") || !redactedLabels.has("AGY_CLIENT_SECRET"))
  ) {
    throw new Error(
      `Expected AGY_CLIENT_ID and AGY_CLIENT_SECRET while sanitizing ${pluginId} snapshot.`,
    );
  }

  if (pluginId === "opencode-agy-auth") {
    await verifySnapshotHasNoCredentials(
      pluginRoot,
      "AGY OAuth credential",
      AGY_UNREDACTED_CREDENTIAL_PATTERNS,
      capturedCredentialValues,
    );
  }

  if (pluginId === "cursor-opencode-provider") {
    await verifySnapshotHasNoCredentials(
      pluginRoot,
      "Cursor credential",
      CURSOR_UNREDACTED_CREDENTIAL_PATTERNS,
      capturedCredentialValues,
    );
  }

  if (
    pluginId === "opencode-gemini-auth" &&
    (!redactedLabels.has("GEMINI_CLIENT_ID") || !redactedLabels.has("GEMINI_CLIENT_SECRET"))
  ) {
    throw new Error(
      `Expected GEMINI_CLIENT_ID and GEMINI_CLIENT_SECRET while sanitizing ${pluginId} snapshot.`,
    );
  }
}
