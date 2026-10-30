import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const artifactDir = await mkdtemp(path.join(tmpdir(), "opencode-quota-release-package-"));

function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
  run(".github/scripts/pack-release-package.mjs", [artifactDir]);
  run(".github/scripts/smoke-packed-package.mjs", [artifactDir]);
} finally {
  await rm(artifactDir, { recursive: true, force: true });
}
