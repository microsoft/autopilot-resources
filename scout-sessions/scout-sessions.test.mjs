import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  SESSION_TOOL_MANIFEST_NAME,
  UUID_RE,
  applyCopy,
  applyDelete,
  cloneSession,
  deriveCurrentDeviceId,
  detectSessionsRoots,
  findSessions,
  formatCompactDevice,
  formatCompactLocation,
  formatCompactMatch,
  formatCompactNotes,
  formatCompactTimestamp,
  formatDeviceIssues,
  formatHumanTimestamp,
  formatTable,
  inspectPartition,
  listDevices,
  listPartitionSessions,
  main,
  normalizeSessionsRoot,
  parseArgs,
  parseMachineGuidOutput,
  readPartitionIndex,
  resolveDeviceRef,
  resolveSessionRefs,
  validateStoredSession,
} from "./scout-sessions.mjs";

const SOURCE_DEVICE = "a".repeat(32);
const DESTINATION_DEVICE = "b".repeat(32);
const OTHER_DEVICE = "c".repeat(32);
const SOURCE_SESSION = "11111111-1111-4111-8111-111111111111";
const SECOND_SESSION = "33333333-3333-4333-8333-333333333333";
const DESTINATION_SESSION = "22222222-2222-4222-8222-222222222222";
const OMAR_SESSION = "c8ec09ee-f55f-4313-b986-c4824277d8bd";
const SHAREPOINT_SESSION = "8400ed75-e0d0-417e-9b49-6d8a19efd5e5";
const SIDEBAR_IDS = Array.from(
  { length: 8 },
  (_, index) => `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-sessions-"));
  tempDirs.push(dir);
  return dir;
}

function session(overrides = {}) {
  return {
    id: SOURCE_SESSION,
    name: "Recovered chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    hasUnread: true,
    isActive: true,
    source: "user",
    backendOrigin: "copilot",
    backendId: "machine-local-backend-id",
    deviceId: SOURCE_DEVICE,
    contentAuthority: "local",
    permissionCards: [{ id: "pending" }],
    messages: [
      {
        id: "message-1",
        role: "user",
        content: "Keep this transcript",
        timestamp: "2026-01-01T00:00:00.000Z",
        fileNames: ["brief.pdf"],
        toolCalls: [
          {
            id: "tool-1",
            name: "search",
            description: "Search",
            result: "kept",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function metadata(value) {
  const { messages: _messages, permissionCards: _permissionCards, ...row } = value;
  return row;
}

function partitionDir(root, deviceId) {
  return deviceId === null ? root : path.join(root, "devices", deviceId);
}

function writePartition(root, deviceId, values, index = true) {
  const dir = partitionDir(root, deviceId);
  fs.mkdirSync(dir, { recursive: true });
  for (const value of values) {
    fs.writeFileSync(path.join(dir, `${value.id}.json`), JSON.stringify(value), "utf8");
  }
  if (index) {
    fs.writeFileSync(
      path.join(dir, "sessions-index.json"),
      JSON.stringify({
        sessions: values.map(metadata),
        activeSessionId: values.find((value) => value.isActive)?.id ?? null,
        defaultModel: "gpt-5.4",
      }),
      "utf8",
    );
  }
}

function makeSessionsTree() {
  const root = path.join(tempDir(), "Apps", "Microsoft Scout", "sessions");
  fs.mkdirSync(path.join(root, "devices"), { recursive: true });
  writePartition(root, SOURCE_DEVICE, [session()]);
  return root;
}

function captureConsole(callback) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => logs.push(values.join(" "));
  console.error = (...values) => errors.push(values.join(" "));
  try {
    return { result: callback(), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("derives Scout device IDs on macOS and Windows without exposing raw identifiers", () => {
  let macInvocation;
  const mac = deriveCurrentDeviceId({
    platform: "darwin",
    exec: (...args) => {
      macInvocation = args;
      return '"IOPlatformUUID" = "ABCDEF01-2345-6789-ABCD-EF0123456789"';
    },
  });
  assert.equal(mac, "5c56c744211d5bac25c31355d2561f32");
  assert.deepEqual(macInvocation[1], ["-rd1", "-c", "IOPlatformExpertDevice"]);
  assert.equal(macInvocation[2].windowsHide, true);

  let windowsInvocation;
  const windows = deriveCurrentDeviceId({
    platform: "win32",
    env: { SystemRoot: "D:\\Windows" },
    exec: (...args) => {
      windowsInvocation = args;
      return "    MachineGuid    REG_SZ    12345678-ABCD-EF01-2345-6789ABCDEF01\r\n";
    },
  });
  assert.equal(
    parseMachineGuidOutput("MachineGuid REG_SZ 12345678-ABCD-EF01-2345-6789ABCDEF01"),
    "12345678-ABCD-EF01-2345-6789ABCDEF01",
  );
  assert.equal(parseMachineGuidOutput("MachineGuid REG_SZ not-a-guid"), null);
  assert.equal(windows, "c2fae51ca5829990e7708f1905e5fd90");
  assert.equal(windowsInvocation[0], "D:\\Windows\\System32\\reg.exe");
  assert.deepEqual(windowsInvocation[1], [
    "query",
    "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
    "/v",
    "MachineGuid",
  ]);
  assert.equal(windowsInvocation[2].windowsHide, true);

  assert.throws(() => deriveCurrentDeviceId({ platform: "linux" }), /pass --destination-device/);
});

test("resolves exact and unique device prefixes without inventing partitions", () => {
  const root = makeSessionsTree();
  writePartition(root, DESTINATION_DEVICE, []);
  const ambiguousDevice = `${SOURCE_DEVICE.slice(0, 8)}${"d".repeat(24)}`;
  writePartition(root, ambiguousDevice, []);

  assert.equal(resolveDeviceRef("shared", SOURCE_DEVICE, root), null);
  assert.equal(resolveDeviceRef("current", SOURCE_DEVICE, root), SOURCE_DEVICE);
  assert.equal(
    resolveDeviceRef(DESTINATION_DEVICE.toUpperCase(), SOURCE_DEVICE, root),
    DESTINATION_DEVICE,
  );
  assert.equal(resolveDeviceRef("bbbbbbbb", SOURCE_DEVICE, root), DESTINATION_DEVICE);
  assert.throws(
    () => resolveDeviceRef("eeeeeeee", SOURCE_DEVICE, root),
    /No device partition matches.*run devices.*--verbose/,
  );
  assert.throws(
    () => resolveDeviceRef("aaaaaaaa", SOURCE_DEVICE, root),
    /Ambiguous device prefix.*use more characters or --verbose/,
  );
  assert.equal(
    resolveDeviceRef(OTHER_DEVICE.toUpperCase(), SOURCE_DEVICE, root, {
      allowExactMissing: true,
    }),
    OTHER_DEVICE,
  );
  assert.throws(
    () => resolveDeviceRef("cccccccc", SOURCE_DEVICE, root, { allowExactMissing: true }),
    /No device partition matches/,
  );
});

test("sessions accepts the compact device ID and preserves JSON shape", () => {
  const root = makeSessionsTree();
  const compact = captureConsole(() =>
    main(["sessions", "--device", SOURCE_DEVICE.slice(0, 8), "--sessions-root", root, "--json"]),
  );
  const exact = captureConsole(() =>
    main(["sessions", "--device", SOURCE_DEVICE, "--sessions-root", root, "--json"]),
  );
  assert.equal(compact.result, 0);
  assert.equal(compact.logs[0], exact.logs[0]);
  assert.match(compact.logs[0], new RegExp(SOURCE_SESSION));
});

test("discovers and normalizes macOS and Windows OneDrive roots", () => {
  const home = tempDir();
  const macRoot = path.join(
    home,
    "Library",
    "CloudStorage",
    "OneDrive-Contoso",
    "Apps",
    "Microsoft Scout",
    "sessions",
  );
  fs.mkdirSync(path.join(macRoot, "devices"), { recursive: true });
  assert.deepEqual(detectSessionsRoots({ home, platform: "darwin" }), [macRoot]);
  assert.equal(
    normalizeSessionsRoot(path.join(home, "Library", "CloudStorage", "OneDrive-Contoso")),
    macRoot,
  );

  const windowsRoot = path.join(tempDir(), "OneDrive");
  fs.mkdirSync(path.join(windowsRoot, "Apps", "Microsoft Scout", "sessions", "devices"), {
    recursive: true,
  });
  assert.deepEqual(
    detectSessionsRoots({
      platform: "win32",
      env: { OneDriveCommercial: windowsRoot, OneDrive: windowsRoot },
    }),
    [path.join(windowsRoot, "Apps", "Microsoft Scout", "sessions")],
  );
});

test("validates filename and partition routing", () => {
  assert.equal(
    validateStoredSession(session(), {
      deviceId: SOURCE_DEVICE,
      sessionId: SOURCE_SESSION,
    }).success,
    true,
  );
  assert.match(
    validateStoredSession(session(), {
      deviceId: null,
      sessionId: SOURCE_SESSION,
    }).error,
    /shared session/,
  );
  assert.match(
    validateStoredSession(session({ id: SECOND_SESSION }), {
      deviceId: SOURCE_DEVICE,
      sessionId: SOURCE_SESSION,
    }).error,
    /filename/,
  );
});

test("lists shared and device partitions with friendly current labels and orphan blobs", () => {
  const root = makeSessionsTree();
  const shared = session({
    id: SECOND_SESSION,
    name: "Shared chat",
    deviceId: undefined,
    updatedAt: "2026-08-01T00:00:00.000Z",
    isActive: false,
  });
  writePartition(root, null, [shared]);
  const orphan = session({
    id: SECOND_SESSION,
    name: "Device orphan",
    isActive: false,
  });
  fs.writeFileSync(
    path.join(root, "devices", SOURCE_DEVICE, `${SECOND_SESSION}.json`),
    JSON.stringify(orphan),
  );
  fs.mkdirSync(path.join(root, "devices", "not-a-device"));
  fs.writeFileSync(path.join(root, "devices", SOURCE_DEVICE, "not-a-session.json"), "{}");

  const devices = listDevices(root, SOURCE_DEVICE);
  assert.equal(devices.find((item) => item.device === SOURCE_DEVICE).label, "current (aaaaaaaa)");
  assert.equal(devices.find((item) => item.device === SOURCE_DEVICE).validSessions, 2);
  assert.equal(devices.find((item) => item.device === SOURCE_DEVICE).indexedSessions, 1);
  assert.equal(devices.find((item) => item.device === SOURCE_DEVICE).orphanSessions, 1);
  assert.equal(devices.find((item) => item.device === "shared").newestSessionAt, shared.updatedAt);
  assert.equal(devices.find((item) => item.device === "not-a-device").indexStatus, "invalid");

  const listed = listPartitionSessions(root, SOURCE_DEVICE, {
    sort: "name",
    filter: "orphan",
  });
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].indexed, false);
  assert.equal(listed.sessions[0].partitionStatus, "orphan");
  assert.equal(listed.sessions[0].metadataSource, "blob");
  assert.equal(listed.sessions[0].metadataDrift, false);
  assert.equal(listed.sessions[0].messageCount, 1);
  assert.equal(inspectPartition(root, SOURCE_DEVICE).failures.at(-1).sessionId, null);
});

test("listing tolerates malformed indexes and reports malformed session blobs", () => {
  const root = makeSessionsTree();
  fs.writeFileSync(path.join(root, "devices", SOURCE_DEVICE, "sessions-index.json"), "{bad");
  fs.writeFileSync(path.join(root, "devices", SOURCE_DEVICE, `${SECOND_SESSION}.json`), "{bad");
  const inspected = inspectPartition(root, SOURCE_DEVICE);
  assert.equal(inspected.index.outcome, "invalid");
  assert.equal(inspected.sessions.length, 1);
  assert.equal(inspected.failures.length, 1);
  assert.throws(
    () => readPartitionIndex(root, SOURCE_DEVICE, { strict: true }),
    /Refusing to mutate malformed index/,
  );
  assert.equal(
    applyCopy({
      sessionsRoot: root,
      sourceDeviceId: SOURCE_DEVICE,
      destinationDeviceId: DESTINATION_DEVICE,
      sessionIds: new Set([SOURCE_SESSION]),
    }).planned.length,
    1,
  );
  assert.throws(
    () =>
      applyCopy({
        sessionsRoot: root,
        sourceDeviceId: SOURCE_DEVICE,
        destinationDeviceId: DESTINATION_DEVICE,
        sessionIds: new Set([SOURCE_SESSION]),
        apply: true,
      }),
    /malformed index/,
  );
});

test("clones sessions correctly to shared and device partitions", () => {
  const deviceClone = cloneSession(session({ sdkSessionId: "sdk", cloudSessionId: "cloud" }), {
    destinationSessionId: DESTINATION_SESSION,
    destinationDeviceId: DESTINATION_DEVICE,
    copiedAt: "2026-08-14T12:00:00.000Z",
  });
  assert.equal(deviceClone.deviceId, DESTINATION_DEVICE);
  assert.equal(deviceClone.backendId, undefined);
  assert.equal(deviceClone.permissionCards, undefined);
  assert.equal(deviceClone.isActive, false);
  assert.deepEqual(deviceClone.messages, session().messages);

  const sharedClone = cloneSession(session(), {
    destinationSessionId: DESTINATION_SESSION,
    destinationDeviceId: null,
    copiedAt: "2026-08-14T12:00:00.000Z",
  });
  assert.equal("deviceId" in sharedClone, false);
});

test("resolves unique session prefixes only against validated blobs", () => {
  const root = makeSessionsTree();
  const ambiguousSession = "11111111-2222-4222-8222-222222222222";
  const sourceDir = partitionDir(root, SOURCE_DEVICE);
  fs.writeFileSync(
    path.join(sourceDir, `${ambiguousSession}.json`),
    JSON.stringify(session({ id: ambiguousSession, name: "Ambiguous valid session" })),
  );
  fs.writeFileSync(path.join(sourceDir, `${SECOND_SESSION}.json`), "{bad");
  const indexPath = path.join(sourceDir, "sessions-index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  index.sessions.push(
    metadata(
      session({
        id: DESTINATION_SESSION,
        name: "Index only",
        deviceId: SOURCE_DEVICE,
        isActive: false,
      }),
    ),
  );
  fs.writeFileSync(indexPath, JSON.stringify(index));
  const inspected = inspectPartition(root, SOURCE_DEVICE);

  assert.deepEqual(
    [...resolveSessionRefs(inspected, new Set([SOURCE_SESSION.toUpperCase()]))],
    [SOURCE_SESSION],
  );
  assert.deepEqual(
    [...resolveSessionRefs(inspected, new Set(["11111111-1111"]))],
    [SOURCE_SESSION],
  );
  assert.throws(
    () => resolveSessionRefs(inspected, new Set(["11111111"])),
    /Ambiguous session prefix.*use more characters or --verbose/,
  );
  assert.throws(
    () => resolveSessionRefs(inspected, new Set(["33333333"])),
    /No validated session matches.*list sessions or use --verbose/,
  );
  assert.throws(
    () => resolveSessionRefs(inspected, new Set(["22222222"])),
    /No validated session matches/,
  );
  assert.throws(
    () => resolveSessionRefs(inspected, new Set(["99999999"])),
    /No validated session matches/,
  );
});

test("copy accepts LOCATION shorthand with additive and deduplicated session references", () => {
  const root = makeSessionsTree();
  const second = session({
    id: SECOND_SESSION,
    name: "Second source",
    deviceId: SOURCE_DEVICE,
    isActive: false,
  });
  const sourceDir = partitionDir(root, SOURCE_DEVICE);
  fs.writeFileSync(path.join(sourceDir, `${SECOND_SESSION}.json`), JSON.stringify(second));
  const sourceIndexPath = path.join(sourceDir, "sessions-index.json");
  const sourceIndex = JSON.parse(fs.readFileSync(sourceIndexPath, "utf8"));
  sourceIndex.sessions.push(metadata(second));
  fs.writeFileSync(sourceIndexPath, JSON.stringify(sourceIndex));
  writePartition(root, DESTINATION_DEVICE, []);

  const dryRun = captureConsole(() =>
    main([
      "copy",
      "--from",
      `${SOURCE_DEVICE.slice(0, 8)}/${SOURCE_SESSION.slice(0, 8)}`,
      "--to",
      DESTINATION_DEVICE.slice(0, 8),
      "--session-id",
      SOURCE_SESSION,
      "--session-id",
      SECOND_SESSION.toUpperCase(),
      "--sessions-root",
      root,
    ]),
  );
  assert.equal(dryRun.result, 0);
  assert.equal(dryRun.logs[0].match(new RegExp(SOURCE_SESSION, "g"))?.length, 1);
  assert.match(dryRun.logs[0], new RegExp(SOURCE_SESSION));
  assert.match(dryRun.logs[0], new RegExp(SECOND_SESSION));

  const explicitJson = captureConsole(() =>
    main([
      "copy",
      "--from",
      SOURCE_DEVICE.slice(0, 8),
      "--to",
      DESTINATION_DEVICE.slice(0, 8),
      "--session-id",
      SOURCE_SESSION.slice(0, 8),
      "--sessions-root",
      root,
      "--json",
    ]),
  );
  const shorthandJson = captureConsole(() =>
    main([
      "copy",
      "--from",
      `${SOURCE_DEVICE.slice(0, 8)}/${SOURCE_SESSION.slice(0, 8)}`,
      "--to",
      DESTINATION_DEVICE.slice(0, 8),
      "--sessions-root",
      root,
      "--json",
    ]),
  );
  assert.equal(shorthandJson.logs[0], explicitJson.logs[0]);

  const applyArgs = [
    "copy",
    "--from",
    `${SOURCE_DEVICE.slice(0, 8)}/${SOURCE_SESSION.slice(0, 8)}`,
    "--to",
    DESTINATION_DEVICE.slice(0, 8),
    "--session-id",
    SECOND_SESSION,
    "--sessions-root",
    root,
    "--apply",
  ];
  const applied = captureConsole(() => main(applyArgs));
  assert.equal(applied.result, 0);
  const reapplied = captureConsole(() => main(applyArgs));
  assert.equal(reapplied.result, 0);
  assert.match(reapplied.logs.at(-1), /Copied 0; skipped 2/);
  const destinationIndex = JSON.parse(
    fs.readFileSync(path.join(partitionDir(root, DESTINATION_DEVICE), "sessions-index.json")),
  );
  assert.equal(destinationIndex.sessions.length, 2);
  assert.equal(
    destinationIndex.sessions.every((row) => UUID_RE.test(row.id)),
    true,
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, ".scout-sessions", SESSION_TOOL_MANIFEST_NAME)),
  );
  assert.deepEqual(
    new Set(manifest.entries.map((entry) => entry.sourceSessionId)),
    new Set([SOURCE_SESSION, SECOND_SESSION]),
  );
});

test("copy LOCATION shorthand supports current and shared sources", () => {
  const root = makeSessionsTree();
  const shared = session({
    id: SECOND_SESSION,
    name: "Shared source",
    deviceId: undefined,
    isActive: false,
  });
  writePartition(root, null, [shared]);
  writePartition(root, DESTINATION_DEVICE, []);

  const current = captureConsole(() =>
    main([
      "copy",
      "--from",
      `current/${SOURCE_SESSION.slice(0, 8)}`,
      "--to",
      "shared",
      "--destination-device",
      SOURCE_DEVICE,
      "--sessions-root",
      root,
    ]),
  );
  assert.equal(current.result, 0);
  assert.match(current.logs[0], new RegExp(SOURCE_SESSION));

  const sharedResult = captureConsole(() =>
    main([
      "copy",
      "--from",
      `shared/${SECOND_SESSION.slice(0, 8)}`,
      "--to",
      DESTINATION_DEVICE.slice(0, 8),
      "--sessions-root",
      root,
    ]),
  );
  assert.equal(sharedResult.result, 0);
  assert.match(sharedResult.logs[0], new RegExp(SECOND_SESSION));
});

test("copy LOCATION shorthand fails closed for unknown and ambiguous references", () => {
  const root = makeSessionsTree();
  writePartition(root, DESTINATION_DEVICE, []);
  assert.throws(
    () =>
      main([
        "copy",
        "--from",
        `eeeeeeee/${SOURCE_SESSION.slice(0, 8)}`,
        "--to",
        DESTINATION_DEVICE,
        "--sessions-root",
        root,
      ]),
    /No device partition matches/,
  );
  assert.throws(
    () =>
      main([
        "copy",
        "--from",
        `${SOURCE_DEVICE.slice(0, 8)}/99999999`,
        "--to",
        DESTINATION_DEVICE,
        "--sessions-root",
        root,
      ]),
    /No validated session matches/,
  );

  const ambiguousDevice = `${SOURCE_DEVICE.slice(0, 8)}${"d".repeat(24)}`;
  writePartition(root, ambiguousDevice, []);
  assert.throws(
    () =>
      main([
        "copy",
        "--from",
        `${SOURCE_DEVICE.slice(0, 8)}/${SOURCE_SESSION.slice(0, 8)}`,
        "--to",
        DESTINATION_DEVICE,
        "--sessions-root",
        root,
      ]),
    /Ambiguous device prefix/,
  );

  fs.rmSync(partitionDir(root, ambiguousDevice), { recursive: true });
  const ambiguousSession = "11111111-2222-4222-8222-222222222222";
  fs.writeFileSync(
    path.join(partitionDir(root, SOURCE_DEVICE), `${ambiguousSession}.json`),
    JSON.stringify(session({ id: ambiguousSession, name: "Ambiguous source" })),
  );
  assert.throws(
    () =>
      main([
        "copy",
        "--from",
        `${SOURCE_DEVICE.slice(0, 8)}/${SOURCE_SESSION.slice(0, 8)}`,
        "--to",
        DESTINATION_DEVICE,
        "--sessions-root",
        root,
      ]),
    /Ambiguous session prefix/,
  );
});

test("delete accepts compact references without weakening confirmation", () => {
  const root = makeSessionsTree();
  const prefix = SOURCE_SESSION.slice(0, 8);
  const dryRun = captureConsole(() =>
    main([
      "delete",
      "--device",
      SOURCE_DEVICE.slice(0, 8),
      "--session-id",
      prefix,
      "--sessions-root",
      root,
    ]),
  );
  assert.equal(dryRun.result, 0);
  assert.match(dryRun.logs[0], new RegExp(SOURCE_SESSION));
  assert.equal(
    fs.existsSync(path.join(partitionDir(root, SOURCE_DEVICE), `${SOURCE_SESSION}.json`)),
    true,
  );
  assert.throws(
    () =>
      main([
        "delete",
        "--device",
        "current",
        "--session-id",
        prefix,
        "--destination-device",
        SOURCE_DEVICE,
        "--sessions-root",
        root,
        "--apply",
      ]),
    /--apply and --yes/,
  );

  const applied = captureConsole(() =>
    main([
      "delete",
      "--device",
      "current",
      "--session-id",
      prefix,
      "--destination-device",
      SOURCE_DEVICE,
      "--sessions-root",
      root,
      "--apply",
      "--yes",
    ]),
  );
  assert.equal(applied.result, 0);
  assert.equal(
    fs.existsSync(path.join(partitionDir(root, SOURCE_DEVICE), `${SOURCE_SESSION}.json`)),
    false,
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, ".scout-sessions", SESSION_TOOL_MANIFEST_NAME)),
  );
  assert.equal(manifest.entries.at(-1).sessionId, SOURCE_SESSION);
});

test("copy is dry-run first, creates a routed index, and is idempotent", () => {
  const root = makeSessionsTree();
  const options = {
    sessionsRoot: root,
    sourceDeviceId: SOURCE_DEVICE,
    destinationDeviceId: DESTINATION_DEVICE,
    sessionIds: new Set([SOURCE_SESSION]),
    now: () => "2026-08-14T12:00:00.000Z",
    mintId: () => DESTINATION_SESSION,
  };
  const dryRun = applyCopy(options);
  assert.equal(dryRun.planned.length, 1);
  assert.equal(fs.existsSync(partitionDir(root, DESTINATION_DEVICE)), false);

  const first = applyCopy({ ...options, apply: true });
  assert.equal(first.copied.length, 1);
  assert.deepEqual(Object.keys(first.copied[0]).sort(), [
    "destinationSessionId",
    "sourceName",
    "sourceSessionId",
  ]);
  const destinationPath = path.join(
    partitionDir(root, DESTINATION_DEVICE),
    `${DESTINATION_SESSION}.json`,
  );
  assert.equal(fs.statSync(destinationPath).mode & 0o777, 0o600);
  const destination = JSON.parse(fs.readFileSync(destinationPath, "utf8"));
  assert.equal(destination.deviceId, DESTINATION_DEVICE);
  const index = JSON.parse(
    fs.readFileSync(path.join(partitionDir(root, DESTINATION_DEVICE), "sessions-index.json")),
  );
  assert.equal(index.sessions[0].id, DESTINATION_SESSION);
  assert.equal(index.sessions[0].messages, undefined);
  assert.equal(index.activeSessionId, null);

  const second = applyCopy({ ...options, apply: true });
  assert.equal(second.copied.length, 0);
  assert.equal(second.skipped.length, 1);
});

test("copy to shared removes device routing and preserves unrelated index settings", () => {
  const root = makeSessionsTree();
  const existing = session({
    id: SECOND_SESSION,
    name: "Existing shared",
    deviceId: undefined,
    isActive: false,
  });
  writePartition(root, null, [existing]);
  applyCopy({
    sessionsRoot: root,
    sourceDeviceId: SOURCE_DEVICE,
    destinationDeviceId: null,
    sessionIds: new Set([SOURCE_SESSION]),
    apply: true,
    now: () => "2026-08-14T12:00:00.000Z",
    mintId: () => DESTINATION_SESSION,
  });
  const copied = JSON.parse(fs.readFileSync(path.join(root, `${DESTINATION_SESSION}.json`)));
  assert.equal("deviceId" in copied, false);
  const index = JSON.parse(fs.readFileSync(path.join(root, "sessions-index.json")));
  assert.equal(index.defaultModel, "gpt-5.4");
  assert.deepEqual(
    new Set(index.sessions.map((row) => row.id)),
    new Set([SECOND_SESSION, DESTINATION_SESSION]),
  );
});

test("copy handles destination collisions and refuses malformed destination indexes", () => {
  const root = makeSessionsTree();
  writePartition(root, DESTINATION_DEVICE, [], false);
  fs.writeFileSync(
    path.join(partitionDir(root, DESTINATION_DEVICE), `${DESTINATION_SESSION}.json`),
    "{}",
  );
  const ids = [DESTINATION_SESSION, SECOND_SESSION];
  applyCopy({
    sessionsRoot: root,
    sourceDeviceId: SOURCE_DEVICE,
    destinationDeviceId: DESTINATION_DEVICE,
    sessionIds: new Set([SOURCE_SESSION]),
    apply: true,
    mintId: () => ids.shift(),
  });
  assert.equal(
    fs.existsSync(path.join(partitionDir(root, DESTINATION_DEVICE), `${SECOND_SESSION}.json`)),
    true,
  );

  const otherRoot = makeSessionsTree();
  fs.mkdirSync(partitionDir(otherRoot, OTHER_DEVICE), { recursive: true });
  fs.writeFileSync(path.join(partitionDir(otherRoot, OTHER_DEVICE), "sessions-index.json"), "{bad");
  assert.throws(
    () =>
      applyCopy({
        sessionsRoot: otherRoot,
        sourceDeviceId: SOURCE_DEVICE,
        destinationDeviceId: OTHER_DEVICE,
        sessionIds: new Set([SOURCE_SESSION]),
        apply: true,
        mintId: () => DESTINATION_SESSION,
      }),
    /malformed index/,
  );
  assert.equal(
    fs.existsSync(path.join(partitionDir(otherRoot, OTHER_DEVICE), `${DESTINATION_SESSION}.json`)),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(otherRoot, ".scout-sessions", SESSION_TOOL_MANIFEST_NAME)),
    false,
  );
});

test("copy reconciles and archives valid destination index conflict copies", () => {
  const root = makeSessionsTree();
  const existing = session({
    id: SECOND_SESSION,
    name: "Existing destination",
    deviceId: DESTINATION_DEVICE,
    isActive: false,
  });
  const conflictOnly = session({
    id: OMAR_SESSION,
    name: "Conflict-only destination",
    deviceId: DESTINATION_DEVICE,
    isActive: false,
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  const newerExistingMetadata = metadata({
    ...existing,
    name: "Existing destination renamed",
    updatedAt: "2026-08-02T00:00:00.000Z",
  });
  writePartition(root, DESTINATION_DEVICE, [existing]);
  fs.writeFileSync(
    path.join(partitionDir(root, DESTINATION_DEVICE), `${conflictOnly.id}.json`),
    JSON.stringify(conflictOnly),
  );
  const conflictName = "sessions-index-Tom’s MacBook Pro 2026.json";
  fs.writeFileSync(
    path.join(partitionDir(root, DESTINATION_DEVICE), conflictName),
    JSON.stringify({
      sessions: [newerExistingMetadata, metadata(conflictOnly)],
      activeSessionId: null,
      defaultModel: "gpt-5.4",
    }),
  );

  applyCopy({
    sessionsRoot: root,
    sourceDeviceId: SOURCE_DEVICE,
    destinationDeviceId: DESTINATION_DEVICE,
    sessionIds: new Set([SOURCE_SESSION]),
    apply: true,
    mintId: () => DESTINATION_SESSION,
  });

  const index = JSON.parse(
    fs.readFileSync(path.join(partitionDir(root, DESTINATION_DEVICE), "sessions-index.json")),
  );
  assert.deepEqual(
    new Set(index.sessions.map((row) => row.id)),
    new Set([SECOND_SESSION, OMAR_SESSION, DESTINATION_SESSION]),
  );
  assert.equal(
    index.sessions.find((row) => row.id === SECOND_SESSION).name,
    "Existing destination renamed",
  );
  assert.equal(
    fs.existsSync(path.join(partitionDir(root, DESTINATION_DEVICE), conflictName)),
    false,
  );
  const archiveDir = path.join(
    root,
    ".scout-sessions",
    "index-conflicts",
    `device-${DESTINATION_DEVICE}`,
  );
  assert.equal(
    fs.readdirSync(archiveDir).some((name) => name.startsWith(`${conflictName}.`)),
    true,
  );
  assert.equal(
    fs.readdirSync(archiveDir).some((name) => name.startsWith("sessions-index.json.")),
    true,
  );
});

test("copy rejects equal-timestamp index conflict disagreements", () => {
  const root = makeSessionsTree();
  const existing = session({
    id: SECOND_SESSION,
    name: "Canonical name",
    deviceId: DESTINATION_DEVICE,
    isActive: false,
  });
  writePartition(root, DESTINATION_DEVICE, [existing]);
  fs.writeFileSync(
    path.join(partitionDir(root, DESTINATION_DEVICE), "sessions-index conflicted.json"),
    JSON.stringify({
      sessions: [metadata({ ...existing, name: "Conflicting name" })],
      activeSessionId: null,
    }),
  );

  assert.throws(
    () =>
      applyCopy({
        sessionsRoot: root,
        sourceDeviceId: SOURCE_DEVICE,
        destinationDeviceId: DESTINATION_DEVICE,
        sessionIds: new Set([SOURCE_SESSION]),
        apply: true,
        mintId: () => DESTINATION_SESSION,
      }),
    /disagree on session/,
  );
  assert.equal(
    fs.existsSync(path.join(partitionDir(root, DESTINATION_DEVICE), `${DESTINATION_SESSION}.json`)),
    false,
  );
});

test("delete requires confirmation, updates index before content removal, and keeps backups", () => {
  const root = makeSessionsTree();
  const options = {
    sessionsRoot: root,
    deviceId: SOURCE_DEVICE,
    sessionIds: new Set([SOURCE_SESSION]),
    now: () => "2026-08-14T12:00:00.000Z",
  };
  const dryRun = applyDelete(options);
  assert.equal(dryRun.planned.length, 1);
  assert.equal(
    fs.existsSync(path.join(partitionDir(root, SOURCE_DEVICE), `${SOURCE_SESSION}.json`)),
    true,
  );
  assert.throws(() => applyDelete({ ...options, apply: true }), /--apply and --yes/);

  const result = applyDelete({ ...options, apply: true, yes: true });
  assert.equal(result.deleted.length, 1);
  assert.equal(
    fs.existsSync(path.join(partitionDir(root, SOURCE_DEVICE), `${SOURCE_SESSION}.json`)),
    false,
  );
  const index = JSON.parse(
    fs.readFileSync(path.join(partitionDir(root, SOURCE_DEVICE), "sessions-index.json")),
  );
  assert.equal(index.sessions.length, 0);
  assert.equal(index.activeSessionId, null);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, ".scout-sessions", SESSION_TOOL_MANIFEST_NAME)),
  );
  assert.equal(manifest.entries.at(-1).state, "completed");
  assert.equal(fs.existsSync(path.join(root, manifest.entries.at(-1).backupDirectory)), true);

  const rerun = applyDelete({ ...options, apply: true, yes: true });
  assert.equal(rerun.deleted.length, 1);
  assert.equal(rerun.deleted[0].alreadyCompleted, true);
});

test("delete refuses malformed or partition-ambiguous indexes", () => {
  const root = makeSessionsTree();
  fs.writeFileSync(
    path.join(partitionDir(root, SOURCE_DEVICE), "sessions-index.json"),
    JSON.stringify({
      sessions: [metadata(session({ deviceId: OTHER_DEVICE }))],
      activeSessionId: SOURCE_SESSION,
    }),
  );
  assert.throws(
    () =>
      applyDelete({
        sessionsRoot: root,
        deviceId: SOURCE_DEVICE,
        sessionIds: new Set([SOURCE_SESSION]),
        apply: true,
        yes: true,
      }),
    /malformed index/,
  );
});

test("shared delete preserves index defaults and rejects malformed index conflict copies", () => {
  const root = makeSessionsTree();
  const shared = session({
    id: SECOND_SESSION,
    deviceId: undefined,
    isActive: true,
    name: "Shared delete",
  });
  writePartition(root, null, [shared]);
  const dryRun = applyDelete({
    sessionsRoot: root,
    deviceId: null,
    sessionIds: new Set([SECOND_SESSION]),
  });
  assert.equal(dryRun.planned.length, 1);

  fs.writeFileSync(path.join(root, "sessions-index 2.json"), "{}");
  assert.throws(
    () =>
      applyDelete({
        sessionsRoot: root,
        deviceId: null,
        sessionIds: new Set([SECOND_SESSION]),
        apply: true,
        yes: true,
      }),
    /malformed index conflict/,
  );
  fs.unlinkSync(path.join(root, "sessions-index 2.json"));

  applyDelete({
    sessionsRoot: root,
    deviceId: null,
    sessionIds: new Set([SECOND_SESSION]),
    apply: true,
    yes: true,
  });
  const index = JSON.parse(fs.readFileSync(path.join(root, "sessions-index.json")));
  assert.equal(index.defaultModel, "gpt-5.4");
  assert.equal(index.sessions.length, 0);
});

test("session listing explains copy exclusions", () => {
  const root = makeSessionsTree();
  const automation = session({
    id: SECOND_SESSION,
    name: "Automation",
    source: "automation",
    isActive: false,
  });
  writePartition(root, SOURCE_DEVICE, [session(), automation]);
  const result = listPartitionSessions(root, SOURCE_DEVICE);
  const excluded = result.sessions.find((item) => item.id === SECOND_SESSION);
  assert.equal(excluded.copyEligible, false);
  assert.equal(excluded.exclusionReason, "source:automation");
});

test("sidebar approximation includes visible Copilot rows and excludes hidden origins", () => {
  const root = makeSessionsTree();
  const rows = [
    session({ id: SIDEBAR_IDS[0], name: "User", isActive: false }),
    session({
      id: SIDEBAR_IDS[1],
      name: "Automation",
      source: "automation",
      automationId: "automation-1",
      isActive: false,
    }),
    session({ id: SIDEBAR_IDS[2], name: "Heartbeat", source: "heartbeat", isActive: false }),
    session({ id: SIDEBAR_IDS[3], name: "Teams", source: "teams", isActive: false }),
    session({ id: SIDEBAR_IDS[4], name: "Condition", source: "automation", isActive: false }),
    session({
      id: SIDEBAR_IDS[5],
      name: "Benchmark",
      benchmark: { active: true },
      isActive: false,
    }),
    session({ id: SIDEBAR_IDS[6], name: "Workspace", source: "workspace", isActive: false }),
    session({
      id: SIDEBAR_IDS[7],
      name: "Gateway",
      backendOrigin: "gateway",
      contentAuthority: "remote",
      isActive: false,
    }),
  ];
  writePartition(root, SOURCE_DEVICE, rows);

  const all = listPartitionSessions(root, SOURCE_DEVICE);
  assert.deepEqual(all.summary, {
    validBlobs: 9,
    indexedBlobs: 8,
    orphanBlobs: 1,
    sidebarCandidates: 3,
    metadataDrift: 0,
  });
  const sidebar = listPartitionSessions(root, SOURCE_DEVICE, { sidebarOnly: true });
  assert.deepEqual(sidebar.sessions.map((item) => item.name).sort(), [
    "Automation",
    "Heartbeat",
    "User",
  ]);
  assert.equal(
    sidebar.sessions.every((item) => item.sidebarCandidate),
    true,
  );
  assert.equal(sidebar.sidebarOnly, true);
});

test("index metadata is canonical for listing, sidebar classification, and copy", () => {
  const root = path.join(tempDir(), "Apps", "Microsoft Scout", "sessions");
  fs.mkdirSync(path.join(root, "devices"), { recursive: true });
  const blob = session({
    id: OMAR_SESSION,
    name: "Omar Shahine at Microsoft Teams meeting",
    updatedAt: "2026-06-07T00:00:00.000Z",
    source: "teams",
    model: "old-model",
    pinnedOrder: 1,
  });
  const sharepointBlob = session({
    id: SHAREPOINT_SESSION,
    name: "Read this https://example.test",
    updatedAt: "2026-06-10T00:00:00.000Z",
    isActive: false,
  });
  writePartition(root, SOURCE_DEVICE, [blob, sharepointBlob]);
  const indexPath = path.join(partitionDir(root, SOURCE_DEVICE), "sessions-index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  index.sessions[0] = {
    ...index.sessions[0],
    name: "newscout",
    updatedAt: "2026-06-12T00:00:00.000Z",
    source: "user",
    model: "new-model",
  };
  delete index.sessions[0].pinnedOrder;
  index.sessions[1] = {
    ...index.sessions[1],
    name: "Sharepoint Git Setup",
    updatedAt: "2026-06-12T00:00:00.000Z",
  };
  fs.writeFileSync(indexPath, JSON.stringify(index), "utf8");

  const listed = listPartitionSessions(root, SOURCE_DEVICE);
  const row = listed.sessions.find((item) => item.id === OMAR_SESSION);
  assert.equal(row.name, "newscout");
  assert.equal(row.blobName, "Omar Shahine at Microsoft Teams meeting");
  assert.equal(row.updatedAt, "2026-06-12T00:00:00.000Z");
  assert.equal(row.metadataSource, "index");
  assert.equal(row.metadataDrift, true);
  assert.equal(row.sidebarCandidate, true);
  const sharepointRow = listed.sessions.find((item) => item.id === SHAREPOINT_SESSION);
  assert.equal(sharepointRow.name, "Sharepoint Git Setup");
  assert.equal(sharepointRow.blobName, "Read this https://example.test");
  assert.deepEqual(listed.summary, {
    validBlobs: 2,
    indexedBlobs: 2,
    orphanBlobs: 0,
    sidebarCandidates: 2,
    metadataDrift: 2,
  });
  assert.equal(
    listDevices(root, SOURCE_DEVICE).find((item) => item.device === SOURCE_DEVICE)
      .metadataDriftSessions,
    2,
  );

  const inspected = inspectPartition(root, SOURCE_DEVICE).sessions.find(
    (item) => item.sessionId === OMAR_SESSION,
  );
  assert.equal(inspected.session.name, "newscout");
  assert.equal(inspected.session.model, "new-model");
  assert.equal(inspected.session.pinnedOrder, undefined);
  assert.deepEqual(inspected.session.messages, blob.messages);
  assert.equal(inspected.blobSession.name, blob.name);

  applyCopy({
    sessionsRoot: root,
    sourceDeviceId: SOURCE_DEVICE,
    destinationDeviceId: DESTINATION_DEVICE,
    sessionIds: new Set([OMAR_SESSION]),
    apply: true,
    now: () => "2026-08-16T08:00:00.000Z",
    mintId: () => DESTINATION_SESSION,
  });
  const copied = JSON.parse(
    fs.readFileSync(
      path.join(partitionDir(root, DESTINATION_DEVICE), `${DESTINATION_SESSION}.json`),
      "utf8",
    ),
  );
  assert.equal(copied.name, "newscout");
  assert.equal(copied.model, "new-model");
  assert.equal(copied.source, "user");
  assert.equal(copied.pinnedOrder, undefined);
  assert.equal(copied.updatedAt, "2026-08-16T08:00:00.000Z");
  assert.equal(copied.backendId, undefined);
  assert.deepEqual(copied.messages, blob.messages);

  index.sessions[0].name = "newscout renamed again";
  fs.writeFileSync(indexPath, JSON.stringify(index), "utf8");
  assert.throws(
    () =>
      applyCopy({
        sessionsRoot: root,
        sourceDeviceId: SOURCE_DEVICE,
        destinationDeviceId: DESTINATION_DEVICE,
        sessionIds: new Set([OMAR_SESSION]),
        apply: true,
      }),
    /Source metadata changed since its previous copy/,
  );
});

test("human timestamps keep timezone and omit seconds while source JSON stays exact", () => {
  assert.equal(formatHumanTimestamp("2026-08-14T15:55:42.123Z"), "2026-08-14T15:55Z");
  assert.equal(formatHumanTimestamp("2026-08-14T15:55:42+02:00"), "2026-08-14T15:55+02:00");
  assert.equal(formatHumanTimestamp("not-a-timestamp"), "not-a-timestamp");
  assert.equal(formatCompactTimestamp("2026-08-14T15:55:42.123Z"), "Aug 14 15:55Z");
  assert.equal(formatCompactTimestamp("2026-08-14T15:55:42+02:00"), "Aug 14 15:55+02:00");
  assert.equal(formatCompactTimestamp(null), "-");
  assert.equal(formatCompactTimestamp("not-a-timestamp"), "not-a-timestamp");
  assert.equal(formatCompactDevice("shared", SOURCE_DEVICE), "shared");
  assert.equal(formatCompactDevice(SOURCE_DEVICE, SOURCE_DEVICE), "current");
  assert.equal(formatCompactDevice(DESTINATION_DEVICE, SOURCE_DEVICE), "bbbbbbbb");
  assert.equal(
    formatCompactLocation(DESTINATION_DEVICE, SOURCE_SESSION, SOURCE_DEVICE),
    "bbbbbbbb/11111111",
  );
  assert.equal(formatCompactMatch("title + transcript"), "title + text");
  assert.equal(formatCompactNotes({ classification: "chat", indexed: true }), "-");
  assert.equal(
    formatCompactNotes({ classification: "automation", indexed: false }),
    "automation, orphan",
  );
});

test("find searches canonical titles across every partition", () => {
  const root = path.join(tempDir(), "Apps", "Microsoft Scout", "sessions");
  fs.mkdirSync(path.join(root, "devices"), { recursive: true });
  writePartition(root, null, [
    session({ id: SOURCE_SESSION, name: "Configure Pi-hole DNS", deviceId: undefined }),
  ]);
  writePartition(root, SOURCE_DEVICE, [
    session({ id: SECOND_SESSION, name: "Old title", deviceId: SOURCE_DEVICE }),
  ]);
  const deviceIndexPath = path.join(partitionDir(root, SOURCE_DEVICE), "sessions-index.json");
  const deviceIndex = JSON.parse(fs.readFileSync(deviceIndexPath, "utf8"));
  deviceIndex.sessions[0].name = "PI-HOLE troubleshooting";
  fs.writeFileSync(deviceIndexPath, JSON.stringify(deviceIndex), "utf8");
  writePartition(root, DESTINATION_DEVICE, [
    session({
      id: DESTINATION_SESSION,
      name: "Pi-hole on foreign device",
      deviceId: DESTINATION_DEVICE,
    }),
  ]);
  fs.writeFileSync(
    path.join(partitionDir(root, SOURCE_DEVICE), "skip-list.json"),
    JSON.stringify({ version: 1, entries: {} }),
    "utf8",
  );

  const result = findSessions(root, "pi-hole");
  assert.equal(result.searchedPartitions, 3);
  assert.deepEqual(result.invalidEntries, []);
  assert.deepEqual(
    result.matches.map(({ device, id, name }) => ({ device, id, name })),
    [
      { device: SOURCE_DEVICE, id: SECOND_SESSION, name: "PI-HOLE troubleshooting" },
      {
        device: DESTINATION_DEVICE,
        id: DESTINATION_SESSION,
        name: "Pi-hole on foreign device",
      },
      { device: "shared", id: SOURCE_SESSION, name: "Configure Pi-hole DNS" },
    ],
  );
  assert.equal(result.matches[0].metadataSource, "index");
  assert.equal(result.matches[0].metadataDrift, true);
  assert.deepEqual(result.matches[0].matchSources, ["title"]);
  assert.equal(result.matches[0].matchSource, "title");

  const human = captureConsole(() =>
    main(["find", "PI-hole", "--sessions-root", root, "--destination-device", SOURCE_DEVICE]),
  );
  assert.equal(human.result, 0);
  assert.match(human.logs[0], /^NAME +LOCATION +UPDATED +MATCH/m);
  assert.match(human.logs[0], /current\/33333333/);
  assert.match(human.logs[0], /bbbbbbbb\/22222222/);
  assert.match(human.logs[0], /shared\/11111111/);
  assert.match(human.logs[0], /Jul 01 00:00Z/);
  assert.doesNotMatch(human.logs[0], new RegExp(SOURCE_DEVICE));
  assert.doesNotMatch(human.logs[0], new RegExp(SOURCE_SESSION));
  assert.match(human.logs[1], /Found 3 matching sessions across 3 partitions/);

  const actionable = captureConsole(() =>
    main([
      "copy",
      "--from",
      `${DESTINATION_DEVICE.slice(0, 8)}/${DESTINATION_SESSION.slice(0, 8)}`,
      "--to",
      "current",
      "--destination-device",
      SOURCE_DEVICE,
      "--sessions-root",
      root,
    ]),
  );
  assert.equal(actionable.result, 0);
  assert.match(actionable.logs[0], new RegExp(DESTINATION_SESSION));
  assert.match(actionable.logs[0], new RegExp(`device:${SOURCE_DEVICE}`));

  const verbose = captureConsole(() =>
    main(["find", "PI-hole", "--sessions-root", root, "--verbose"]),
  );
  assert.equal(verbose.result, 0);
  assert.match(verbose.logs[0], /^NAME +DEVICE +SESSION ID +UPDATED +TYPE +STORAGE STATE +MATCH/m);
  assert.match(verbose.logs[0], new RegExp(SOURCE_DEVICE));
  assert.match(verbose.logs[0], new RegExp(SOURCE_SESSION));
  assert.match(verbose.logs[0], /2026-07-01T00:00Z/);

  const json = captureConsole(() =>
    main(["find", "--title", "pi-hole", "--sessions-root", root, "--json"]),
  );
  assert.equal(json.result, 0);
  assert.equal(json.logs[0], JSON.stringify(result, null, 2));
});

test("find searches selected transcript content without leaking snippets", () => {
  const root = path.join(tempDir(), "Apps", "Microsoft Scout", "sessions");
  fs.mkdirSync(path.join(root, "devices"), { recursive: true });
  const ids = [
    "50000000-0000-4000-8000-000000000001",
    "50000000-0000-4000-8000-000000000002",
    "50000000-0000-4000-8000-000000000003",
    "50000000-0000-4000-8000-000000000004",
    "50000000-0000-4000-8000-000000000005",
    "50000000-0000-4000-8000-000000000006",
    "50000000-0000-4000-8000-000000000007",
  ];
  const message = (role, content, overrides = {}) => ({
    id: `${role}-${content}`,
    role,
    content,
    timestamp: "2026-08-30T12:00:00.000Z",
    ...overrides,
  });
  writePartition(root, SOURCE_DEVICE, [
    session({
      id: ids[0],
      name: "Generic user chat",
      messages: [message("user", "Private UserNeedle details must not print")],
    }),
    session({
      id: ids[1],
      name: "Generic assistant chat",
      messages: [message("assistant", "AssistantNeedle response")],
    }),
    session({
      id: ids[2],
      name: "Generic system chat",
      source: "automation",
      messages: [message("system", "SystemNeedle instruction")],
    }),
    session({
      id: ids[3],
      name: "Generic tool chat",
      messages: [
        message("assistant", "", {
          toolCalls: [
            {
              name: "lookup",
              description: "Nested tool",
              args: { request: ["ArgsNeedle"] },
              result: { deeply: { nested: "ResultNeedle" } },
            },
          ],
        }),
      ],
    }),
    session({
      id: ids[4],
      name: "ComboNeedle title",
      messages: [message("user", "comboneedle transcript")],
    }),
    session({
      id: ids[5],
      name: "Reasoning chat",
      messages: [
        message("assistant", "Visible response", {
          reasoning: { text: "ReasoningNeedle", durationSeconds: 1 },
        }),
      ],
    }),
    session({
      id: ids[6],
      name: "Summary chat",
      contextSummary: "SummaryNeedle context",
      messages: [message("user", "Older content")],
    }),
  ]);

  for (const query of [
    "userneedle",
    "ASSISTANTNEEDLE",
    "systemneedle",
    "argsneedle",
    "resultneedle",
    "reasoningneedle",
    "summaryneedle",
  ]) {
    const result = findSessions(root, query);
    assert.equal(result.matches.length, 1, query);
    assert.deepEqual(result.matches[0].matchSources, ["transcript"]);
    assert.equal(result.matches[0].matchSource, "transcript");
  }

  const both = findSessions(root, "COMBONEEDLE");
  assert.equal(both.matches.length, 1);
  assert.deepEqual(both.matches[0].matchSources, ["title", "transcript"]);
  assert.equal(both.matches[0].matchSource, "title + transcript");
  assert.equal(findSessions(root, "unrelated").matches.length, 0);
  assert.equal(findSessions(root, "userneedle", { titleOnly: true }).matches.length, 0);
  assert.equal(findSessions(root, "comboneedle", { titleOnly: true }).matches.length, 1);

  const human = captureConsole(() => main(["find", "UserNeedle", "--sessions-root", root]));
  assert.equal(human.result, 0);
  assert.match(human.logs[0], /\btext\b/);
  assert.doesNotMatch(human.logs[0], /transcript/);
  assert.doesNotMatch(human.logs.join("\n"), /Private UserNeedle details must not print/);

  const exceptional = captureConsole(() => main(["find", "SystemNeedle", "--sessions-root", root]));
  assert.match(exceptional.logs[0], /^NAME +LOCATION +UPDATED +MATCH +NOTES/m);
  assert.match(exceptional.logs[0], /automation/);

  const json = captureConsole(() =>
    main(["find", "UserNeedle", "--sessions-root", root, "--json"]),
  );
  const parsed = JSON.parse(json.logs[0]);
  assert.equal(parsed.matches[0].matchSource, "transcript");
  assert.deepEqual(parsed.matches[0].matchSources, ["transcript"]);
  assert.equal("messages" in parsed.matches[0], false);

  const malformedId = "50000000-0000-4000-8000-000000000008";
  fs.writeFileSync(
    path.join(partitionDir(root, SOURCE_DEVICE), `${malformedId}.json`),
    JSON.stringify(
      session({
        id: malformedId,
        name: "Malformed content",
        messages: [message("user", null)],
      }),
    ),
    "utf8",
  );
  const malformed = findSessions(root, "unrelated");
  assert.equal(malformed.invalidEntries.length, 1);
  assert.match(malformed.invalidEntries[0].error, /invalid messages/);
});

test("find reports index conflict copies without treating them as invalid sessions", () => {
  const root = makeSessionsTree();
  const deviceDir = partitionDir(root, SOURCE_DEVICE);
  const conflicts = [
    "sessions-index 2.json",
    "sessions-index (Tom's MacBook Pro conflicted copy 2026-08-30).json",
    "sessions-index-DESKTOP-ABC123.json",
  ];
  for (const name of conflicts) {
    fs.writeFileSync(path.join(deviceDir, name), "{}", "utf8");
  }

  const found = findSessions(root, "recovered");
  assert.equal(found.matches.length, 1);
  assert.deepEqual(found.invalidEntries, []);
  assert.deepEqual(
    found.indexConflicts,
    conflicts.sort().map((file) => ({ device: SOURCE_DEVICE, file })),
  );

  const human = captureConsole(() => main(["find", "insurance", "--sessions-root", root]));
  assert.equal(human.result, 0);
  assert.match(human.logs.at(-1), /Found 0 matching sessions/);
  assert.equal(human.errors.length, conflicts.length);
  assert.match(human.errors[0], /ignored conflicting session index copy/);
  assert.doesNotMatch(human.errors.join("\n"), /JSON filename is not a session UUID/);

  const listed = captureConsole(() =>
    main(["sessions", "--device", SOURCE_DEVICE, "--sessions-root", root]),
  );
  assert.equal(listed.result, 0);
  assert.equal(listed.errors.length, 1);
  assert.match(listed.errors[0], /sessions-index 2\.json/);
  assert.doesNotMatch(listed.errors[0], /JSON filename is not a session UUID/);

  fs.writeFileSync(path.join(deviceDir, "sessions-indexed.json"), "{}", "utf8");
  const arbitraryJson = findSessions(root, "insurance");
  assert.equal(arbitraryJson.invalidEntries.length, 1);
  assert.match(arbitraryJson.invalidEntries[0].error, /filename is not a session UUID/);
});

test("formats headed aligned tables without tabs and truncates flexible text", () => {
  const table = formatTable(
    [
      {
        name: "A very long friendly session name that should not break the table",
        id: SOURCE_SESSION,
        count: null,
      },
      { name: "Short", id: SECOND_SESSION, count: 12 },
    ],
    [
      { key: "name", header: "NAME", maxWidth: 20, minWidth: 10, flex: true },
      { key: "id", header: "SESSION ID", maxWidth: 36 },
      { key: "count", header: "MESSAGES" },
    ],
    { terminalWidth: 72 },
  );
  const lines = table.split("\n");
  assert.match(lines[0], /^NAME +SESSION ID +MESSAGES$/);
  assert.match(lines[1], /^[-]+  [-]+  [-]+$/);
  assert.match(lines[2], /^A very long friendl…  11111111-1111-4111-8111-111111111111  -$/);
  assert.equal(lines[0].indexOf("SESSION ID"), lines[2].indexOf(SOURCE_SESSION));
  assert.equal(lines[0].indexOf("MESSAGES"), lines[2].lastIndexOf("-"));
  assert.equal(table.includes("\t"), false);
});

test("copy and delete previews retain full consequential IDs", () => {
  const root = makeSessionsTree();
  const copy = captureConsole(() =>
    main([
      "copy",
      "--from",
      SOURCE_DEVICE,
      "--to",
      DESTINATION_DEVICE,
      "--session-id",
      SOURCE_SESSION,
      "--sessions-root",
      root,
    ]),
  );
  assert.equal(copy.result, 0);
  assert.match(copy.logs[0], /SOURCE SESSION ID/);
  assert.match(copy.logs[0], new RegExp(SOURCE_SESSION));

  const deletion = captureConsole(() =>
    main([
      "delete",
      "--device",
      SOURCE_DEVICE,
      "--session-id",
      SOURCE_SESSION,
      "--sessions-root",
      root,
    ]),
  );
  assert.equal(deletion.result, 0);
  assert.match(deletion.logs[0], /SESSION ID/);
  assert.match(deletion.logs[0], new RegExp(SOURCE_SESSION));
});

test("devices and sessions human output has clear headings while JSON stays unchanged", () => {
  const root = makeSessionsTree();
  const devices = captureConsole(() =>
    main(["devices", "--sessions-root", root, "--destination-device", SOURCE_DEVICE]),
  );
  assert.equal(devices.result, 0);
  assert.match(devices.logs[0], /^DEVICE +SESSIONS +ISSUES +NEWEST/m);
  assert.match(devices.logs[0], /current +1 +- +Jul 01 00:00Z/);
  assert.match(devices.logs[0], /shared +0 +index missing/);
  assert.doesNotMatch(devices.logs[0], new RegExp(SOURCE_DEVICE));
  assert.equal(devices.logs[0].includes("\t"), false);

  const sessions = captureConsole(() =>
    main(["sessions", "--device", SOURCE_DEVICE, "--sessions-root", root]),
  );
  assert.equal(sessions.result, 0);
  assert.match(sessions.logs[0], /^NAME +SESSION +UPDATED/m);
  assert.match(sessions.logs[0], /Recovered chat +11111111 +Jul 01 00:00Z/);
  assert.doesNotMatch(sessions.logs[0], new RegExp(SOURCE_SESSION));
  assert.doesNotMatch(sessions.logs[0], /indexed|CREATED|MESSAGES|TYPE|STORAGE STATE/);
  assert.equal(sessions.logs[0].includes("\t"), false);
  assert.equal(sessions.logs.length, 1);

  const verboseDevices = captureConsole(() =>
    main(["devices", "--sessions-root", root, "--destination-device", SOURCE_DEVICE, "--verbose"]),
  );
  assert.match(
    verboseDevices.logs[0],
    /^LABEL +DEVICE +BLOBS +INDEXED +ORPHANS +INVALID +NEWEST SESSION +INDEX/m,
  );
  assert.match(verboseDevices.logs[0], new RegExp(SOURCE_DEVICE));
  assert.match(verboseDevices.logs[0], /2026-07-01T00:00Z/);

  const verboseSessions = captureConsole(() =>
    main(["sessions", "--device", SOURCE_DEVICE, "--sessions-root", root, "--verbose"]),
  );
  assert.match(
    verboseSessions.logs[0],
    /^NAME +SESSION ID +CREATED +UPDATED +MESSAGES +TYPE +STORAGE STATE/m,
  );
  assert.match(verboseSessions.logs[0], new RegExp(SOURCE_SESSION));
  assert.match(verboseSessions.logs[0], /indexed/);
  assert.match(verboseSessions.logs[0], /2026-01-01T00:00Z/);
  assert.match(
    verboseSessions.logs[1],
    /^Summary: 1 valid blobs; 1 indexed; 0 orphaned; 1 sidebar candidates; 0 indexed sessions use index details that differ from their files\.$/,
  );

  const orphan = session({
    id: SECOND_SESSION,
    name: "Orphaned automation",
    source: "automation",
    isActive: false,
  });
  fs.writeFileSync(
    path.join(partitionDir(root, SOURCE_DEVICE), `${SECOND_SESSION}.json`),
    JSON.stringify(orphan),
  );
  fs.writeFileSync(path.join(partitionDir(root, SOURCE_DEVICE), "not-a-session.json"), "{}");
  fs.writeFileSync(path.join(partitionDir(root, SOURCE_DEVICE), "sessions-index 2.json"), "{}");
  const issues = listDevices(root, SOURCE_DEVICE).find((row) => row.device === SOURCE_DEVICE);
  assert.equal(formatDeviceIssues(issues), "1 orphan, 1 invalid, 1 index conflict");
  const issueDevices = captureConsole(() =>
    main(["devices", "--sessions-root", root, "--destination-device", SOURCE_DEVICE]),
  );
  assert.match(issueDevices.logs[0], /1 orphan, 1 invalid, 1 index conflict/);
  const issueSessions = captureConsole(() =>
    main(["sessions", "--device", SOURCE_DEVICE, "--sessions-root", root]),
  );
  assert.match(issueSessions.logs[0], /^NAME +SESSION +UPDATED +NOTES/m);
  assert.match(issueSessions.logs[0], /automation, orphan/);

  const expectedJson = JSON.stringify(listDevices(root, SOURCE_DEVICE), null, 2);
  const json = captureConsole(() =>
    main(["devices", "--sessions-root", root, "--destination-device", SOURCE_DEVICE, "--json"]),
  );
  assert.equal(json.logs.length, 1);
  assert.equal(json.logs[0], expectedJson);
  const verboseJson = captureConsole(() =>
    main([
      "devices",
      "--sessions-root",
      root,
      "--destination-device",
      SOURCE_DEVICE,
      "--verbose",
      "--json",
    ]),
  );
  assert.equal(verboseJson.logs[0], expectedJson);

  const expectedSessionsJson = JSON.stringify(
    listPartitionSessions(root, SOURCE_DEVICE, { sort: "updated", filter: null }),
    null,
    2,
  );
  const sessionsJson = captureConsole(() =>
    main(["sessions", "--device", SOURCE_DEVICE, "--sessions-root", root, "--json"]),
  );
  assert.equal(sessionsJson.logs.length, 1);
  assert.equal(sessionsJson.logs[0], expectedSessionsJson);
  assert.match(sessionsJson.logs[0], /2026-07-01T00:00:00\.000Z/);

  const sidebar = captureConsole(() =>
    main(["sessions", "--device", SOURCE_DEVICE, "--sessions-root", root, "--sidebar-only"]),
  );
  assert.match(sidebar.errors.at(-1), /cloud-partition approximation/);
});

test("parses explicit verbs and repeatable selections", () => {
  const find = parseArgs(["find", "pi-hole", "--sort", "name"]);
  assert.equal(find.verb, "find");
  assert.equal(find.query, "pi-hole");
  assert.equal(find.sort, "name");
  assert.equal(find.titleOnly, false);
  assert.equal(find.verbose, false);
  assert.equal(parseArgs(["find", "pi-hole", "--verbose"]).verbose, true);
  assert.equal(parseArgs(["find", "--title=PI-HOLE"]).query, "PI-HOLE");
  assert.equal(parseArgs(["find", "PI-HOLE", "--title-only"]).titleOnly, true);
  assert.throws(() => parseArgs(["find"]), /requires a title substring/);
  assert.throws(() => parseArgs(["devices", "--title-only"]), /valid only with the find verb/);

  const copy = parseArgs([
    "copy",
    "--from",
    SOURCE_DEVICE,
    "--to",
    "shared",
    "--session-id",
    `${SOURCE_SESSION},${SECOND_SESSION}`,
    "--apply",
  ]);
  assert.equal(copy.verb, "copy");
  assert.equal(copy.from, SOURCE_DEVICE);
  assert.equal(copy.to, "shared");
  assert.equal(copy.sessionIds.size, 2);
  assert.equal(copy.apply, true);
  const locationCopy = parseArgs(["copy", "--from", "bdec03f9/fcca233d", "--to", "current"]);
  assert.equal(locationCopy.from, "bdec03f9");
  assert.deepEqual([...locationCopy.sessionIds], ["fcca233d"]);
  assert.deepEqual(
    [...parseArgs(["copy", "--session-id", "11111111,33333333"]).sessionIds],
    ["11111111", "33333333"],
  );
  assert.deepEqual(
    [...parseArgs(["copy", "--session-id", "11111111-1111"]).sessionIds],
    ["11111111-1111"],
  );
  assert.throws(
    () => parseArgs(["copy", "--session-id", "1111111"]),
    /at least 8 hexadecimal characters/,
  );
  assert.throws(
    () => parseArgs(["copy", "--from", "bdec03f9/fcca233d/extra", "--to", "current"]),
    /use exactly <device-ref>\/<session-ref>/,
  );
  assert.throws(
    () => parseArgs(["copy", "--from", "bdec03f9/", "--to", "current"]),
    /use exactly <device-ref>\/<session-ref>/,
  );
  assert.throws(
    () => parseArgs(["copy", "--from", "bdec03f9/fcca233d,0a0310c1", "--to", "current"]),
    /LOCATION selects one session.*--session-id/,
  );
  assert.throws(
    () => parseArgs(["copy", "--from", "bdec03f9", "--from", "shared/fcca233d"]),
    /Specify --from once/,
  );
  assert.throws(
    () => parseArgs(["copy", "--from", "bdec03f9/fcca233d", "--to", "current", "--all"]),
    /--all cannot be combined/,
  );
  assert.throws(
    () => parseArgs(["copy", "--from", "bdec03f9/fcca233d", "--to", "current/aaaaaaaa"]),
    /--to accepts a destination partition only/,
  );
  assert.throws(
    () => parseArgs(["sessions", "--device", "aaaaaaa"]),
    /at least 8 hexadecimal characters/,
  );
  assert.equal(
    parseArgs(["sessions", "--device", SOURCE_DEVICE.toUpperCase()]).device,
    SOURCE_DEVICE.toUpperCase(),
  );
  assert.equal(parseArgs(["sessions", "--device", "AAAAAAAA"]).device, "AAAAAAAA");
  assert.equal(
    parseArgs([
      "sessions",
      "--device",
      "current",
      "--destination-device",
      SOURCE_DEVICE.toUpperCase(),
    ]).destinationDeviceId,
    SOURCE_DEVICE.toUpperCase(),
  );
  assert.throws(
    () => parseArgs(["sessions", "--device", "current", "--destination-device", "aaaaaaaa"]),
    /exactly 32 hexadecimal characters/,
  );

  const deletion = parseArgs([
    "delete",
    "--device=current",
    `--session-id=${SOURCE_SESSION}`,
    "--apply",
    "--yes",
  ]);
  assert.equal(deletion.device, "current");
  assert.equal(deletion.yes, true);

  const listing = parseArgs(["sessions", "--device", "shared", "--sidebar-only"]);
  assert.equal(listing.sidebarOnly, true);
});

test("help explains standalone architecture, workflows, and safety boundaries", () => {
  const help = captureConsole(() => main(["--help"]));
  assert.equal(help.result, 0);
  assert.equal(help.errors.length, 0);
  assert.equal(help.logs.length, 1);
  assert.match(help.logs[0], /Always Keep on This Device/);
  assert.match(help.logs[0], /devices\/<device-id>\/sessions-index\.json \+ <uuid>\.json/);
  assert.match(help.logs[0], /Search canonical titles and stored conversation content/);
  assert.match(help.logs[0], /stored conversation content/);
  assert.match(help.logs[0], /--title-only/);
  assert.match(help.logs[0], /--verbose/);
  assert.match(help.logs[0], /can be reused when they uniquely match/);
  assert.match(help.logs[0], /Ambiguous prefixes fail closed/);
  assert.match(help.logs[0], /--from bdec03f9\/fcca233d --to current/);
  assert.match(help.logs[0], /explicit --session-id values add to that selection/);
  assert.match(help.logs[0], /--to <device> +Destination partition only/);
  assert.match(help.logs[0], /copy --from <found-device> --to current/);
  assert.match(help.logs[0], /"orphan" means a valid blob without a row/);
  assert.match(help.logs[0], /encrypted local aggregate index/);
  assert.match(help.logs[0], /fresh UUID/);
  assert.match(help.logs[0], /index fingerprint compare-and-swap/);
  assert.match(help.logs[0], /Attachment names may survive/);
  assert.match(help.logs[0], /--apply --yes/);
});

test("source documents standalone storage and recovery invariants", () => {
  const source = fs.readFileSync(new URL("./scout-sessions.mjs", import.meta.url), "utf8");
  assert.match(source, /PURPOSE[\s\S]*COMMANDS[\s\S]*BEFORE USE[\s\S]*ONEDRIVE LAYOUT/);
  assert.match(source, /Content blobs own messages and StoredSession-only content/);
  assert.match(source, /SHA-256 of macOS IOPlatformUUID/);
  assert.match(source, /An "orphan" is a valid content blob/);
  assert.match(source, /Search canonical titles and transcript content/);
  assert.match(source, /Human read-only commands default to compact tables/);
  assert.match(source, /leaves skip-list\.json unchanged/);
  assert.match(source, /Copy mints a fresh UUID/);
  assert.match(source, /Files On-Demand placeholders/);
  assert.match(source, /Index writes compare the previously read fingerprint \(CAS\)/);
  assert.match(source, /rerunning a copy[\s\S]*reuses its[\s\S]*minted UUID/);
});

test("importing the standalone module does not run the CLI", () => {
  const moduleUrl = new URL("./scout-sessions.mjs", import.meta.url).href;
  const imported = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(moduleUrl)})`],
    { encoding: "utf8" },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
});
