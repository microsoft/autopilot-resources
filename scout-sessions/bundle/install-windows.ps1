[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Microsoft\ScoutSessions\bin"),
    [switch]$AddToPath,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$Version = "1.0.2"
$SourceScript = Join-Path $PSScriptRoot "scout-sessions.mjs"
$SourceLauncher = Join-Path $PSScriptRoot "scout-sessions.cmd"
$TargetScript = Join-Path $InstallDir "scout-sessions.mjs"
$TargetLauncher = Join-Path $InstallDir "scout-sessions.cmd"

function Update-UserPath([bool]$Remove) {
    $EnvironmentKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
    try {
        $ValueNames = @($EnvironmentKey.GetValueNames())
        $HasPath = $ValueNames -contains "Path"
        $Current = if ($HasPath) {
            [string]$EnvironmentKey.GetValue(
                "Path",
                "",
                [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
            )
        } else {
            ""
        }
        $ValueKind = if ($HasPath) {
            $EnvironmentKey.GetValueKind("Path")
        } else {
            [Microsoft.Win32.RegistryValueKind]::ExpandString
        }
        $NormalizedInstallDir = $InstallDir.TrimEnd("\")
        $Parts = @($Current -split ";" | Where-Object {
            $_ -and [Environment]::ExpandEnvironmentVariables($_).TrimEnd("\") -ine $NormalizedInstallDir
        })
        if (-not $Remove) {
            $Parts += $InstallDir
        }
        $EnvironmentKey.SetValue("Path", ($Parts -join ";"), $ValueKind)
    } finally {
        $EnvironmentKey.Dispose()
    }
    if (-not $Remove) {
        $env:Path = "$InstallDir;$env:Path"
    }
}

if ($Uninstall) {
    Remove-Item -LiteralPath $TargetScript, $TargetLauncher -Force -ErrorAction SilentlyContinue
    Update-UserPath $true
    Write-Host "Removed $InstallDir from the user PATH if it was present."
    Write-Host "Removed Scout Sessions CLI from $InstallDir"
    exit 0
}

$Node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $Node) {
    throw "Node.js 20 or newer is required. Install Node.js, then rerun this installer."
}
$NodeVersion = (& $Node.Source --version).Trim()
if ($NodeVersion -notmatch "^v?(\d+)") {
    throw "Could not determine the Node.js version from '$NodeVersion'."
}
if ([int]$Matches[1] -lt 20) {
    throw "Node.js 20 or newer is required; found $NodeVersion."
}
if (-not (Test-Path -LiteralPath $SourceScript) -or -not (Test-Path -LiteralPath $SourceLauncher)) {
    throw "Missing adjacent scout-sessions.mjs or scout-sessions.cmd. Keep the extracted bundle together."
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$Nonce = [Guid]::NewGuid().ToString("N")
$TempScript = Join-Path $InstallDir ".scout-sessions-$Nonce.mjs"
$TempLauncher = Join-Path $InstallDir ".scout-sessions-$Nonce.cmd"
try {
    Copy-Item -LiteralPath $SourceScript -Destination $TempScript
    Copy-Item -LiteralPath $SourceLauncher -Destination $TempLauncher
    Move-Item -LiteralPath $TempScript -Destination $TargetScript -Force
    Move-Item -LiteralPath $TempLauncher -Destination $TargetLauncher -Force
} finally {
    Remove-Item -LiteralPath $TempScript, $TempLauncher -Force -ErrorAction SilentlyContinue
}

& $Node.Source $TargetScript --help | Out-Null
if ($AddToPath) {
    Update-UserPath $false
    Write-Host "Added $InstallDir to the user PATH. Open a new terminal before running scout-sessions."
} else {
    Write-Host "Installed Scout Sessions CLI v$Version at $InstallDir"
    Write-Host "Run .\scout-sessions.cmd there, or rerun .\install.ps1 -AddToPath to update the user PATH."
}
