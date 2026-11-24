SCOUT SESSIONS CLI 1.0.2
========================

Purpose
-------
Scout Sessions is a dependency-free recovery and maintenance CLI for locally
synced Microsoft Scout session files. It can list devices and sessions, search
titles and transcripts, and safely preview or apply copy/delete operations.
It is an offline support utility, not a Microsoft Scout product feature.

Requirements
------------
- macOS or Windows
- Node.js 20 or newer available as "node"
- A fully synced OneDrive "Apps/Microsoft Scout" folder
- Before use, select "Always Keep on This Device" for that folder and wait for
  OneDrive to finish downloading it.

Install on macOS
----------------
1. Extract the macOS ZIP.
2. In Terminal, enter the extracted folder.
3. Run: chmod +x install.sh && ./install.sh
4. If ~/.local/bin is not already on PATH, follow the printed instructions.

Uninstall: ./install.sh --uninstall

Install on Windows
------------------
1. Extract the Windows ZIP.
2. Open PowerShell in the extracted folder.
3. Run: .\install.ps1
4. Run the installed .cmd from the printed folder, or explicitly update your
   user PATH with: .\install.ps1 -AddToPath

No administrator access is required. The installer does not change PowerShell
execution policy. If local policy blocks scripts, ask your administrator for
the approved way to run this signed-off internal package.

Uninstall: .\install.ps1 -Uninstall
The installer removes its user PATH entry if present.

Before every mutation
---------------------
Quit Scout and wait for OneDrive to finish syncing. After a mutation, wait for
OneDrive to sync again before reopening Scout.

If OneDrive created sessions-index conflict copies, a mutation targeting that
partition conservatively merges valid rows into sessions-index.json and
archives the originals under .scout-sessions/index-conflicts/. Malformed or
contradictory copies remain blocked and require manual inspection.

Quick commands
--------------
  scout-sessions devices
  scout-sessions find insurance
  scout-sessions sessions --device current
  scout-sessions copy --from bdec03f9/fcca233d --to current
  scout-sessions delete --device current --session-id a6ff355b

Read-only commands are safe. Copy and delete are dry runs unless --apply is
present. Delete additionally requires --yes. Run "scout-sessions --help" for
the full storage model, examples, limitations, and safety behavior.

Version and integrity
---------------------
This bundle contains Scout Sessions CLI 1.0.2. The canonical source is the
included scout-sessions.mjs. Compare the downloaded ZIP's SHA-256 hash with the
publisher's SHA256SUMS file before installing. The source-only
scout-sessions-1.0.2.mjs artifact is byte-identical to the script in each ZIP.

Distribution and support
------------------------
This package is intended for internal SharePoint distribution. It is supplied
as an auditable support tool without automatic updates or a formal support SLA.
Keep the extracted files together when running an installer.
