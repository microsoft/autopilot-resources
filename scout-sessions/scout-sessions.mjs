#!/usr/bin/env node

/**
 * Standalone Microsoft Scout session recovery and maintenance CLI v1.0.2.
 *
 * PURPOSE
 *   Inspect locally synced OneDrive session storage and safely list, search,
 *   copy, or delete selected session JSON without launching Scout. This is an
 *   offline repair tool, not a Scout product feature, a cloud API client, an
 *   exact sidebar emulator, or a way to migrate Copilot runtime checkpoints.
 *   It has no package dependencies and may be copied and run by itself with
 *   Node.js 20 or newer.
 *
 * COMMANDS
 *   devices   Summarize the shared partition and every per-device partition.
 *   sessions  List one partition; optionally filter or approximate sidebar rows.
 *   find      Search canonical titles and transcript content across partitions;
 *             use --title-only to restrict matching to canonical titles.
 *   copy      Clone selected eligible sessions between partitions.
 *   delete    Remove selected content/index rows with recoverable bookkeeping.
 *
 * FIND SCOPE
 *   By default find matches the canonical index-owned title plus stored
 *   conversation content: user/assistant/system message content, reasoning text,
 *   selected tool-call description/arguments/results/errors (recursing through
 *   nested strings), and contextSummary. It does not search permission cards,
 *   routing/runtime metadata, identifiers, or timestamps, and human output
 *   reports only whether title/transcript matched, not matching snippets.
 *
 * OUTPUT
 *   Human read-only commands default to compact tables with 8-character ID
 *   prefixes and compact timestamps. These prefixes may be passed directly to
 *   device/session options when they uniquely identify an existing partition or
 *   validated blob; ambiguous prefixes fail closed and require more characters
 *   or --verbose. Use --verbose for full IDs, ISO-like timestamps,
 *   classifications, storage state, and detailed counts; use --json for the
 *   unchanged machine-readable values. Copy/delete previews always retain full
 *   IDs. For example, a find location bdec03f9/0a0310c1 can be copied with
 *   `copy --from bdec03f9/0a0310c1 --to current`. Explicit --session-id
 *   selections may be added and are deduplicated after resolution.
 *
 * BEFORE USE
 *   Quit Scout, let OneDrive finish syncing, and mark the Microsoft Scout
 *   OneDrive folder "Always Keep on This Device" so Files On-Demand placeholders
 *   are fully downloaded. After a mutation, let OneDrive sync again before
 *   reopening Scout. Listing is read-only. Copy/delete are dry runs unless
 *   --apply is present; delete additionally requires --yes.
 *
 * ONEDRIVE LAYOUT
 *   <OneDrive>/Apps/Microsoft Scout/sessions/
 *     sessions-index.json                         shared/legacy metadata
 *     <session-uuid>.json                         shared/legacy content
 *     devices/<32-hex-device-id>/
 *       sessions-index.json                       that device's metadata
 *       <session-uuid>.json                       that device's content
 *       skip-list.json                            Scout reconciliation cache
 *
 *   Content blobs own messages and StoredSession-only content. The partition
 *   sessions-index owns SessionMetadata such as the canonical title,
 *   timestamps, classification, model, pin/sensitivity, backend identity, and
 *   routing. For indexed blobs this tool overlays index metadata before display
 *   or copy. An "orphan" is a valid content blob with no row in that partition's
 *   index, so only its embedded metadata is available.
 *
 * DEVICE IDENTITY AND LOCAL-ONLY STATE
 *   The current device ID matches Scout: SHA-256 of macOS IOPlatformUUID from
 *   /usr/sbin/ioreg or Windows MachineGuid from
 *   %SystemRoot%\System32\reg.exe, truncated to 32 lowercase hex characters.
 *   Raw machine IDs are never printed or stored. Linux requires an explicit
 *   --destination-device override when the "current" alias is used.
 *
 *   OneDrive partition indexes are not Scout's complete runtime state. Scout
 *   renders and routes from its encrypted local aggregate index and Copilot
 *   keeps a machine-local runtime checkpoint. This file reads neither. It also
 *   leaves skip-list.json unchanged. Consequently --sidebar-only is only a
 *   partition-local approximation: indexed Copilot/local rows minus known
 *   non-chat origins; it cannot account for pending uploads, local-only rows,
 *   skip-cache decisions, pin ordering, current search, or the active UI filter.
 *
 * COPY FIDELITY AND LIMITS
 *   Copy mints a fresh UUID to avoid colliding with the source identity or
 *   attaching to a machine-local runtime checkpoint. It preserves the stored
 *   transcript and createdAt, applies canonical index metadata, restamps
 *   updatedAt, routes the clone to Copilot/local storage, and clears backend
 *   aliases plus persisted active/runtime/permission-card state. Opening the
 *   clone starts a fresh runtime; exact in-progress agent/tool state cannot be
 *   resumed. Persisted attachment names survive, but original attachment paths
 *   or bytes generally are not stored here. Benchmark, Teams, heartbeat,
 *   automation, gateway, and remote-authoritative sessions are not copyable.
 *
 * MUTATION SAFETY
 *   Writes are mode-0600 temp-file + rename operations under tool/partition
 *   locks. Index writes compare the previously read fingerprint (CAS) and abort
 *   on concurrent changes. Before mutating a partition, valid OneDrive index
 *   conflict copies are conservatively merged into sessions-index.json and
 *   archived; malformed or irreconcilable copies still fail closed. Read-only
 *   commands report and ignore recognizable conflict copies. A durable manifest records
 *   planned/completed copy and delete operations: rerunning a copy reuses its
 *   minted UUID and skips an identical completed clone; source drift is refused.
 *   Delete backs up content and any existing index before removing the index row
 *   and then the blob, and planned deletes can be resumed. These local
 *   safeguards do not make a running Scout or unsynced OneDrive safe.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const DEVICE_ID_RE = /^[a-f0-9]{32}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SCOUT_SESSIONS_VERSION = "1.0.2";
const DEVICE_PREFIX_RE = /^[a-f0-9]{8,31}$/i;
const SESSION_PREFIX_RE =
  /^(?:[a-f0-9]{8,32}|[a-f0-9]{8}(?:-[a-f0-9]{0,4}(?:-[a-f0-9]{0,4}(?:-[a-f0-9]{0,4}(?:-[a-f0-9]{0,12})?)?)?)?)$/i;
export const SESSION_TOOL_MANIFEST_NAME = "scout-sessions-manifest.json";
const INDEX_NAME = "sessions-index.json";
const MAX_SESSION_BYTES = 50 * 1024 * 1024;
const SUPPORTED_SOURCES = new Set([undefined, "user", "workspace"]);
const INDEX_FIELDS = [
  "id",
  "name",
  "createdAt",
  "updatedAt",
  "hasUnread",
  "isActive",
  "model",
  "reasoningEffort",
  "contextWindowTokens",
  "personality",
  "source",
  "automationId",
  "workspaceName",
  "contentAuthority",
  "backendOrigin",
  "backendId",
  "deviceId",
  "sensitivity",
  "pinnedOrder",
  "benchmark",
  "kind",
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function validMessage(message) {
  if (!isObject(message)) return false;
  if (typeof message.id !== "string" || message.id.length === 0) return false;
  if (!["user", "assistant", "system"].includes(message.role)) return false;
  if (typeof message.content !== "string" || !isIsoDate(message.timestamp)) return false;
  if (
    message.fileNames !== undefined &&
    (!Array.isArray(message.fileNames) ||
      message.fileNames.some((fileName) => typeof fileName !== "string"))
  ) {
    return false;
  }
  if (
    message.toolCalls !== undefined &&
    (!Array.isArray(message.toolCalls) ||
      message.toolCalls.some(
        (toolCall) =>
          !isObject(toolCall) ||
          typeof toolCall.name !== "string" ||
          typeof toolCall.description !== "string",
      ))
  ) {
    return false;
  }
  return true;
}

export function parseIoregOutput(stdout) {
  return stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? null;
}

export function parseMachineGuidOutput(stdout) {
  return stdout.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/)?.[1] ?? null;
}

export function deviceIdFromMachineId(raw) {
  return sha256(raw).slice(0, 32);
}

export function deriveCurrentDeviceId({
  exec = execFileSync,
  platform = process.platform,
  env = process.env,
} = {}) {
  let command;
  let args;
  let parser;
  if (platform === "darwin") {
    command = "/usr/sbin/ioreg";
    args = ["-rd1", "-c", "IOPlatformExpertDevice"];
    parser = parseIoregOutput;
  } else if (platform === "win32") {
    const systemRoot = env.SystemRoot ?? "C:\\Windows";
    command = path.win32.join(systemRoot, "System32", "reg.exe");
    args = ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"];
    parser = parseMachineGuidOutput;
  } else {
    throw new Error(
      "Automatic current-device detection supports macOS and Windows only; pass --destination-device.",
    );
  }
  let stdout;
  try {
    stdout = exec(command, args, { encoding: "utf8", timeout: 5000, windowsHide: true });
  } catch (error) {
    throw new Error(`Could not read this machine's Scout identifier: ${errorMessage(error)}`);
  }
  const machineId = parser(stdout);
  if (!machineId) throw new Error("The platform command did not return a machine identifier");
  return deviceIdFromMachineId(machineId);
}

export const deriveMacDeviceId = deriveCurrentDeviceId;

export function normalizeSessionsRoot(input) {
  const resolved = path.resolve(input);
  const candidates = [
    resolved,
    path.join(resolved, "sessions"),
    path.join(resolved, "Apps", "Microsoft Scout", "sessions"),
  ];
  const match = candidates.find(
    (candidate) =>
      path.basename(candidate) === "sessions" &&
      fs.existsSync(path.join(candidate, "devices")) &&
      fs.statSync(path.join(candidate, "devices")).isDirectory(),
  );
  if (!match) {
    throw new Error(
      `No Scout sessions/devices tree found under ${resolved}. Pass the folder containing "devices".`,
    );
  }
  return match;
}

export function detectSessionsRoots({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  const candidates = [];
  if (platform === "darwin") {
    const cloudStorage = path.join(home, "Library", "CloudStorage");
    if (fs.existsSync(cloudStorage)) {
      for (const entry of fs.readdirSync(cloudStorage, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("OneDrive")) {
          candidates.push(path.join(cloudStorage, entry.name));
        }
      }
    }
  } else if (platform === "win32") {
    for (const key of ["OneDriveCommercial", "OneDrive", "OneDriveConsumer"]) {
      if (env[key]) candidates.push(env[key]);
    }
  }
  return [
    ...new Set(
      candidates
        .map((candidate) => path.join(candidate, "Apps", "Microsoft Scout", "sessions"))
        .filter((candidate) => fs.existsSync(path.join(candidate, "devices"))),
    ),
  ];
}

export function resolveSessionsRoot(explicitRoot, discoveryOptions) {
  if (explicitRoot) return normalizeSessionsRoot(explicitRoot);
  const roots = detectSessionsRoots(discoveryOptions);
  if (roots.length === 0) {
    throw new Error(
      'No locally synced Scout sessions tree found. Download "Apps/Microsoft Scout/sessions" in OneDrive or pass --sessions-root.',
    );
  }
  if (roots.length > 1) {
    throw new Error(
      `Multiple Scout session roots found; pass --sessions-root explicitly:\n${roots.map((root) => `  ${root}`).join("\n")}`,
    );
  }
  return roots[0];
}

export function partitionKey(deviceId) {
  return deviceId === null ? "shared" : `device:${deviceId}`;
}

export function resolveDeviceRef(
  value,
  currentDeviceId,
  sessionsRoot,
  { allowExactMissing = false } = {},
) {
  if (value === "shared") return null;
  if (value === "current") {
    if (!currentDeviceId)
      throw new Error('"current" requires current-device detection or override');
    return currentDeviceId;
  }
  if (!DEVICE_ID_RE.test((value ?? "").toLowerCase()) && !DEVICE_PREFIX_RE.test(value ?? "")) {
    throw new Error(
      `Invalid device reference: ${value ?? "(missing)"}; use shared, current, or at least 8 hexadecimal characters`,
    );
  }
  if (!sessionsRoot) {
    if (!DEVICE_ID_RE.test((value ?? "").toLowerCase())) {
      throw new Error("Resolving a device prefix requires the Scout sessions root");
    }
    return value.toLowerCase();
  }
  const normalized = value.toLowerCase();
  const matches = listDevicePartitionIds(sessionsRoot).filter((id) =>
    id.toLowerCase().startsWith(normalized),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous device prefix "${value}" matches ${matches.length} partitions; use more characters or --verbose`,
    );
  }
  if (allowExactMissing && DEVICE_ID_RE.test(normalized)) return normalized;
  throw new Error(
    `No device partition matches "${value}"; run devices or use --verbose to find the full ID`,
  );
}

export function partitionDirectory(sessionsRoot, deviceId) {
  return deviceId === null ? sessionsRoot : path.join(sessionsRoot, "devices", deviceId);
}

function partitionLabel(deviceId, currentDeviceId) {
  if (deviceId === null) return "shared";
  return deviceId === currentDeviceId ? `current (${deviceId.slice(0, 8)})` : deviceId.slice(0, 8);
}

function validateMetadata(value, deviceId) {
  if (!isObject(value)) return "index row must be an object";
  if (!UUID_RE.test(value.id ?? "")) return "index row has invalid id";
  if (typeof value.name !== "string") return "index row has invalid name";
  if (!isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt)) {
    return "index row has invalid timestamp";
  }
  if (typeof value.hasUnread !== "boolean" || typeof value.isActive !== "boolean") {
    return "index row has invalid state";
  }
  if (deviceId === null && value.deviceId !== undefined) {
    return "shared index row must not contain deviceId";
  }
  if (deviceId !== null && value.deviceId !== deviceId) {
    return "device index row does not match its partition";
  }
  return null;
}

export function validateStoredSession(value, expected) {
  if (!isObject(value)) return { success: false, error: "session must be an object" };
  const session = value;
  if (!UUID_RE.test(session.id ?? "")) return { success: false, error: "invalid session id" };
  if (typeof session.name !== "string") return { success: false, error: "invalid session name" };
  if (!isIsoDate(session.createdAt) || !isIsoDate(session.updatedAt)) {
    return { success: false, error: "invalid session timestamp" };
  }
  if (typeof session.hasUnread !== "boolean" || typeof session.isActive !== "boolean") {
    return { success: false, error: "invalid session state" };
  }
  if (
    !Array.isArray(session.messages) ||
    session.messages.some((message) => !validMessage(message))
  ) {
    return { success: false, error: "invalid messages" };
  }
  if (session.permissionCards !== undefined && !Array.isArray(session.permissionCards)) {
    return { success: false, error: "invalid permission cards" };
  }
  if (session.id !== expected.sessionId) {
    return { success: false, error: "session id does not match its filename" };
  }
  if (expected.deviceId === null && session.deviceId !== undefined) {
    return { success: false, error: "shared session must not contain deviceId" };
  }
  if (expected.deviceId !== null && session.deviceId !== expected.deviceId) {
    return { success: false, error: "deviceId does not match its folder" };
  }
  return { success: true, session };
}

export function classifySession(session) {
  if ((session.backendOrigin ?? "copilot") !== "copilot") {
    return { copyEligible: false, classification: "gateway", reason: "gateway-backed" };
  }
  if (session.contentAuthority === "remote") {
    return { copyEligible: false, classification: "remote", reason: "remote-authoritative" };
  }
  if (session.benchmark !== undefined || session.kind === "benchmark") {
    return { copyEligible: false, classification: "benchmark", reason: "benchmark" };
  }
  if (!SUPPORTED_SOURCES.has(session.source)) {
    return {
      copyEligible: false,
      classification: session.source ?? "unsupported",
      reason: `source:${session.source ?? "unknown"}`,
    };
  }
  return {
    copyEligible: true,
    classification: session.source === "workspace" ? "workspace" : "chat",
    reason: null,
  };
}

function sessionOrigin(session) {
  const source = session.source === "workflow" ? "automation" : (session.source ?? "user");
  if (source === "automation" && !(session.automationId ?? session.workflowId)) {
    return "condition-check";
  }
  return source;
}

export function isSidebarCandidate(session, indexed) {
  if (!indexed) return false;
  if ((session.backendOrigin ?? "copilot") !== "copilot") return false;
  if (session.contentAuthority === "remote") return false;
  if (session.benchmark !== undefined || session.kind === "benchmark") return false;
  const origin = sessionOrigin(session);
  return !["teams", "teams-archived", "condition-check", "workspace"].includes(origin);
}

function readSessionFile(filePath, deviceId, sessionId) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_SESSION_BYTES) throw new Error("session exceeds 50 MiB");
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON or Files On-Demand read: ${errorMessage(error)}`);
  }
  const validated = validateStoredSession(parsed, { deviceId, sessionId });
  if (!validated.success) throw new Error(validated.error);
  return { raw, session: validated.session, sha256: sha256(raw), stat };
}

function valuesEqual(left, right) {
  return isDeepStrictEqual(left, right);
}

export function mergeCanonicalSession(blobSession, indexRow) {
  if (!indexRow) {
    return {
      session: structuredClone(blobSession),
      metadataSource: "blob",
      metadataDrift: false,
      metadataDriftFields: [],
    };
  }
  const session = structuredClone(blobSession);
  const metadataDriftFields = [];
  for (const field of INDEX_FIELDS) {
    const blobValue = blobSession[field];
    const indexOwnsValue = Object.hasOwn(indexRow, field) && indexRow[field] !== undefined;
    const indexValue = indexOwnsValue ? indexRow[field] : undefined;
    if (!valuesEqual(blobValue, indexValue)) metadataDriftFields.push(field);
    if (indexOwnsValue) session[field] = structuredClone(indexValue);
    else delete session[field];
  }
  return {
    session,
    metadataSource: "index",
    metadataDrift: metadataDriftFields.length > 0,
    metadataDriftFields,
  };
}

function indexFingerprint(indexPath) {
  if (!fs.existsSync(indexPath)) return { exists: false, sha256: null };
  return { exists: true, sha256: sha256(fs.readFileSync(indexPath)) };
}

function sameFingerprint(a, b) {
  return a.exists === b.exists && a.sha256 === b.sha256;
}

function isIndexConflictFileName(name) {
  return name !== INDEX_NAME && /^sessions-index(?:[ ._(-].*)\.json$/i.test(name);
}

function conflictingIndexFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isIndexConflictFileName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function parsePartitionIndexFile(indexPath, deviceId) {
  const stat = fs.statSync(indexPath);
  const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  if (
    !isObject(parsed) ||
    !Array.isArray(parsed.sessions) ||
    !(
      parsed.activeSessionId === null ||
      parsed.activeSessionId === undefined ||
      typeof parsed.activeSessionId === "string"
    )
  ) {
    throw new Error("index has invalid top-level shape");
  }
  const ids = new Set();
  for (const row of parsed.sessions) {
    const rowError = validateMetadata(row, deviceId);
    if (rowError) throw new Error(rowError);
    if (ids.has(row.id)) throw new Error(`index contains duplicate id ${row.id}`);
    ids.add(row.id);
  }
  if (parsed.activeSessionId && !ids.has(parsed.activeSessionId)) {
    throw new Error("activeSessionId does not reference a row in this index");
  }
  return {
    index: { ...parsed, activeSessionId: parsed.activeSessionId ?? null },
    mtime: stat.mtime.toISOString(),
  };
}

export function readPartitionIndex(
  sessionsRoot,
  deviceId,
  { strict = false, rejectConflicts = strict } = {},
) {
  const dir = partitionDirectory(sessionsRoot, deviceId);
  const indexPath = path.join(dir, INDEX_NAME);
  const fingerprint = indexFingerprint(indexPath);
  const conflicts = conflictingIndexFiles(dir);
  if (conflicts.length > 0 && rejectConflicts) {
    throw new Error(`Conflicting session index files exist: ${conflicts.join(", ")}`);
  }
  if (!fingerprint.exists) {
    return {
      indexPath,
      index: { sessions: [], activeSessionId: null },
      outcome: "absent",
      error: null,
      fingerprint,
      conflicts,
      mtime: null,
    };
  }
  try {
    const parsed = parsePartitionIndexFile(indexPath, deviceId);
    return {
      indexPath,
      index: parsed.index,
      outcome: "ok",
      error: null,
      fingerprint,
      conflicts,
      mtime: parsed.mtime,
    };
  } catch (error) {
    if (strict) throw new Error(`Refusing to mutate malformed index: ${errorMessage(error)}`);
    return {
      indexPath,
      index: null,
      outcome: "invalid",
      error: errorMessage(error),
      fingerprint,
      conflicts,
      mtime: null,
    };
  }
}

export function inspectPartition(sessionsRoot, deviceId) {
  const dir = partitionDirectory(sessionsRoot, deviceId);
  const indexResult = readPartitionIndex(sessionsRoot, deviceId);
  const indexedById = new Map(indexResult.index?.sessions.map((row) => [row.id, row]) ?? []);
  const sessions = [];
  const failures = [];
  const partitionMetadataFiles = new Set([
    INDEX_NAME,
    "skip-list.json",
    "scout-session-restore-manifest.json",
  ]);
  if (!fs.existsSync(dir)) return { deviceId, dir, index: indexResult, sessions, failures };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".json") ||
      partitionMetadataFiles.has(entry.name) ||
      isIndexConflictFileName(entry.name)
    ) {
      continue;
    }
    if (!UUID_RE.test(entry.name.slice(0, -5))) {
      failures.push({
        deviceId,
        sessionId: null,
        filePath: path.join(dir, entry.name),
        error: "JSON filename is not a session UUID",
      });
      continue;
    }
    const sessionId = entry.name.slice(0, -5);
    const filePath = path.join(dir, entry.name);
    try {
      const loaded = readSessionFile(filePath, deviceId, sessionId);
      const indexRow = indexedById.get(sessionId) ?? null;
      const canonical = mergeCanonicalSession(loaded.session, indexRow);
      const classification = classifySession(canonical.session);
      sessions.push({
        deviceId,
        sessionId,
        filePath,
        ...loaded,
        blobSession: loaded.session,
        session: canonical.session,
        indexed: indexRow !== null,
        indexRow,
        metadataSource: canonical.metadataSource,
        metadataDrift: canonical.metadataDrift,
        metadataDriftFields: canonical.metadataDriftFields,
        metadataSha256: sha256(JSON.stringify(metadataFromSession(canonical.session))),
        ...classification,
      });
    } catch (error) {
      failures.push({ deviceId, sessionId, filePath, error: errorMessage(error) });
    }
  }
  for (const [sessionId] of indexedById) {
    if (!sessions.some((item) => item.sessionId === sessionId)) {
      failures.push({
        deviceId,
        sessionId,
        filePath: path.join(dir, `${sessionId}.json`),
        error: "index row has no readable session blob",
      });
    }
  }
  sessions.sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));
  return { deviceId, dir, index: indexResult, sessions, failures };
}

export function listDevices(sessionsRoot, currentDeviceId = null) {
  const deviceIds = listDevicePartitionIds(sessionsRoot);
  const invalidDeviceFolders = [];
  const devicesRoot = path.join(sessionsRoot, "devices");
  if (fs.existsSync(devicesRoot)) {
    for (const entry of fs.readdirSync(devicesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!DEVICE_ID_RE.test(entry.name)) invalidDeviceFolders.push(entry.name);
    }
  }
  const partitions = [null, ...deviceIds];
  const valid = partitions.map((deviceId) => {
    const inspected = inspectPartition(sessionsRoot, deviceId);
    const newest = inspected.sessions[0]?.session.updatedAt ?? null;
    const indexedSessions = inspected.sessions.filter((item) => item.indexed).length;
    const metadataDriftSessions = inspected.sessions.filter((item) => item.metadataDrift).length;
    return {
      device: deviceId ?? "shared",
      label: partitionLabel(deviceId, currentDeviceId),
      current: deviceId !== null && deviceId === currentDeviceId,
      validSessions: inspected.sessions.length,
      indexedSessions,
      orphanSessions: inspected.sessions.length - indexedSessions,
      metadataDriftSessions,
      invalidEntries: inspected.failures.length,
      newestSessionAt: newest,
      indexStatus: inspected.index.outcome,
      indexUpdatedAt: inspected.index.mtime,
      indexConflicts: inspected.index.conflicts,
    };
  });
  return [
    ...valid,
    ...invalidDeviceFolders.sort().map((device) => ({
      device,
      label: "invalid device folder",
      current: false,
      validSessions: 0,
      indexedSessions: 0,
      orphanSessions: 0,
      metadataDriftSessions: 0,
      invalidEntries: 1,
      newestSessionAt: null,
      indexStatus: "invalid",
      indexUpdatedAt: null,
      indexConflicts: [],
    })),
  ];
}

function listDevicePartitionIds(sessionsRoot) {
  const devicesRoot = path.join(sessionsRoot, "devices");
  if (!fs.existsSync(devicesRoot)) return [];
  return fs
    .readdirSync(devicesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && DEVICE_ID_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function listPartitionSessions(
  sessionsRoot,
  deviceId,
  { sort = "updated", filter = null, sidebarOnly = false } = {},
) {
  const inspected = inspectPartition(sessionsRoot, deviceId);
  const allSessions = inspected.sessions.map(listItem);
  const indexedSessions = allSessions.filter((item) => item.indexed).length;
  const summary = {
    validBlobs: allSessions.length,
    indexedBlobs: indexedSessions,
    orphanBlobs: allSessions.length - indexedSessions,
    sidebarCandidates: allSessions.filter((item) => item.sidebarCandidate).length,
    metadataDrift: allSessions.filter((item) => item.metadataDrift).length,
  };
  let sessions = sidebarOnly ? allSessions.filter((item) => item.sidebarCandidate) : allSessions;
  if (filter) {
    const needle = filter.toLowerCase();
    sessions = sessions.filter(
      (item) =>
        item.id.toLowerCase().includes(needle) ||
        item.name.toLowerCase().includes(needle) ||
        item.classification.toLowerCase().includes(needle),
    );
  }
  const field = sort === "name" ? "name" : sort === "created" ? "createdAt" : "updatedAt";
  sessions.sort((a, b) =>
    field === "name" ? a.name.localeCompare(b.name) : b[field].localeCompare(a[field]),
  );
  return {
    device: deviceId ?? "shared",
    indexStatus: inspected.index.outcome,
    indexError: inspected.index.error,
    indexConflicts: inspected.index.conflicts,
    summary,
    sidebarOnly,
    sessions,
    invalidEntries: inspected.failures,
  };
}

function nestedTextIncludes(value, query, seen = new Set()) {
  if (typeof value === "string") return value.toLowerCase().includes(query);
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => nestedTextIncludes(item, query, seen));
  }
  return Object.values(value).some((item) => nestedTextIncludes(item, query, seen));
}

function transcriptIncludes(session, query) {
  if (nestedTextIncludes(session.contextSummary, query)) return true;
  return session.messages.some((message) => {
    if (nestedTextIncludes(message.content, query)) return true;
    if (nestedTextIncludes(message.reasoning?.text, query)) return true;
    return (
      message.toolCalls?.some((toolCall) =>
        nestedTextIncludes(
          {
            name: toolCall.name,
            description: toolCall.description,
            args: toolCall.args,
            result: toolCall.result,
            error: toolCall.error,
          },
          query,
        ),
      ) ?? false
    );
  });
}

function findResult(item, deviceId, normalizedQuery, titleOnly) {
  const titleMatch = item.session.name.toLowerCase().includes(normalizedQuery);
  const transcriptMatch = !titleOnly && transcriptIncludes(item.session, normalizedQuery);
  if (!titleMatch && !transcriptMatch) return null;
  const matchSources = [
    ...(titleMatch ? ["title"] : []),
    ...(transcriptMatch ? ["transcript"] : []),
  ];
  const listed = listItem(item);
  return {
    device: deviceId ?? "shared",
    ...listed,
    matchSource: matchSources.join(" + "),
    matchSources,
  };
}

function listItem(item) {
  const sidebarCandidate = isSidebarCandidate(item.session, item.indexed);
  return {
    id: item.sessionId,
    name: item.session.name || "(untitled)",
    createdAt: item.session.createdAt,
    updatedAt: item.session.updatedAt,
    messageCount: item.session.messages.length,
    classification: item.classification,
    copyEligible: item.copyEligible,
    exclusionReason: item.reason,
    indexed: item.indexed,
    partitionStatus: item.indexed ? "indexed" : "orphan",
    metadataSource: item.metadataSource,
    metadataDrift: item.metadataDrift,
    metadataDriftFields: item.metadataDriftFields,
    blobName:
      item.metadataDrift && item.blobSession.name !== item.session.name
        ? item.blobSession.name
        : undefined,
    metadataStatus: item.metadataDrift ? "index (differs)" : item.metadataSource,
    sidebarCandidate,
  };
}

export function findSessions(sessionsRoot, query, { sort = "updated", titleOnly = false } = {}) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) throw new Error("Find query must not be empty");
  const matches = [];
  const invalidEntries = [];
  const indexConflicts = [];
  const partitions = [null, ...listDevicePartitionIds(sessionsRoot)];
  for (const deviceId of partitions) {
    const inspected = inspectPartition(sessionsRoot, deviceId);
    matches.push(
      ...inspected.sessions.flatMap((item) => {
        const result = findResult(item, deviceId, normalizedQuery, titleOnly);
        return result ? [result] : [];
      }),
    );
    invalidEntries.push(
      ...inspected.failures.map((entry) => ({
        device: deviceId ?? "shared",
        ...entry,
      })),
    );
    indexConflicts.push(
      ...inspected.index.conflicts.map((file) => ({
        device: deviceId ?? "shared",
        file,
      })),
    );
  }
  const field = sort === "name" ? "name" : sort === "created" ? "createdAt" : "updatedAt";
  matches.sort((a, b) =>
    field === "name"
      ? a.name.localeCompare(b.name) || a.device.localeCompare(b.device)
      : b[field].localeCompare(a[field]) || a.device.localeCompare(b.device),
  );
  return {
    query,
    titleOnly,
    searchedPartitions: partitions.length,
    matches,
    invalidEntries,
    indexConflicts,
  };
}

export function cloneSession(source, { destinationSessionId, destinationDeviceId, copiedAt }) {
  const clone = {
    ...structuredClone(source),
    id: destinationSessionId,
    backendOrigin: "copilot",
    backendId: undefined,
    contentAuthority: "local",
    updatedAt: copiedAt,
    hasUnread: false,
    isActive: false,
    permissionCards: undefined,
    activeSquadId: undefined,
    sdkSessionId: undefined,
    cloudSessionId: undefined,
  };
  if (destinationDeviceId === null) delete clone.deviceId;
  else clone.deviceId = destinationDeviceId;
  return clone;
}

function metadataFromSession(session) {
  const metadata = {};
  for (const field of INDEX_FIELDS) {
    if (session[field] !== undefined) metadata[field] = structuredClone(session[field]);
  }
  return metadata;
}

function fsyncDirectory(dir) {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Some Windows/network filesystems cannot fsync directories.
  }
}

function atomicWrite(filePath, content, { exclusive = false, expectedFingerprint = null } = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (expectedFingerprint && !sameFingerprint(indexFingerprint(filePath), expectedFingerprint)) {
      throw new Error(`Concurrent change detected for ${filePath}; close Scout and rerun`);
    }
    if (exclusive && fs.existsSync(filePath)) {
      throw new Error(`Destination already exists: ${filePath}`);
    }
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function withPartitionLock(sessionsRoot, deviceId, callback) {
  const dir = partitionDirectory(sessionsRoot, deviceId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, ".scout-sessions.lock");
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    throw new Error(`Another Scout session tool operation is active: ${errorMessage(error)}`);
  }
  try {
    return callback();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  }
}

function withToolLock(sessionsRoot, callback) {
  const dir = path.join(sessionsRoot, ".scout-sessions");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, ".operation.lock");
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    throw new Error(`Another Scout session tool operation is active: ${errorMessage(error)}`);
  }
  try {
    return callback();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  }
}

function manifestPath(sessionsRoot, override) {
  return override ?? path.join(sessionsRoot, ".scout-sessions", SESSION_TOOL_MANIFEST_NAME);
}

function validManifestEntry(entry) {
  if (!isObject(entry) || !["planned", "completed"].includes(entry.state)) return false;
  if (!isIsoDate(entry.operationAt) || !/^[a-f0-9]{64}$/.test(entry.sourceSha256 ?? ""))
    return false;
  if (entry.kind === "copy") {
    return (
      typeof entry.sourcePartition === "string" &&
      UUID_RE.test(entry.sourceSessionId ?? "") &&
      (entry.sourceMetadataSha256 === undefined ||
        /^[a-f0-9]{64}$/.test(entry.sourceMetadataSha256)) &&
      typeof entry.destinationPartition === "string" &&
      UUID_RE.test(entry.destinationSessionId ?? "")
    );
  }
  if (entry.kind === "delete") {
    return (
      typeof entry.partition === "string" &&
      UUID_RE.test(entry.sessionId ?? "") &&
      typeof entry.backupDirectory === "string" &&
      !path.isAbsolute(entry.backupDirectory) &&
      entry.backupDirectory.startsWith(".scout-sessions/backups/") &&
      !entry.backupDirectory.split(/[\\/]/).includes("..")
    );
  }
  return false;
}

export function readManifest(filePath) {
  if (!fs.existsSync(filePath)) return { version: 2, entries: [] };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Session tool manifest is unreadable: ${errorMessage(error)}`);
  }
  if (
    !isObject(parsed) ||
    parsed.version !== 2 ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.some((entry) => !validManifestEntry(entry))
  ) {
    throw new Error("Session tool manifest failed validation");
  }
  return parsed;
}

function writeManifest(filePath, manifest) {
  atomicWrite(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function indexConflictArchivePath(sessionsRoot, deviceId, fileName, content) {
  const partition = deviceId === null ? "shared" : `device-${deviceId}`;
  return path.join(
    sessionsRoot,
    ".scout-sessions",
    "index-conflicts",
    partition,
    `${fileName}.${sha256(content).slice(0, 12)}.backup`,
  );
}

function writeIndexConflictBackup(sessionsRoot, deviceId, fileName, content) {
  const backupPath = indexConflictArchivePath(sessionsRoot, deviceId, fileName, content);
  if (fs.existsSync(backupPath)) {
    if (!fs.readFileSync(backupPath).equals(content)) {
      throw new Error(`Index conflict backup collision: ${backupPath}`);
    }
    return backupPath;
  }
  atomicWrite(backupPath, content, { exclusive: true });
  return backupPath;
}

function mergeConflictIndexRows(canonicalIndex, conflictIndexes) {
  const sessions = canonicalIndex.sessions.map((row) => structuredClone(row));
  const positions = new Map(sessions.map((row, index) => [row.id, index]));
  for (const conflict of conflictIndexes) {
    for (const row of conflict.index.sessions) {
      const position = positions.get(row.id);
      if (position === undefined) {
        positions.set(row.id, sessions.length);
        sessions.push(structuredClone(row));
        continue;
      }
      const existing = sessions[position];
      if (isDeepStrictEqual(existing, row)) continue;
      const updatedComparison = row.updatedAt.localeCompare(existing.updatedAt);
      if (updatedComparison === 0) {
        throw new Error(
          `Conflicting index copies disagree on session ${row.id} at ${row.updatedAt}`,
        );
      }
      if (updatedComparison > 0) sessions[position] = structuredClone(row);
    }
  }
  return { ...canonicalIndex, sessions };
}

function reconcileIndexConflicts(sessionsRoot, deviceId) {
  const canonical = readPartitionIndex(sessionsRoot, deviceId, {
    strict: true,
    rejectConflicts: false,
  });
  if (canonical.conflicts.length === 0) return canonical;
  if (canonical.outcome !== "ok") {
    throw new Error("Cannot reconcile index conflicts without a valid sessions-index.json");
  }

  const dir = partitionDirectory(sessionsRoot, deviceId);
  const conflicts = canonical.conflicts.map((fileName) => {
    const filePath = path.join(dir, fileName);
    const content = fs.readFileSync(filePath);
    let parsed;
    try {
      parsed = parsePartitionIndexFile(filePath, deviceId);
    } catch (error) {
      throw new Error(
        `Refusing to reconcile malformed index conflict ${fileName}: ${errorMessage(error)}`,
      );
    }
    return {
      fileName,
      filePath,
      content,
      fingerprint: { exists: true, sha256: sha256(content) },
      index: parsed.index,
    };
  });
  const mergedIndex = mergeConflictIndexRows(canonical.index, conflicts);
  const canonicalContent = fs.readFileSync(canonical.indexPath);
  if (sha256(canonicalContent) !== canonical.fingerprint.sha256) {
    throw new Error("Canonical index changed during conflict reconciliation");
  }
  for (const conflict of conflicts) {
    if (!sameFingerprint(indexFingerprint(conflict.filePath), conflict.fingerprint)) {
      throw new Error(`Index conflict changed during reconciliation: ${conflict.fileName}`);
    }
  }
  writeIndexConflictBackup(sessionsRoot, deviceId, INDEX_NAME, canonicalContent);
  for (const conflict of conflicts) {
    writeIndexConflictBackup(sessionsRoot, deviceId, conflict.fileName, conflict.content);
  }

  atomicWrite(canonical.indexPath, `${JSON.stringify(mergedIndex, null, 2)}\n`, {
    expectedFingerprint: canonical.fingerprint,
  });
  for (const conflict of conflicts) {
    if (!sameFingerprint(indexFingerprint(conflict.filePath), conflict.fingerprint)) {
      throw new Error(`Index conflict changed during reconciliation: ${conflict.fileName}`);
    }
    fs.unlinkSync(conflict.filePath);
  }
  fsyncDirectory(dir);
  return readPartitionIndex(sessionsRoot, deviceId, { strict: true });
}

function copyKey(sourceDeviceId, sourceSessionId, destinationDeviceId) {
  return `${partitionKey(sourceDeviceId)}:${sourceSessionId}->${partitionKey(destinationDeviceId)}`;
}

function copyResult(item, destinationSessionId) {
  return {
    sourceSessionId: item.sessionId,
    sourceName: item.session.name,
    destinationSessionId,
  };
}

export function resolveSessionRefs(inspected, sessionRefs) {
  const resolved = new Set();
  for (const reference of sessionRefs) {
    if (UUID_RE.test(reference)) {
      const match = inspected.sessions.find(
        (item) => item.sessionId.toLowerCase() === reference.toLowerCase(),
      );
      resolved.add(match?.sessionId ?? reference.toLowerCase());
      continue;
    }
    const normalized = reference.toLowerCase();
    const matches = inspected.sessions.filter((item) => {
      const sessionId = item.sessionId.toLowerCase();
      return (normalized.includes("-") ? sessionId : sessionId.replaceAll("-", "")).startsWith(
        normalized,
      );
    });
    if (matches.length === 0) {
      throw new Error(
        `No validated session matches "${reference}" in ${partitionKey(inspected.deviceId)}; list sessions or use --verbose`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous session prefix "${reference}" matches ${matches.length} sessions in ${partitionKey(inspected.deviceId)}; use more characters or --verbose`,
      );
    }
    resolved.add(matches[0].sessionId);
  }
  return resolved;
}

function selectItems(inspected, sessionRefs, all, { requireEligible = true } = {}) {
  const sessionIds = resolveSessionRefs(inspected, sessionRefs);
  if (!all && sessionIds.size === 0) throw new Error("Use --all or at least one --session-id");
  const selected = inspected.sessions.filter(
    (item) => (all || sessionIds.has(item.sessionId)) && (!requireEligible || item.copyEligible),
  );
  if (selected.length === 0) throw new Error("No validated sessions matched the selection");
  const missing = [...sessionIds].filter((id) => !selected.some((item) => item.sessionId === id));
  if (missing.length > 0)
    throw new Error(`Selected sessions are missing or ineligible: ${missing.join(", ")}`);
  return selected;
}

export function applyCopy({
  sessionsRoot,
  sourceDeviceId,
  destinationDeviceId,
  sessionIds = new Set(),
  all = false,
  apply = false,
  manifestFile,
  now = () => new Date().toISOString(),
  mintId = randomUUID,
}) {
  if (sourceDeviceId === destinationDeviceId) throw new Error("Source and destination must differ");
  const source = inspectPartition(sessionsRoot, sourceDeviceId);
  const selected = selectItems(source, sessionIds, all);
  const plan = selected.map((item) => ({
    sourceSessionId: item.sessionId,
    sourceName: item.session.name,
    destination: partitionKey(destinationDeviceId),
  }));
  if (!apply) return { planned: plan, copied: [], skipped: [], manifestPath: null };
  readPartitionIndex(sessionsRoot, sourceDeviceId, { strict: true, rejectConflicts: false });
  const filePath = manifestPath(sessionsRoot, manifestFile);
  return withToolLock(sessionsRoot, () =>
    withPartitionLock(sessionsRoot, destinationDeviceId, () => {
      if (!sameFingerprint(indexFingerprint(source.index.indexPath), source.index.fingerprint)) {
        throw new Error("Source partition index changed during copy; close Scout and rerun");
      }
      reconcileIndexConflicts(sessionsRoot, destinationDeviceId);
      const manifest = readManifest(filePath);
      const entries = new Map(
        manifest.entries
          .filter((entry) => entry.kind === "copy")
          .map((entry) => [
            `${entry.sourcePartition}:${entry.sourceSessionId}->${entry.destinationPartition}`,
            entry,
          ]),
      );
      const copied = [];
      const skipped = [];
      for (const item of selected) {
        const key = copyKey(sourceDeviceId, item.sessionId, destinationDeviceId);
        let entry = entries.get(key);
        if (entry && entry.sourceSha256 !== item.sha256) {
          throw new Error(`Source session changed since its previous copy: ${item.sessionId}`);
        }
        if (entry?.sourceMetadataSha256 && entry.sourceMetadataSha256 !== item.metadataSha256) {
          throw new Error(`Source metadata changed since its previous copy: ${item.sessionId}`);
        }
        if (!entry) {
          const destinationDir = partitionDirectory(sessionsRoot, destinationDeviceId);
          let destinationSessionId = mintId();
          while (
            !UUID_RE.test(destinationSessionId) ||
            fs.existsSync(path.join(destinationDir, `${destinationSessionId}.json`)) ||
            manifest.entries.some(
              (candidate) =>
                candidate.kind === "copy" &&
                candidate.destinationSessionId === destinationSessionId &&
                candidate.destinationPartition === partitionKey(destinationDeviceId),
            )
          ) {
            destinationSessionId = mintId();
          }
          entry = {
            kind: "copy",
            sourcePartition: partitionKey(sourceDeviceId),
            sourceSessionId: item.sessionId,
            sourceSha256: item.sha256,
            sourceMetadataSha256: item.metadataSha256,
            destinationPartition: partitionKey(destinationDeviceId),
            destinationSessionId,
            operationAt: now(),
            state: "planned",
          };
          manifest.entries.push(entry);
          entries.set(key, entry);
          writeManifest(filePath, manifest);
        }
        const destinationDir = partitionDirectory(sessionsRoot, destinationDeviceId);
        const destinationPath = path.join(destinationDir, `${entry.destinationSessionId}.json`);
        const clone = cloneSession(item.session, {
          destinationSessionId: entry.destinationSessionId,
          destinationDeviceId,
          copiedAt: entry.operationAt,
        });
        if (!fs.existsSync(destinationPath)) {
          atomicWrite(destinationPath, `${JSON.stringify(clone, null, 2)}\n`, { exclusive: true });
        } else {
          const existing = readSessionFile(
            destinationPath,
            destinationDeviceId,
            entry.destinationSessionId,
          );
          if (existing.session.createdAt !== clone.createdAt) {
            throw new Error(`Destination collision for ${entry.destinationSessionId}`);
          }
          const expected = JSON.parse(JSON.stringify(clone));
          if (JSON.stringify(existing.session) !== JSON.stringify(expected)) {
            throw new Error(`Destination content differs for ${entry.destinationSessionId}`);
          }
        }
        const indexResult = readPartitionIndex(sessionsRoot, destinationDeviceId, { strict: true });
        const existingRow = indexResult.index.sessions.find(
          (row) => row.id === entry.destinationSessionId,
        );
        if (
          existingRow &&
          (existingRow.createdAt !== clone.createdAt || existingRow.name !== clone.name)
        ) {
          throw new Error(`Destination index collision for ${entry.destinationSessionId}`);
        }
        if (!existingRow) {
          const nextIndex = {
            ...indexResult.index,
            sessions: [metadataFromSession(clone), ...indexResult.index.sessions],
          };
          atomicWrite(indexResult.indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`, {
            expectedFingerprint: indexResult.fingerprint,
          });
        }
        if (entry.state === "completed") skipped.push(copyResult(item, entry.destinationSessionId));
        else copied.push(copyResult(item, entry.destinationSessionId));
        entry.state = "completed";
        writeManifest(filePath, manifest);
      }
      return { planned: plan, copied, skipped, manifestPath: filePath };
    }),
  );
}

function backupFile(sourcePath, backupPath) {
  const content = fs.readFileSync(sourcePath);
  atomicWrite(backupPath, content, { exclusive: true });
}

export function applyDelete({
  sessionsRoot,
  deviceId,
  sessionIds = new Set(),
  apply = false,
  yes = false,
  manifestFile,
  now = () => new Date().toISOString(),
}) {
  if (sessionIds.size === 0) throw new Error("Delete requires at least one --session-id");
  const inspected = inspectPartition(sessionsRoot, deviceId);
  const resolvedSessionIds = resolveSessionRefs(inspected, sessionIds);
  const selected = inspected.sessions.filter((item) => resolvedSessionIds.has(item.sessionId));
  const unavailableIds = [...resolvedSessionIds].filter(
    (id) => !selected.some((item) => item.sessionId === id),
  );
  const plan = selected.map((item) => ({ sessionId: item.sessionId, name: item.session.name }));
  if (!apply) {
    if (unavailableIds.length > 0) {
      throw new Error(`Selected sessions are missing or invalid: ${unavailableIds.join(", ")}`);
    }
    return { planned: plan, deleted: [], manifestPath: null };
  }
  if (!yes) throw new Error("Delete requires both --apply and --yes");
  const filePath = manifestPath(sessionsRoot, manifestFile);
  return withToolLock(sessionsRoot, () =>
    withPartitionLock(sessionsRoot, deviceId, () => {
      reconcileIndexConflicts(sessionsRoot, deviceId);
      const manifest = readManifest(filePath);
      const deleted = [];
      for (const sessionId of unavailableIds) {
        const entry = manifest.entries.find(
          (candidate) =>
            candidate.kind === "delete" &&
            candidate.partition === partitionKey(deviceId) &&
            candidate.sessionId === sessionId,
        );
        if (!entry) throw new Error(`Selected session is missing or invalid: ${sessionId}`);
        const indexResult = readPartitionIndex(sessionsRoot, deviceId, { strict: true });
        if (indexResult.index.sessions.some((row) => row.id === sessionId)) {
          throw new Error(`Session content is missing but its index row remains: ${sessionId}`);
        }
        const backupDirectory = path.join(sessionsRoot, entry.backupDirectory);
        const contentBackup = path.join(backupDirectory, `${sessionId}.json.backup`);
        if (!fs.existsSync(contentBackup)) {
          throw new Error(`Delete recovery backup is missing for ${sessionId}`);
        }
        entry.state = "completed";
        deleted.push({ sessionId, name: null, alreadyCompleted: true });
      }
      if (unavailableIds.length > 0) writeManifest(filePath, manifest);
      for (const item of selected) {
        const key = `${partitionKey(deviceId)}:${item.sessionId}`;
        let entry = manifest.entries.find(
          (candidate) =>
            candidate.kind === "delete" && `${candidate.partition}:${candidate.sessionId}` === key,
        );
        if (entry?.state === "completed" && !fs.existsSync(item.filePath)) {
          deleted.push({ ...item, alreadyCompleted: true });
          continue;
        }
        if (!entry) {
          const operationAt = now();
          const backupDirectory = path.posix.join(
            ".scout-sessions",
            "backups",
            `${operationAt.replaceAll(":", "-")}-${item.sessionId}`,
          );
          entry = {
            kind: "delete",
            partition: partitionKey(deviceId),
            sessionId: item.sessionId,
            sourceSha256: item.sha256,
            operationAt,
            backupDirectory,
            state: "planned",
          };
          manifest.entries.push(entry);
          writeManifest(filePath, manifest);
        }
        if (entry.sourceSha256 !== item.sha256) {
          throw new Error(`Session changed since delete was planned: ${item.sessionId}`);
        }
        const backupDirectory = path.join(sessionsRoot, entry.backupDirectory);
        fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
        const contentBackup = path.join(backupDirectory, `${item.sessionId}.json.backup`);
        if (!fs.existsSync(contentBackup)) backupFile(item.filePath, contentBackup);

        const indexResult = readPartitionIndex(sessionsRoot, deviceId, { strict: true });
        const indexBackup = path.join(backupDirectory, `${INDEX_NAME}.backup`);
        if (indexResult.outcome === "ok" && !fs.existsSync(indexBackup)) {
          backupFile(indexResult.indexPath, indexBackup);
        }
        const hadRow = indexResult.index.sessions.some((row) => row.id === item.sessionId);
        let postIndexFingerprint = indexResult.fingerprint;
        if (hadRow) {
          const remaining = indexResult.index.sessions.filter((row) => row.id !== item.sessionId);
          const nextActive =
            indexResult.index.activeSessionId === item.sessionId
              ? ([...remaining].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ??
                null)
              : indexResult.index.activeSessionId;
          const nextIndex = {
            ...indexResult.index,
            sessions: remaining,
            activeSessionId: nextActive,
          };
          atomicWrite(indexResult.indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`, {
            expectedFingerprint: indexResult.fingerprint,
          });
          postIndexFingerprint = indexFingerprint(indexResult.indexPath);
        }
        try {
          if (fs.existsSync(item.filePath)) fs.unlinkSync(item.filePath);
          fsyncDirectory(path.dirname(item.filePath));
        } catch (error) {
          if (
            hadRow &&
            fs.existsSync(indexBackup) &&
            sameFingerprint(indexFingerprint(indexResult.indexPath), postIndexFingerprint)
          ) {
            atomicWrite(indexResult.indexPath, fs.readFileSync(indexBackup, "utf8"), {
              expectedFingerprint: postIndexFingerprint,
            });
          }
          throw new Error(
            `Content delete failed; index rollback attempted: ${errorMessage(error)}`,
          );
        }
        entry.state = "completed";
        writeManifest(filePath, manifest);
        deleted.push({
          sessionId: item.sessionId,
          name: item.session.name,
          alreadyCompleted: false,
        });
      }
      return { planned: plan, deleted, manifestPath: filePath };
    }),
  );
}

function usage() {
  return `Standalone Microsoft Scout session recovery and maintenance v${SCOUT_SESSIONS_VERSION}.

PURPOSE
  Inspect locally synced OneDrive session JSON without launching Scout. This
  dependency-free file lists/searches storage and safely copies or deletes
  selected sessions. It does not call Graph, decrypt Scout's local aggregate
  index, transfer attachment bytes, or migrate Copilot runtime checkpoints.

PREREQUISITES
  1. Quit Scout.
  2. Let OneDrive finish syncing.
  3. Mark OneDrive/Apps/Microsoft Scout as "Always Keep on This Device" and wait
     for Files On-Demand content to download.
  4. After writes, let OneDrive sync again before reopening Scout.

USAGE
  scout-sessions devices [--verbose|--json]
  scout-sessions sessions --device <id|shared|current> [--sidebar-only] [--verbose|--json]
  scout-sessions find <term> [--title-only] [--verbose|--json]
  scout-sessions copy --from <device|device/session> --to <device|shared|current> [--session-id <uuid|prefix> | --all] [--apply]
  scout-sessions delete --device <id|shared|current> --session-id <uuid|prefix> [--apply --yes]

COMMANDS AND EXAMPLES
  # Show shared and all per-device partitions.
  scout-sessions devices

  # List this device, shared legacy storage, or a foreign device partition.
  scout-sessions sessions --device current
  scout-sessions sessions --device shared --sort name
  scout-sessions sessions --device <32-hex-id> --filter planning

  # Search canonical titles and stored conversation content across every partition.
  scout-sessions find insurance
  scout-sessions find --title "quarterly planning" --json
  scout-sessions find "quarterly planning" --title-only

  # Use a find result's DEVICE and SESSION ID to preview, then apply, a copy.
  scout-sessions copy --from <found-device> --to current --session-id <found-uuid>
  scout-sessions copy --from <found-device> --to current --session-id <found-uuid> --apply
  scout-sessions copy --from bdec03f9/fcca233d --to current

  # Copy every eligible session, including to/from shared storage.
  scout-sessions copy --from <old-device> --to current --all --apply
  scout-sessions copy --from shared --to <device-id> --all --apply
  scout-sessions copy --from <device-id> --to shared --all --apply

  # Preview deletion; applying requires both mutation flags.
  scout-sessions delete --device current --session-id <uuid-prefix>
  scout-sessions delete --device current --session-id <uuid-prefix> --apply --yes

STORAGE ARCHITECTURE
  <OneDrive>/Apps/Microsoft Scout/sessions/
    sessions-index.json + <uuid>.json
    devices/<device-id>/sessions-index.json + <uuid>.json

  The flat files are shared/legacy storage; each devices/<id> directory is one
  machine's partition. Content blobs own messages. sessions-index.json owns
  canonical metadata (title, timestamps, classification, routing, and more), so
  indexed output overlays that metadata. "indexed" means blob + partition row;
  "orphan" means a valid blob without a row. Neither state proves that Scout's
  encrypted local aggregate index currently shows the session.

  "current" is SHA-256(IOPlatformUUID) on macOS or SHA-256(MachineGuid) on
  Windows, truncated to 32 hex characters. Use --destination-device on Linux or
  when current-device detection is unavailable.

SAFETY AND LIMITATIONS
  Listing and find are read-only. copy/delete are dry runs without --apply;
  delete --apply also requires --yes. Mutations use locks, atomic mode-0600
  writes, index fingerprint compare-and-swap, resumable manifests, and delete
  backups under .scout-sessions/. Repeated completed copies are idempotently
  skipped. Mutations refuse changed sources and concurrent index changes. Valid
  OneDrive index conflict copies are merged by session updatedAt and archived
  under .scout-sessions/index-conflicts/; malformed copies or equal-timestamp
  disagreements fail closed. Read-only commands report conflict copies and
  continue using sessions-index.json.

  Copy mints a fresh UUID, preserves the stored transcript, and clears
  machine-specific backend/runtime/ephemeral state. The clone starts a fresh
  runtime when opened. Attachment names may survive, but original files usually
  do not live in session JSON. Files On-Demand placeholders must be downloaded.
  Benchmark, Teams, heartbeat, automation, gateway, and remote-authoritative
  sessions are not copyable.

  --sidebar-only is a partition-local approximation based on canonical index
  metadata. This file cannot read Scout's encrypted local aggregate index,
  pending queue, skip cache, pinned order, current search, or active UI filter.
  Find reports title/transcript match type but never prints matching snippets.

HUMAN OUTPUT
  Read-only tables are compact by default. Their 8-character session/device IDs
  can be reused when they uniquely match an existing partition or validated
  session. Ambiguous prefixes fail closed; add characters or use --verbose for
  full IDs. Exact full --to IDs may create a partition; --destination-device
  remains an exact 32-character current-device override. --json preserves
  unchanged machine-readable values. copy accepts a compact find LOCATION as
  --from <device/session>; explicit --session-id values add to that selection.

GLOBAL OPTIONS
  --sessions-root <path>       Scout sessions folder, app folder, or OneDrive root.
  --destination-device <id>    Exact 32-hex current-device override (required on Linux).
  --json                       Emit machine-readable JSON.
  --verbose                    Show full read-only operational tables and IDs.
  --help                       Show this help.

LISTING OPTIONS
  --sort <updated|created|name>
  --filter <text>
  --title <text>                Alternative way to provide the find query.
  --title-only                  Restrict find to canonical session titles.
  --sidebar-only                Show partition-local sidebar candidates only.

MUTATION OPTIONS
  --from <device[/session]>    Copy source partition, optionally with one session.
  --to <device>                Destination partition only; slash form is not allowed.
  --session-id <uuid|prefix>   Unique 8+ hex prefix or full UUID; repeat/comma-separate.
  --all                        Copy every eligible session in the source partition.
  --apply                      Perform writes; otherwise print a dry run.
  --yes                        Required with delete --apply.
  --manifest <path>            Override the operation manifest.
`;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function optionValue(argv, index, name) {
  const current = argv[index];
  const equals = current.indexOf("=");
  if (equals !== -1) return { value: current.slice(equals + 1), consumed: 0 };
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return { value, consumed: 1 };
}

function addSessionRefs(target, value) {
  for (const id of value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    if (!UUID_RE.test(id) && !SESSION_PREFIX_RE.test(id)) {
      throw new Error(
        `Invalid session reference: ${id}; use a full UUID or at least 8 hexadecimal characters`,
      );
    }
    target.add(id);
  }
}

export function parseArgs(argv) {
  const verbs = new Set(["devices", "sessions", "find", "copy", "delete"]);
  const options = {
    verb: argv[0] && !argv[0].startsWith("-") ? argv[0] : null,
    sessionsRoot: null,
    destinationDeviceId: null,
    device: null,
    from: null,
    to: null,
    sessionIds: new Set(),
    all: false,
    apply: false,
    yes: false,
    json: false,
    verbose: false,
    sidebarOnly: false,
    sort: "updated",
    filter: null,
    query: null,
    titleOnly: false,
    manifestPath: null,
    help: false,
  };
  let fromOccurrences = 0;
  let embeddedFromSession = false;
  if (options.verb && !verbs.has(options.verb)) throw new Error(`Unknown verb: ${options.verb}`);
  let start = options.verb ? 1 : 0;
  if (options.verb === "find" && argv[start] && !argv[start].startsWith("--")) {
    options.query = argv[start];
    start++;
  }
  for (let i = start; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") options.all = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--title-only") options.titleOnly = true;
    else if (arg === "--sidebar-only") options.sidebarOnly = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (
      [
        "--sessions-root",
        "--destination-device",
        "--device",
        "--from",
        "--to",
        "--sort",
        "--filter",
        "--title",
        "--manifest",
      ].some((name) => arg === name || arg.startsWith(`${name}=`))
    ) {
      const name = arg.split("=")[0];
      const { value, consumed } = optionValue(argv, i, name);
      const property = {
        "--sessions-root": "sessionsRoot",
        "--destination-device": "destinationDeviceId",
        "--device": "device",
        "--from": "from",
        "--to": "to",
        "--sort": "sort",
        "--filter": "filter",
        "--title": "query",
        "--manifest": "manifestPath",
      }[name];
      if (name === "--from" && ++fromOccurrences > 1) {
        throw new Error(
          "Specify --from once; use --from <device/session> plus repeatable --session-id for additional sessions",
        );
      }
      options[property] =
        name === "--sessions-root" || name === "--manifest"
          ? path.resolve(expandHome(value))
          : value;
      i += consumed;
    } else if (arg === "--session-id" || arg.startsWith("--session-id=")) {
      const { value, consumed } = optionValue(argv, i, "--session-id");
      addSessionRefs(options.sessionIds, value);
      i += consumed;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!["updated", "created", "name"].includes(options.sort)) {
    throw new Error("--sort must be updated, created, or name");
  }
  if (options.sidebarOnly && options.verb !== "sessions") {
    throw new Error("--sidebar-only is valid only with the sessions verb");
  }
  if (options.titleOnly && options.verb !== "find") {
    throw new Error("--title-only is valid only with the find verb");
  }
  if (options.from?.includes("/")) {
    if (options.verb !== "copy") {
      throw new Error("--from <device/session> LOCATION shorthand is valid only with copy");
    }
    const parts = options.from.split("/");
    if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
      throw new Error(
        "Invalid --from LOCATION; use exactly <device-ref>/<session-ref>, for example bdec03f9/fcca233d",
      );
    }
    if (parts[1].includes(",")) {
      throw new Error(
        "A --from LOCATION selects one session; add other sessions with repeatable or comma-separated --session-id",
      );
    }
    options.from = parts[0];
    addSessionRefs(options.sessionIds, parts[1]);
    embeddedFromSession = true;
  }
  if (options.to?.includes("/")) {
    throw new Error(
      "--to accepts a destination partition only; use LOCATION shorthand with --from <device/session>",
    );
  }
  if (embeddedFromSession && options.all) {
    throw new Error("--all cannot be combined with a session embedded in --from");
  }
  for (const [name, value] of [
    ["--device", options.device],
    ["--from", options.from],
    ["--to", options.to],
  ]) {
    if (
      value !== null &&
      value !== "shared" &&
      value !== "current" &&
      !DEVICE_ID_RE.test(value.toLowerCase()) &&
      !DEVICE_PREFIX_RE.test(value)
    ) {
      throw new Error(
        `${name} must be shared, current, a full device ID, or at least 8 hexadecimal characters`,
      );
    }
  }
  if (
    options.destinationDeviceId !== null &&
    !DEVICE_ID_RE.test(options.destinationDeviceId.toLowerCase())
  ) {
    throw new Error("--destination-device must be exactly 32 hexadecimal characters");
  }
  if (options.verb === "find" && !options.query?.trim()) {
    throw new Error("find requires a title substring or --title <text>");
  }
  return options;
}

function currentDeviceId(options) {
  if (options.destinationDeviceId) {
    return options.destinationDeviceId.toLowerCase();
  }
  return deriveCurrentDeviceId();
}

function textWidth(value) {
  return [...value].length;
}

function truncateText(value, width) {
  if (textWidth(value) <= width) return value;
  if (width <= 1) return "…".slice(0, width);
  return `${[...value].slice(0, width - 1).join("")}…`;
}

export function formatHumanTimestamp(value) {
  if (typeof value !== "string") return value;
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
  );
  return match ? `${match[1]}${match[2]}` : value;
}

export function formatCompactTimestamp(value) {
  if (value === null || value === undefined) return "-";
  if (typeof value !== "string") return value;
  const match = value.match(
    /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) return value;
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][Number(match[1]) - 1];
  return month ? `${month} ${match[2]} ${match[3]}${match[4]}` : value;
}

export function formatCompactDevice(device, currentDeviceId = null) {
  if (device === "shared" || device === null) return "shared";
  if (device === currentDeviceId) return "current";
  return String(device).slice(0, 8);
}

export function formatCompactLocation(device, sessionId, currentDeviceId = null) {
  return `${formatCompactDevice(device, currentDeviceId)}/${String(sessionId).slice(0, 8)}`;
}

export function formatCompactMatch(matchSource) {
  return matchSource.replaceAll("transcript", "text");
}

export function formatCompactNotes(row) {
  const notes = [];
  if (row.classification !== "chat") notes.push(row.classification);
  if (!row.indexed) notes.push("orphan");
  return notes.join(", ") || "-";
}

export function formatDeviceIssues(row) {
  const issues = [];
  if (row.orphanSessions > 0) {
    issues.push(`${row.orphanSessions} orphan${row.orphanSessions === 1 ? "" : "s"}`);
  }
  if (row.invalidEntries > 0) {
    issues.push(`${row.invalidEntries} invalid`);
  }
  if (row.indexConflicts.length > 0) {
    issues.push(
      `${row.indexConflicts.length} index conflict${row.indexConflicts.length === 1 ? "" : "s"}`,
    );
  }
  if (row.indexStatus === "absent") issues.push("index missing");
  else if (row.indexStatus === "invalid") issues.push("index invalid");
  return issues.join(", ") || "-";
}

export function formatStorageState(_value, row) {
  if (!row.indexed) return "orphan (file only)";
  return row.metadataDrift ? "indexed (index details used)" : "indexed";
}

export function formatTable(rows, columns, { terminalWidth = process.stdout.columns ?? 120 } = {}) {
  const separator = "  ";
  const values = rows.map((row) =>
    columns.map((column) =>
      String(column.format?.(row[column.key], row) ?? row[column.key] ?? "-").replaceAll(
        /\s+/g,
        " ",
      ),
    ),
  );
  const widths = columns.map((column, index) => {
    const natural = Math.max(
      textWidth(column.header),
      ...values.map((row) => textWidth(row[index])),
    );
    return Math.min(natural, column.maxWidth ?? Number.POSITIVE_INFINITY);
  });
  const fixedWidth =
    widths.reduce((sum, width) => sum + width, 0) + separator.length * (columns.length - 1);
  if (fixedWidth > terminalWidth) {
    for (const [index, column] of columns.entries()) {
      if (!column.flex) continue;
      const overflow =
        widths.reduce((sum, width) => sum + width, 0) +
        separator.length * (columns.length - 1) -
        terminalWidth;
      widths[index] = Math.max(
        column.minWidth ?? textWidth(column.header),
        widths[index] - Math.max(0, overflow),
      );
    }
  }
  const render = (row) =>
    row
      .map((value, index) => {
        const truncated = truncateText(value, widths[index]);
        return index === row.length - 1
          ? truncated
          : truncated.padEnd(widths[index] + (truncated.length - textWidth(truncated)), " ");
      })
      .join(separator);
  return [
    render(columns.map((column) => column.header)),
    render(widths.map((width) => "-".repeat(width))),
    ...values.map(render),
  ].join("\n");
}

function printTable(rows, columns) {
  console.log(formatTable(rows, columns));
}

function printIndexConflictWarning(device, conflicts) {
  if (conflicts.length === 0) return;
  console.error(
    `Warning: ignored conflicting session index ${conflicts.length === 1 ? "copy" : "copies"} in ${device}: ${conflicts.join(", ")}. Read-only results use ${INDEX_NAME}; a mutation targeting this partition will reconcile and archive valid copies.`,
  );
}

function displayCurrentDeviceId(options) {
  if (options.destinationDeviceId) return options.destinationDeviceId.toLowerCase();
  try {
    return deriveCurrentDeviceId();
  } catch {
    return null;
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options.verb) {
    console.log(usage());
    return options.help ? 0 : 1;
  }
  const sessionsRoot = resolveSessionsRoot(options.sessionsRoot);
  if (options.verb === "devices") {
    const current = displayCurrentDeviceId(options);
    const result = listDevices(sessionsRoot, current);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (options.verbose)
      printTable(result, [
        { key: "label", header: "LABEL", maxWidth: 28, minWidth: 12, flex: true },
        { key: "device", header: "DEVICE", maxWidth: 32 },
        { key: "validSessions", header: "BLOBS" },
        { key: "indexedSessions", header: "INDEXED" },
        { key: "orphanSessions", header: "ORPHANS" },
        { key: "invalidEntries", header: "INVALID" },
        { key: "newestSessionAt", header: "NEWEST SESSION", format: formatHumanTimestamp },
        { key: "indexStatus", header: "INDEX" },
      ]);
    else
      printTable(result, [
        {
          key: "device",
          header: "DEVICE",
          maxWidth: 12,
          format: (device) => formatCompactDevice(device, current),
        },
        { key: "validSessions", header: "SESSIONS" },
        {
          key: "invalidEntries",
          header: "ISSUES",
          maxWidth: 48,
          minWidth: 12,
          flex: true,
          format: (_value, row) => formatDeviceIssues(row),
        },
        { key: "newestSessionAt", header: "NEWEST", format: formatCompactTimestamp },
      ]);
    if (!options.json) {
      for (const partition of result) {
        printIndexConflictWarning(partition.device, partition.indexConflicts);
      }
    }
    return 0;
  }
  if (options.verb === "find") {
    const result = findSessions(sessionsRoot, options.query, options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      if (options.verbose) {
        printTable(result.matches, [
          { key: "name", header: "NAME", maxWidth: 36, minWidth: 16, flex: true },
          { key: "device", header: "DEVICE", maxWidth: 32 },
          { key: "id", header: "SESSION ID", maxWidth: 36 },
          { key: "updatedAt", header: "UPDATED", format: formatHumanTimestamp },
          { key: "classification", header: "TYPE", maxWidth: 18 },
          { key: "indexed", header: "STORAGE STATE", format: formatStorageState },
          { key: "matchSource", header: "MATCH", maxWidth: 18 },
        ]);
      } else {
        const current = displayCurrentDeviceId(options);
        const columns = [
          { key: "name", header: "NAME", maxWidth: 56, minWidth: 16, flex: true },
          {
            key: "device",
            header: "LOCATION",
            maxWidth: 17,
            format: (device, row) => formatCompactLocation(device, row.id, current),
          },
          { key: "updatedAt", header: "UPDATED", format: formatCompactTimestamp },
          { key: "matchSource", header: "MATCH", maxWidth: 12, format: formatCompactMatch },
        ];
        if (result.matches.some((row) => formatCompactNotes(row) !== "-")) {
          columns.push({
            key: "classification",
            header: "NOTES",
            maxWidth: 24,
            format: (_value, row) => formatCompactNotes(row),
          });
        }
        printTable(result.matches, columns);
      }
      for (const failure of result.invalidEntries) {
        console.error(
          `Invalid in ${failure.device}: ${failure.sessionId ?? path.basename(failure.filePath)}  ${failure.error}`,
        );
      }
      for (const conflict of result.indexConflicts) {
        printIndexConflictWarning(conflict.device, [conflict.file]);
      }
      console.log(
        `Found ${result.matches.length} matching sessions across ${result.searchedPartitions} partitions.`,
      );
    }
    return result.invalidEntries.length > 0 ? 2 : 0;
  }
  const current = [options.device, options.from, options.to].includes("current")
    ? currentDeviceId(options)
    : (options.destinationDeviceId?.toLowerCase() ?? null);
  if (options.verb === "sessions") {
    const deviceId = resolveDeviceRef(options.device, current, sessionsRoot);
    const result = listPartitionSessions(sessionsRoot, deviceId, options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      if (options.verbose) {
        printTable(result.sessions, [
          { key: "name", header: "NAME", maxWidth: 36, minWidth: 16, flex: true },
          { key: "id", header: "SESSION ID", maxWidth: 36 },
          { key: "createdAt", header: "CREATED", format: formatHumanTimestamp },
          { key: "updatedAt", header: "UPDATED", format: formatHumanTimestamp },
          { key: "messageCount", header: "MESSAGES" },
          { key: "classification", header: "TYPE", maxWidth: 18 },
          { key: "indexed", header: "STORAGE STATE", format: formatStorageState },
        ]);
      } else {
        const columns = [
          { key: "name", header: "NAME", maxWidth: 64, minWidth: 16, flex: true },
          { key: "id", header: "SESSION", maxWidth: 8, format: (id) => id.slice(0, 8) },
          { key: "updatedAt", header: "UPDATED", format: formatCompactTimestamp },
        ];
        if (result.sessions.some((row) => formatCompactNotes(row) !== "-")) {
          columns.push({
            key: "classification",
            header: "NOTES",
            maxWidth: 24,
            format: (_value, row) => formatCompactNotes(row),
          });
        }
        printTable(result.sessions, columns);
      }
      for (const failure of result.invalidEntries) {
        console.error(
          `Invalid: ${failure.sessionId ?? path.basename(failure.filePath)}  ${failure.error}`,
        );
      }
      printIndexConflictWarning(result.device, result.indexConflicts);
      if (options.verbose) {
        console.log(
          `Summary: ${result.summary.validBlobs} valid blobs; ${result.summary.indexedBlobs} indexed; ` +
            `${result.summary.orphanBlobs} orphaned; ${result.summary.sidebarCandidates} sidebar candidates; ` +
            `${result.summary.metadataDrift} indexed sessions use index details that differ from their files.`,
        );
      }
      if (options.sidebarOnly) {
        console.error(
          "Note: --sidebar-only is a cloud-partition approximation. It cannot read Scout's encrypted local aggregate index, pending uploads, pinned order, or current UI search/filter; local pending chats may be omitted.",
        );
      }
    }
    return result.invalidEntries.length > 0 ? 2 : 0;
  }
  if (options.verb === "copy") {
    const sourceDeviceId = resolveDeviceRef(options.from, current, sessionsRoot);
    const destinationDeviceId = resolveDeviceRef(options.to, current, sessionsRoot, {
      allowExactMissing: true,
    });
    const result = applyCopy({
      sessionsRoot,
      sourceDeviceId,
      destinationDeviceId,
      sessionIds: options.sessionIds,
      all: options.all,
      apply: options.apply,
      manifestFile: options.manifestPath,
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      printTable(result.planned, [
        { key: "sourceName", header: "NAME", maxWidth: 36, minWidth: 16, flex: true },
        { key: "sourceSessionId", header: "SOURCE SESSION ID", maxWidth: 36 },
        { key: "destination", header: "DESTINATION" },
      ]);
      console.log(
        options.apply
          ? `Copied ${result.copied.length}; skipped ${result.skipped.length}.`
          : "Dry run only; add --apply to copy.",
      );
      if (destinationDeviceId !== current && destinationDeviceId !== null) {
        console.error(
          "Warning: the target is a foreign device; this machine will not run that partition's orphan sweep.",
        );
      }
    }
    return 0;
  }
  const deviceId = resolveDeviceRef(options.device, current, sessionsRoot);
  const result = applyDelete({
    sessionsRoot,
    deviceId,
    sessionIds: options.sessionIds,
    apply: options.apply,
    yes: options.yes,
    manifestFile: options.manifestPath,
  });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    printTable(result.planned, [
      { key: "name", header: "NAME", maxWidth: 36, minWidth: 16, flex: true },
      { key: "sessionId", header: "SESSION ID", maxWidth: 36 },
    ]);
    console.log(
      options.apply
        ? `Deleted ${result.deleted.length}. Backups and the operation manifest are under .scout-sessions/.`
        : "Dry run only; add --apply --yes to delete.",
    );
    console.error(
      "Deleting Scout JSON does not delete a machine-local Copilot runtime checkpoint.",
    );
  }
  return 0;
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Error: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
