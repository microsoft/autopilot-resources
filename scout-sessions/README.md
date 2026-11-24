# Manage Scout Desktop sessions offline

Scout Desktop keeps each user's session content in their OneDrive, under `Apps/Microsoft Scout/sessions`. Scout Sessions is a command-line tool that lists, searches, copies, and deletes those session files in a locally synced OneDrive folder. A common use is bringing chats from an old computer to a new one.

It is a recovery and maintenance tool, not a Scout Desktop feature. It never reads encryption keys, calls Microsoft Graph, or changes the Copilot runtime state stored on the computer. It is a single file with no dependencies.

## Install

You need macOS or Windows, and Node.js 20 or newer available as `node`. No administrator access is required.

Download the zip for your platform from [download](download/) and compare its SHA-256 hash with [SHA256SUMS](download/SHA256SUMS):

- macOS: [scout-sessions-1.0.2-macos.zip](download/scout-sessions-1.0.2-macos.zip)
- Windows: [scout-sessions-1.0.2-windows.zip](download/scout-sessions-1.0.2-windows.zip)
- Script only: [scout-sessions-1.0.2.mjs](download/scout-sessions-1.0.2.mjs), byte-identical to the script in each zip

On macOS, extract the zip, open Terminal in the extracted folder, and run `chmod +x install.sh && ./install.sh`. It installs to `~/.local/bin`; if that folder is not on your PATH, follow the printed instructions. To uninstall, run `./install.sh --uninstall`.

On Windows, extract the zip, open PowerShell in the extracted folder, and run `.\install.ps1`. It installs to your user's local app data folder and prints the location. To also add it to your user PATH, run `.\install.ps1 -AddToPath`. To uninstall, run `.\install.ps1 -Uninstall`, which also removes the PATH entry. The installer does not change PowerShell execution policy.

You can also skip installation and run the script directly: `node scout-sessions.mjs <command>`.

## Before you change anything

**Quit Scout Desktop and wait for OneDrive to finish syncing before any copy or delete.** Afterward, wait for OneDrive to sync again before reopening Scout. The tool's atomic local writes cannot stop OneDrive from creating conflict copies, or a running Scout from later uploading its whole index.

OneDrive Files On-Demand placeholders must be downloaded first. In Finder or File Explorer, right-click `OneDrive/Apps/Microsoft Scout`, select **Always Keep on This Device**, and wait for the folder to finish downloading. The tool reports read failures explicitly.

## How it keeps your data safe

- Listing and searching are read-only.
- `copy` and `delete` only preview what they would do unless you add `--apply`. `delete --apply` also requires `--yes`.
- `copy` never changes the source and gives each copied session a new ID.
- `delete` backs up the session content and index under `.scout-sessions/backups/` before changing anything.
- Changes use atomic, owner-only (mode `0600`) file writes, a lock, and a check that the index has not changed since it was read. If Scout or another writer changes the index during an operation, the tool stops.
- Before changing a partition, the tool merges valid OneDrive index conflict copies (such as `sessions-index-<computer name>.json`) into `sessions-index.json`, using each session's `updatedAt`, and archives the copies under `.scout-sessions/index-conflicts/`. Sessions that appear only in a conflict copy are kept. Malformed copies, or copies that disagree about a session at the same timestamp, stop the operation for manual inspection.
- Malformed or ambiguous indexes can be listed but are never changed.
- The tool never deletes anything recursively.

## Find the sessions folder

On macOS the tool searches `~/Library/CloudStorage/OneDrive*/Apps/Microsoft Scout/sessions`. On Windows it checks the `OneDriveCommercial`, `OneDrive`, and `OneDriveConsumer` locations. If several match, or none is found, pass the sessions folder, the Microsoft Scout app folder, or the OneDrive root:

```bash
scout-sessions devices \
  --sessions-root "$HOME/Library/CloudStorage/OneDrive-Contoso/Apps/Microsoft Scout/sessions"
```

The `current` device name is derived the same way Scout derives it:

- macOS: `IOPlatformUUID` from `/usr/sbin/ioreg`
- Windows: `MachineGuid` from `%SystemRoot%\System32\reg.exe`
- The SHA-256 hash of that value, truncated to 32 lowercase hexadecimal characters

On Linux, or if detection fails, pass `--destination-device <32-hex-device-id>`. Raw machine identifiers are never printed or saved.

## Output

Human-readable tables are compact by default: IDs are shortened to 8-character prefixes and timestamps omit the year and seconds. Any device or session option accepts a prefix that uniquely matches an existing partition or valid session file. An ambiguous prefix is refused, so add characters or use `--verbose` to see full IDs. `--json` prints unabridged, machine-readable values. Copy and delete previews always show full IDs.

## List partitions

```bash
scout-sessions devices
scout-sessions devices --json
```

