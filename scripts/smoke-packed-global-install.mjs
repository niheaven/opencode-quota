import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { verifyReleaseArtifact } from "./lib/release-artifact.mjs";

// Installs the packed tarball with `npm install -g` into an empty prefix, using npm 12 rather than
// the npm that ships with Node. smoke-packed-package.mjs installs locally with the bundled npm, which
// let 6.0.0 ship with an ERESOLVE that only npm 12 reports (#353).
const NPM_RANGE = "12";

const inputPath = path.resolve(process.argv[2] ?? "package-artifacts");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_cache: path.join(cwd, ".npm-cache"),
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout;
}

const artifact = await verifyReleaseArtifact(inputPath);
const workdir = await mkdtemp(path.join(tmpdir(), "opencode-quota-global-smoke-"));

try {
  const npmHome = path.join(workdir, "npm-home");
  await mkdir(npmHome);
  run("npm", ["install", "--prefix", npmHome, `npm@${NPM_RANGE}`], workdir);

  const npmCli = path.join(npmHome, "node_modules", "npm", "bin", "npm-cli.js");
  const npmVersion = run(process.execPath, [npmCli, "--version"], workdir).trim();
  assert.ok(
    npmVersion.startsWith(`${NPM_RANGE}.`),
    `Expected npm ${NPM_RANGE}.x for the global install; received npm ${npmVersion}.`,
  );

  const prefix = path.join(workdir, "global-prefix");
  await mkdir(path.join(prefix, "lib"), { recursive: true });
  run(
    process.execPath,
    [npmCli, "install", "-g", "--prefix", prefix, artifact.tarballPath],
    workdir,
  );

  const installedPackageDir = path.join(
    prefix,
    "lib",
    "node_modules",
    "@slkiser",
    "opencode-quota",
  );
  const installed = JSON.parse(
    await readFile(path.join(installedPackageDir, "package.json"), "utf8"),
  );
  assert.equal(installed.name, "@slkiser/opencode-quota");
  assert.equal(artifact.filename, `slkiser-opencode-quota-${installed.version}.tgz`);
  await access(path.join(prefix, "bin", "opencode-quota"));

  console.log(
    `Global install smoke passed: npm ${npmVersion} installed ${artifact.filename} on Node ${process.versions.node} (sha256 ${artifact.sha256}).`,
  );
} finally {
  await rm(workdir, { recursive: true, force: true });
}
