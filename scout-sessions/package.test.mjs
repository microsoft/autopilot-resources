import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  RELEASE_VERSION,
  buildScoutSessionsRelease,
  readStoredZip,
} from "./package.mjs";

const TOOL_ROOT = import.meta.dirname;
const BUNDLE_INPUT = path.join(TOOL_ROOT, "bundle");
const CANONICAL_SCRIPT = path.join(TOOL_ROOT, "scout-sessions.mjs");
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-sessions-release-"));
  tempDirs.push(dir);
  return dir;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("builds deterministic platform ZIPs and exact source artifact", () => {
  const first = path.join(tempDir(), "first");
  const second = path.join(tempDir(), "second");
  const firstArtifacts = buildScoutSessionsRelease({ outputDir: first });
  const secondArtifacts = buildScoutSessionsRelease({ outputDir: second });
  const canonical = fs.readFileSync(CANONICAL_SCRIPT);

  assert.deepEqual(
    firstArtifacts.map(({ name, size, sha256: hash }) => ({ name, size, hash })),
    secondArtifacts.map(({ name, size, sha256: hash }) => ({ name, size, hash })),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(first, `scout-sessions-${RELEASE_VERSION}.mjs`)),
    canonical,
  );

  for (const platform of ["macos", "windows"]) {
    const zipName = `scout-sessions-${RELEASE_VERSION}-${platform}.zip`;
    assert.deepEqual(
      fs.readFileSync(path.join(first, zipName)),
      fs.readFileSync(path.join(second, zipName)),
    );
    const entries = readStoredZip(fs.readFileSync(path.join(first, zipName)));
    const prefix = `scout-sessions-${RELEASE_VERSION}-${platform}`;
    assert.deepEqual(entries.get(`${prefix}/scout-sessions.mjs`), canonical);
    assert.equal(entries.get(`${prefix}/VERSION.txt`).toString("utf8").trim(), RELEASE_VERSION);
    assert.match(
      entries.get(`${prefix}/README.txt`).toString("utf8"),
      /Always Keep on This Device/,
    );
  }

  const checksums = fs.readFileSync(path.join(first, "SHA256SUMS"), "utf8").trim().split("\n");
  assert.equal(checksums.length, 3);
  for (const line of checksums) {
    const [hash, name] = line.split("  ");
    assert.equal(hash, sha256(fs.readFileSync(path.join(first, name))));
  }
});

test("packages platform-native installer line endings and launchers", () => {
  const outputDir = tempDir();
  buildScoutSessionsRelease({ outputDir });
  const macPrefix = `scout-sessions-${RELEASE_VERSION}-macos`;
  const winPrefix = `scout-sessions-${RELEASE_VERSION}-windows`;
  const macEntries = readStoredZip(fs.readFileSync(path.join(outputDir, `${macPrefix}.zip`)));
  const winEntries = readStoredZip(fs.readFileSync(path.join(outputDir, `${winPrefix}.zip`)));

  assert.deepEqual([...macEntries.keys()].sort(), [
    `${macPrefix}/README.txt`,
    `${macPrefix}/VERSION.txt`,
    `${macPrefix}/install.sh`,
    `${macPrefix}/scout-sessions`,
    `${macPrefix}/scout-sessions.mjs`,
  ]);
  assert.deepEqual([...winEntries.keys()].sort(), [
    `${winPrefix}/README.txt`,
    `${winPrefix}/VERSION.txt`,
    `${winPrefix}/install.ps1`,
    `${winPrefix}/scout-sessions.cmd`,
    `${winPrefix}/scout-sessions.mjs`,
  ]);
  assert.equal(macEntries.get(`${macPrefix}/install.sh`).includes("\r\n"), false);
  assert.match(
    macEntries.get(`${macPrefix}/scout-sessions`).toString("utf8"),
    /exec node "\$SCRIPT_DIR\/scout-sessions\.mjs" "\$@"/,
  );
  assert.match(winEntries.get(`${winPrefix}/install.ps1`).toString("utf8"), /\r\n/);
  assert.match(winEntries.get(`${winPrefix}/scout-sessions.cmd`).toString("utf8"), /\r\n/);
  assert.match(
    winEntries.get(`${winPrefix}/scout-sessions.cmd`).toString("utf8"),
    /node "%~dp0scout-sessions\.mjs" %\*/,
  );
});

test("macOS installer atomically installs and uninstalls in an override directory", () => {
  const stage = tempDir();
  const installDir = path.join(tempDir(), "bin");
  const installer = path.join(stage, "install.sh");
  const launcher = path.join(stage, "scout-sessions");
  const canonical = fs.readFileSync(CANONICAL_SCRIPT);
  fs.copyFileSync(path.join(BUNDLE_INPUT, "install-macos.sh"), installer);
  fs.copyFileSync(path.join(BUNDLE_INPUT, "scout-sessions-macos"), launcher);
  fs.copyFileSync(
    CANONICAL_SCRIPT,
    path.join(stage, "scout-sessions.mjs"),
  );
  fs.chmodSync(installer, 0o755);

  const env = { ...process.env, SCOUT_SESSIONS_INSTALL_DIR: installDir };
  const installed = spawnSync("sh", [installer], { encoding: "utf8", env });
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(installed.stdout.includes(`Installed Scout Sessions CLI v${RELEASE_VERSION}`));
  const target = path.join(installDir, "scout-sessions");
  assert.match(fs.readFileSync(target, "utf8"), /exec node .*scout-sessions\.mjs/);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(installDir, "scout-sessions.mjs")).mode & 0o777, 0o755);
  assert.deepEqual(fs.readFileSync(path.join(installDir, "scout-sessions.mjs")), canonical);
  assert.equal(
    fs.readdirSync(installDir).some((name) => name.startsWith(".scout-sessions.")),
    false,
  );
  const help = spawnSync(target, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes(`v${RELEASE_VERSION}`));

  const uninstalled = spawnSync("sh", [installer, "--uninstall"], {
    encoding: "utf8",
    env,
  });
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(path.join(installDir, "scout-sessions.mjs")), false);
});

test("Windows installer is user-local, explicit about PATH, and avoids policy changes", () => {
  const installer = fs.readFileSync(path.join(BUNDLE_INPUT, "install-windows.ps1"), "utf8");
  const launcher = fs.readFileSync(path.join(BUNDLE_INPUT, "scout-sessions.cmd"), "utf8");

  assert.match(installer, /LOCALAPPDATA.*Microsoft\\ScoutSessions\\bin/);
  assert.match(installer, /\[switch\]\$AddToPath/);
  assert.match(installer, /DoNotExpandEnvironmentNames/);
  assert.match(installer, /RegistryValueKind/);
  assert.match(installer, /Update-UserPath \$true/);
  assert.match(installer, /Guid.*NewGuid/);
  assert.match(installer, /Move-Item.*-Force/s);
  assert.doesNotMatch(installer, /Set-ExecutionPolicy|Start-Process.*RunAs/i);
  assert.equal(
    launcher.replaceAll("\r\n", "\n"),
    '@echo off\nnode "%~dp0scout-sessions.mjs" %*\nexit /b %ERRORLEVEL%\n',
  );
});