Each row is `shared` (legacy storage shared by all computers), `current` (this computer), or another computer's 8-character device prefix, with its session count, any issues, and its newest session. `--verbose` adds the full device ID, separate counts of valid, indexed, orphaned, and invalid entries, and the index status. The stored format does not include computer names, so the tool cannot show them.

## Find sessions on any computer

Search session titles and stored conversation content, ignoring case:

```bash
scout-sessions find iphone
scout-sessions find --title "quarterly planning" --json
scout-sessions find pi-hole --title-only
```

Transcript search covers stored user, assistant, and system messages, tool call arguments and results, reasoning text, and the stored context summary. Results never print matching text, only whether the title, the transcript, or both matched. `--title-only` searches titles only.

The compact LOCATION column has the form `current|shared|<device-prefix>/<session-prefix>`. You can pass a LOCATION directly to `copy --from`:

```bash
scout-sessions copy --from bdec03f9/fcca233d --to current
```

## List sessions

```bash
scout-sessions sessions --device current
scout-sessions sessions --device 0d943b3a
scout-sessions sessions --device shared --sort name
scout-sessions sessions --device shared --sidebar-only
scout-sessions sessions --device <32-hex-id> --filter quarterly --json
```

Rows show the title, session prefix, last update, and notes for unusual states. `--verbose` adds the full ID, creation time, message count, classification, whether it can be copied, and whether it is `indexed` or an `orphan` in that partition's OneDrive `sessions-index.json`.

That status does not say whether Scout currently shows the session. Scout's sidebar is built from an encrypted index on the computer, which this tool cannot read. `--sidebar-only` approximates the default sidebar for one partition, but it can miss chats that have not uploaded yet and cannot reproduce pin order, search, or filters.

For indexed sessions, the index is authoritative for the title, timestamps, classification, and other metadata; the session file is authoritative for messages. A renamed session can therefore have an older title inside its file. The tool shows the index title and reports `indexed (index details used)`. This is expected. An orphan has no index row, so its own embedded title is shown.

## Copy sessions

Preview a copy from an old computer to this one, then apply it:

```bash
scout-sessions copy --from <old-device> --to current --session-id <session-id>
scout-sessions copy --from <old-device> --to current --session-id <session-id> --apply
```

Copy every eligible chat, or copy to and from shared storage:

```bash
scout-sessions copy --from <old-device> --to current --all --apply
scout-sessions copy --from shared --to <device-id> --all --apply
scout-sessions copy --from <device-id> --to shared --all --apply
```

`--session-id` can be repeated or comma-separated, and adds to a session given in a LOCATION. Duplicates are copied once. Do not combine a LOCATION with `--all`. `--to` names a partition only.

The copy keeps the full stored transcript and original creation time, updates the last-modified time, and clears information tied to the original computer. Opening it in Scout starts a fresh agent runtime. The destination index is created or extended without disturbing other sessions or settings.

`.scout-sessions/scout-sessions-manifest.json` records each copy. Rerunning an interrupted copy reuses the same new ID, and rerunning a finished copy skips it. If the source changed since a previous copy, the tool refuses rather than create a second copy.

You can copy to another computer's partition, but that computer must sync and open Scout to pick it up.

## Delete sessions

```bash
scout-sessions delete --device <id|shared|current> --session-id <session-id>
scout-sessions delete --device <id|shared|current> --session-id <session-id> --apply --yes
```

Delete validates the session and index, records the operation, backs up the content and index, removes the index row, and then deletes the file. If deleting the file fails, it restores the index unless the index has since changed. Rerunning finishes an interrupted delete. If the active session is deleted, the newest remaining session becomes active.

Deleting the OneDrive file does not delete Copilot runtime state stored on the computer. A running Scout may also recreate or re-upload the session, which is why Scout must be closed.

## What is and is not copied

- Visible transcripts are kept, including system messages, tool calls and results, and attachment names.
- Copilot runtime state stays on the original computer. A copied chat starts a fresh runtime.
- Scout usually stores attachment names, not the attached files themselves.
- Benchmark, Teams, heartbeat, automation, gateway, and remote sessions cannot be copied. They still appear in `sessions` with the reason.
- Backups stay under `.scout-sessions/backups/` for manual rollback and may sync through OneDrive.

## Maintainers

Run the tests from the repository root (Node.js 20 or newer):

```bash
node --test 'scout-sessions/*.test.mjs'
```

Build the release files into `download/`:

```bash
node scout-sessions/package.mjs
```

The build writes the macOS and Windows zips, the script-only `.mjs`, and `SHA256SUMS`. Entry order, timestamps, permissions, and line endings are fixed, so the same source always produces the same hashes. The installer inputs live in [bundle](bundle/).

To release a new version, update the version in `package.mjs`, `scout-sessions.mjs` (header and `SCOUT_SESSIONS_VERSION`), and every file in `bundle/` that names it, plus the links above; the build refuses mismatched versions. Remove the previous version's files from `download/` so the folder holds one complete set.
