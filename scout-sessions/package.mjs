#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const RELEASE_VERSION = "1.0.2";
const ZIP_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name, data) {
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(ZIP_DATE, 12);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes, data]);
}

function centralHeader(name, data, mode, offset) {
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE((3 << 8) | 20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(ZIP_DATE, 14);
  header.writeUInt32LE(crc32(data), 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((mode << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBytes]);
}

export function createStoredZip(entries) {
  const normalized = [...entries]
    .map((entry) => ({
      name: entry.name.replaceAll("\\", "/"),
      data: Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data),
      mode: entry.mode ?? 0o100644,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of normalized) {
    const local = localHeader(entry.name, entry.data);
    localParts.push(local);
    centralParts.push(centralHeader(entry.name, entry.data, entry.mode, offset));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(normalized.length, 8);
  end.writeUInt16LE(normalized.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

export function readStoredZip(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    if (method !== 0) throw new Error("Release ZIP unexpectedly uses compression");
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const data = buffer.subarray(dataStart, dataStart + size);
    if (crc32(data) !== buffer.readUInt32LE(offset + 14)) {
      throw new Error(`CRC mismatch in ${name}`);
    }
    entries.set(name, Buffer.from(data));
    offset = dataStart + size;
  }
  return entries;
}

function crlf(buffer) {
  return Buffer.from(buffer.toString("utf8").replaceAll(/\r?\n/g, "\r\n"));
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function readRequired(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing release input: ${filePath}`);
  return fs.readFileSync(filePath);
}

function releaseEntries(toolRoot, platform, canonicalScript) {
  const bundleRoot = path.join(toolRoot, "bundle");
  const prefix = `scout-sessions-${RELEASE_VERSION}-${platform}`;
  const read = (name) => readRequired(path.join(bundleRoot, name));
  const entries = [
    { name: `${prefix}/README.txt`, data: read("README.txt") },
    { name: `${prefix}/VERSION.txt`, data: read("VERSION.txt") },
    { name: `${prefix}/scout-sessions.mjs`, data: canonicalScript, mode: 0o100755 },
  ];
  if (platform === "macos") {
    entries.push(
      {
        name: `${prefix}/install.sh`,
        data: read("install-macos.sh"),
        mode: 0o100755,
      },
      {
        name: `${prefix}/scout-sessions`,
        data: read("scout-sessions-macos"),
        mode: 0o100755,
      },
    );
  } else {
    entries[0].data = crlf(entries[0].data);
    entries[1].data = crlf(entries[1].data);
    entries.push(
      {
        name: `${prefix}/install.ps1`,
        data: crlf(read("install-windows.ps1")),
      },
      {
        name: `${prefix}/scout-sessions.cmd`,
        data: crlf(read("scout-sessions.cmd")),
      },
    );
  }
  return entries;
}

export function buildScoutSessionsRelease({
  toolRoot = TOOL_ROOT,
  outputDir = path.join(toolRoot, "download"),
} = {}) {
  const version = readRequired(path.join(toolRoot, "bundle", "VERSION.txt"))
    .toString("utf8")
    .trim();
  if (version !== RELEASE_VERSION) {
    throw new Error(`VERSION.txt is ${version}; expected ${RELEASE_VERSION}`);
  }
  const canonicalScript = readRequired(path.join(toolRoot, "scout-sessions.mjs"));
  if (!canonicalScript.toString("utf8").includes(`SCOUT_SESSIONS_VERSION = "${RELEASE_VERSION}"`)) {
    throw new Error("Canonical script version does not match the release");
  }
  const versionedInputs = [
    ["install-macos.sh", `VERSION="${RELEASE_VERSION}"`],
    ["install-windows.ps1", `$Version = "${RELEASE_VERSION}"`],
    ["README.txt", `SCOUT SESSIONS CLI ${RELEASE_VERSION}`],
  ];
  for (const [name, marker] of versionedInputs) {
    const contents = readRequired(path.join(toolRoot, "bundle", name)).toString("utf8");
    if (!contents.includes(marker)) {
      throw new Error(`${name} version does not match the release`);
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const artifacts = [
    {
      name: `scout-sessions-${RELEASE_VERSION}-macos.zip`,
      data: createStoredZip(releaseEntries(toolRoot, "macos", canonicalScript)),
    },
    {
      name: `scout-sessions-${RELEASE_VERSION}-windows.zip`,
      data: createStoredZip(releaseEntries(toolRoot, "windows", canonicalScript)),
    },
    {
      name: `scout-sessions-${RELEASE_VERSION}.mjs`,
      data: canonicalScript,
      mode: 0o755,
    },
  ];
  for (const artifact of artifacts) {
    const target = path.join(outputDir, artifact.name);
    fs.writeFileSync(target, artifact.data, { mode: artifact.mode ?? 0o644 });
    if (artifact.mode) fs.chmodSync(target, artifact.mode);
  }
  const checksums = artifacts
    .map((artifact) => `${sha256(artifact.data)}  ${artifact.name}`)
    .join("\n");
  fs.writeFileSync(path.join(outputDir, "SHA256SUMS"), `${checksums}\n`, { mode: 0o644 });
  return artifacts.map((artifact) => ({
    name: artifact.name,
    path: path.join(outputDir, artifact.name),
    size: artifact.data.length,
    sha256: sha256(artifact.data),
  }));
}

function parseOutputDir(argv) {
  if (argv.length === 0) return undefined;
  if (argv.length === 2 && argv[0] === "--output-dir") return path.resolve(argv[1]);
  throw new Error("Usage: node scout-sessions/package.mjs [--output-dir <path>]");
}

export function main(argv = process.argv.slice(2)) {
  const outputDir = parseOutputDir(argv);
  const artifacts = buildScoutSessionsRelease({ outputDir });
  console.log(`Built Scout Sessions CLI ${RELEASE_VERSION}:`);
  for (const artifact of artifacts) {
    console.log(`${artifact.sha256}  ${artifact.size}  ${artifact.path}`);
  }
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
