<#
.SYNOPSIS
    Downloads a private copy of your Autopilot workspace, including memories and sessions, to this PC.

.DESCRIPTION
    Signs you in with your work account, finds your Autopilot workspace in your OneDrive, checks that
    Git is installed (offering to install it), and saves a read-only copy of the repository
    and its history in a new folder under your user profile.

    Sign-in uses a registered local address,
    https://cowork.local.microsoft.com:44300/auth. On Windows the script temporarily maps that
    name to this PC and trusts a short-lived certificate valid only for that name. Both changes
    need administrator approval and are removed as soon as sign-in finishes.

    Nothing is uploaded, changed, shared, or deleted in OneDrive. No token is printed or saved.

.PARAMETER OutputFolder
    New folder for the download. Defaults to "Autopilot export <date time>" in your user profile.

.PARAMETER Account
    Optional work sign-in name to preselect on the Microsoft sign-in page.

.PARAMETER NoOpen
    Do not open the result folder in File Explorer when finished.

.PARAMETER TargetUser
    Administrator export: the sign-in name of the user whose Autopilot workspace to export. The signed-in
    administrator must already have been granted access to that user's OneDrive, for example from
    the Microsoft 365 admin center. Requires -Reason.

.PARAMETER TargetOneDriveUrl
    Administrator export: the user's OneDrive address, if it cannot be found automatically.

.PARAMETER Reason
    Administrator export: the approved request or case reference, recorded in the evidence manifest.

.EXAMPLE
    .\Export-AutopilotWorkspace.cmd

.EXAMPLE
    .\Export-AutopilotWorkspace.ps1 -TargetUser user@contoso.com -Reason "Privacy request 1234"
#>
[CmdletBinding()]
param(
    [string]$OutputFolder,
    [string]$Account,
    [switch]$NoOpen,
    [string]$TargetUser,
    [string]$TargetOneDriveUrl,
    [string]$Reason
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = 'Stop'

$script:ClientId = '6ab48b67-cd74-4ad4-81af-5932984589be'
$script:CallbackHost = 'cowork.local.microsoft.com'
$script:CallbackPort = 44300
$script:CallbackOrigin = 'https://cowork.local.microsoft.com:44300'
$script:RedirectUri = 'https://cowork.local.microsoft.com:44300/auth'
# File name the Autopilot service uses for the workspace in OneDrive.
$script:RepositoryName = 'lobster.repo'
$script:GraphScope = 'https://graph.microsoft.com/.default offline_access'
$script:GraphAudiences = @('https://graph.microsoft.com', '00000003-0000-0000-c000-000000000000')
$script:SharePointAppId = '00000003-0000-0ff1-ce00-000000000000'
$script:SignInTimeoutSeconds = 300
$script:TargetUserForGuidance = ''
$script:OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or ((Get-Variable -Name IsWindows -ValueOnly -ErrorAction SilentlyContinue) -eq $true)

function Stop-Export([string]$Message) {
    throw (New-Object System.InvalidOperationException $Message)
}

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
    [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-RandomToken([int]$ByteCount = 32) {
    $bytes = New-Object byte[] $ByteCount
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    ConvertTo-Base64Url $bytes
}

function Get-PkceChallenge([string]$Verifier) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { ConvertTo-Base64Url ($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($Verifier))) } finally { $sha.Dispose() }
}

function Test-ConstantTimeEqual([string]$Left, [string]$Right) {
    if ($null -eq $Left -or $null -eq $Right -or $Left.Length -ne $Right.Length) { return $false }
    $difference = 0
    for ($i = 0; $i -lt $Left.Length; $i++) { $difference = $difference -bor ([int]$Left[$i] -bxor [int]$Right[$i]) }
    $difference -eq 0
}

# JSON-compatible JavaScript string literal that is also safe inside an HTML script element.
function ConvertTo-JsString([string]$Value) {
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    foreach ($character in $Value.ToCharArray()) {
        $code = [int]$character
        if ($code -lt 0x20 -or $code -gt 0x7e -or '"\<>&''/'.IndexOf($character) -ge 0) {
            [void]$builder.Append('\u' + $code.ToString('x4'))
        } else {
            [void]$builder.Append($character)
        }
    }
    [void]$builder.Append('"')
    $builder.ToString()
}

# Returns $null when a parameter is repeated, so ambiguous callbacks are rejected.
function Get-QueryParameters([string]$Query) {
    $result = @{}
    if ([string]::IsNullOrEmpty($Query)) { return $result }
    foreach ($pair in $Query.Split('&')) {
        if ($pair.Length -eq 0) { continue }
        $index = $pair.IndexOf('=')
        if ($index -lt 0) { $name = $pair; $value = '' } else { $name = $pair.Substring(0, $index); $value = $pair.Substring($index + 1) }
        $name = [Uri]::UnescapeDataString($name.Replace('+', ' '))
        $value = [Uri]::UnescapeDataString($value.Replace('+', ' '))
        if ($result.ContainsKey($name)) { return $null }
        $result[$name] = $value
    }
    return $result
}

# Quotes one argument using the rules Windows programs use to split a command line.
function ConvertTo-ProcessArgument([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
        } elseif ($character -eq '"') {
            [void]$builder.Append('\' * (2 * $backslashes + 1)).Append('"')
            $backslashes = 0
        } else {
            [void]$builder.Append('\' * $backslashes).Append($character)
            $backslashes = 0
        }
    }
    [void]$builder.Append('\' * (2 * $backslashes)).Append('"')
    $builder.ToString()
}

function Get-JwtClaims([string]$Token) {
    if ($Token -notmatch '^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]*$') {
        Stop-Export 'Sign-in returned a token in an unexpected format.'
    }
    $payload = $Matches[1].Replace('-', '+').Replace('_', '/')
    switch ($payload.Length % 4) {
        2 { $payload += '==' }
        3 { $payload += '=' }
        1 { Stop-Export 'Sign-in returned a token in an unexpected format.' }
    }
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
}

function Get-ClaimValue($Claims, [string]$Name) {
    $property = $Claims.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return '' }
    [string]$property.Value
}

function Assert-AccessToken([string]$Token, [string[]]$Audiences, [string]$Purpose) {
    $claims = Get-JwtClaims $Token
    if ($Audiences -notcontains (Get-ClaimValue $claims 'aud')) {
        Stop-Export "Sign-in returned a $Purpose token for an unexpected service. Nothing was downloaded."
    }
    $client = Get-ClaimValue $claims 'appid'
    if (-not $client) { $client = Get-ClaimValue $claims 'azp' }
    if ($client -ne $script:ClientId) {
        Stop-Export "Sign-in returned a $Purpose token for an unexpected application. Nothing was downloaded."
    }
    $expires = 0L
    if (-not [long]::TryParse((Get-ClaimValue $claims 'exp'), [ref]$expires) -or
        $expires -lt ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 120)) {
        Stop-Export "Sign-in returned an expired $Purpose token. Run the script again."
    }
    if (-not (Get-ClaimValue $claims 'tid') -or -not (Get-ClaimValue $claims 'oid')) {
        Stop-Export "Sign-in returned a $Purpose token without an account identity. Nothing was downloaded."
    }
    $claims
}

function Get-TokenUserName($Claims) {
    foreach ($name in @('preferred_username', 'upn', 'unique_name')) {
        $value = Get-ClaimValue $Claims $name
        if ($value) { return $value }
    }
    '(unknown account)'
}

function Read-HttpRequest([System.IO.Stream]$Stream) {
    $header = New-Object System.IO.MemoryStream
    $one = New-Object byte[] 1
    while ($true) {
        if ($Stream.Read($one, 0, 1) -ne 1) { Stop-Export 'Connection closed before the request was complete.' }
        $header.WriteByte($one[0])
        $length = [int]$header.Length
        if ($length -gt 16384) { Stop-Export 'Request headers are too large.' }
        if ($length -ge 4) {
            $buffer = $header.GetBuffer()
            if ($buffer[$length - 4] -eq 13 -and $buffer[$length - 3] -eq 10 -and $buffer[$length - 2] -eq 13 -and $buffer[$length - 1] -eq 10) { break }
        }
    }
    $lines = [Text.Encoding]::ASCII.GetString($header.GetBuffer(), 0, [int]$header.Length).Split([string[]]@("`r`n"), [StringSplitOptions]::None)
    if ($lines[0] -notmatch '^(GET|POST) (/[^ ]*) HTTP/1\.[01]$') { Stop-Export 'Unsupported request.' }
    $method = $Matches[1]
    $target = $Matches[2]
    $headers = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
    for ($i = 1; $i -lt $lines.Length; $i++) {
        if ($lines[$i].Length -eq 0) { continue }
        $colon = $lines[$i].IndexOf(':')
        if ($colon -le 0) { Stop-Export 'Malformed request header.' }
        $name = $lines[$i].Substring(0, $colon).Trim()
        if ($headers.ContainsKey($name)) { Stop-Export 'Duplicate request header.' }
        $headers[$name] = $lines[$i].Substring($colon + 1).Trim()
    }
    $body = ''
    if ($headers.ContainsKey('Content-Length')) {
        $contentLength = 0
        if (-not [int]::TryParse($headers['Content-Length'], [ref]$contentLength) -or $contentLength -lt 0 -or $contentLength -gt 65536) {
            Stop-Export 'Invalid request length.'
        }
        $bytes = New-Object byte[] $contentLength
        $read = 0
        while ($read -lt $contentLength) {
            $count = $Stream.Read($bytes, $read, $contentLength - $read)
            if ($count -le 0) { Stop-Export 'Connection closed before the request body was complete.' }
            $read += $count
        }
        $body = [Text.Encoding]::UTF8.GetString($bytes)
    }
    $question = $target.IndexOf('?')
    if ($question -ge 0) { $path = $target.Substring(0, $question); $query = $target.Substring($question + 1) } else { $path = $target; $query = '' }
    New-Object PSObject -Property @{ Method = $method; Path = $path; Query = $query; Headers = $headers; Body = $body }
}

function New-HttpResponse([int]$Status, [string]$Reason, [string]$Body = '', [string]$ContentType = 'text/plain; charset=utf-8', [hashtable]$Headers = @{}) {
    New-Object PSObject -Property @{ Status = $Status; Reason = $Reason; Body = $Body; ContentType = $ContentType; Headers = $Headers }
}

function Write-HttpResponse([System.IO.Stream]$Stream, $Response) {
    $bodyBytes = [Text.Encoding]::UTF8.GetBytes($Response.Body)
    $lines = @(
        "HTTP/1.1 $($Response.Status) $($Response.Reason)",
        "Content-Type: $($Response.ContentType)",
        "Content-Length: $($bodyBytes.Length)",
        'Cache-Control: no-store',
        'Referrer-Policy: no-referrer',
        'X-Content-Type-Options: nosniff',
        'Connection: close'
    )
    foreach ($name in $Response.Headers.Keys) { $lines += "${name}: $($Response.Headers[$name])" }
    $head = [Text.Encoding]::ASCII.GetBytes(($lines -join "`r`n") + "`r`n`r`n")
    $Stream.Write($head, 0, $head.Length)
    if ($bodyBytes.Length -gt 0) { $Stream.Write($bodyBytes, 0, $bodyBytes.Length) }
    $Stream.Flush()
}

function Format-SignInError($Result) {
    $errorCode = [string]$Result.error
    if ($errorCode -notmatch '^[A-Za-z0-9_.-]{1,80}$') { $errorCode = 'unknown_error' }
    $parts = @("Sign-in did not complete ($errorCode).")
    $codes = @($Result.error_codes | Where-Object { "$_" -match '^\d{1,9}$' } | ForEach-Object { "AADSTS$_" })
    if ($codes.Count -gt 0) { $parts += 'Microsoft error: ' + ($codes -join ', ') + '.' }
    $description = ([string]$Result.description) -replace '[\x00-\x1f\x7f]+', ' '
    if ($description.Length -gt 400) { $description = $description.Substring(0, 400) + '...' }
    if ($description.Trim()) { $parts += $description.Trim() }
    $parts -join ' '
}

function New-CallbackPage($Session, [string]$Code) {
    $nonce = New-RandomToken 16
    $driveUrl = 'https://graph.microsoft.com/v1.0/me/drive?$select=webUrl'
    $rootSiteUrl = 'https://graph.microsoft.com/v1.0/sites/root?$select=webUrl'
    $page = @"
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Autopilot workspace export sign-in</title>
<style>body{font-family:'Segoe UI',system-ui,sans-serif;margin:3em auto;max-width:40em;line-height:1.5;padding:0 1em}</style>
</head><body><h1>Autopilot workspace export</h1><p id="status">Finishing sign-in. Keep this tab open.</p>
<script nonce="$nonce">
(function () {
  'use strict';
  var tokenEndpoint = $(ConvertTo-JsString $Session.TokenEndpoint);
  var resultUrl = $(ConvertTo-JsString ('/token-result?attempt=' + $Session.ResultNonce));
  var clientId = $(ConvertTo-JsString $script:ClientId);
  var redirectUri = $(ConvertTo-JsString $script:RedirectUri);
  var graphScope = $(ConvertTo-JsString $script:GraphScope);
  var driveUrl = $(ConvertTo-JsString $driveUrl);
  var rootSiteUrl = $(ConvertTo-JsString $rootSiteUrl);
  var knownHost = $(ConvertTo-JsString ([string]$Session.KnownHost));
  var adminMode = $(if ($Session.AdminMode) { 'true' } else { 'false' });
  var verifier = $(ConvertTo-JsString $Session.Verifier);
  var code = $(ConvertTo-JsString $Code);
  var statusElement = document.getElementById('status');
  history.replaceState(null, '', '/auth');
  function show(text) { statusElement.textContent = text; }
  function failure(stage, error, codes, description) {
    var problem = new Error(error);
    problem.detail = { stage: stage, error: String(error), error_codes: codes || [], description: String(description || '') };
    return problem;
  }
  function post(result) {
    return fetch(resultUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result), credentials: 'omit' });
  }
  async function redeem(stage, fields) {
    var response = await fetch(tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(), credentials: 'omit' });
    var data = {};
    try { data = await response.json(); } catch (ignored) { data = {}; }
    if (!response.ok || typeof data.access_token !== 'string') {
      throw failure(stage, data.error || ('http_' + response.status), Array.isArray(data.error_codes) ? data.error_codes : [], data.error_description);
    }
    return data;
  }
  async function graphGet(url, accessToken) {
    var response = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken }, credentials: 'omit' });
    var data = {};
    try { data = await response.json(); } catch (ignored) { data = {}; }
    return { ok: response.ok, status: response.status, data: data };
  }
  (async function () {
    try {
      var graph = await redeem('graph', { client_id: clientId, grant_type: 'authorization_code', code: code, redirect_uri: redirectUri, code_verifier: verifier, scope: graphScope });
      if (typeof graph.refresh_token !== 'string') { throw failure('graph', 'no_refresh_token'); }
      var host = knownHost;
      var driveWebUrl = '';
      if (!host) {
        var drive = await graphGet(driveUrl, graph.access_token);
        if (drive.ok) {
          driveWebUrl = String(drive.data.webUrl);
          host = new URL(driveWebUrl).host.toLowerCase();
        } else if (adminMode) {
          // An administrator may have no OneDrive; derive the tenant's OneDrive host from its root site.
          var root = await graphGet(rootSiteUrl, graph.access_token);
          if (!root.ok) { throw failure('onedrive', 'graph_http_' + root.status, [], (root.data.error || {}).message); }
          var rootHost = new URL(String(root.data.webUrl)).host.toLowerCase();
          var parts = /^([a-z0-9-]+)(\.sharepoint(-df)?\.com)$/.exec(rootHost);
          if (!parts) { throw failure('onedrive', 'unsupported_sharepoint_host'); }
          host = parts[1] + '-my' + parts[2];
        } else {
          throw failure('onedrive', 'graph_http_' + drive.status, [], (drive.data.error || {}).message);
        }
      }
      if (!/^[a-z0-9-]+\.sharepoint(-df)?\.com$/.test(host)) { throw failure('onedrive', 'unsupported_onedrive_host'); }
      var sharepoint = await redeem('sharepoint', { client_id: clientId, grant_type: 'refresh_token', refresh_token: graph.refresh_token, scope: 'https://' + host + '/.default' });
      await post({ graph_token: graph.access_token, sharepoint_token: sharepoint.access_token, sharepoint_host: host, drive_web_url: driveWebUrl });
      show('Signed in. Return to the PowerShell window to follow the download. You can close this tab.');
    } catch (problem) {
      var detail = problem && problem.detail ? problem.detail : { stage: 'browser', error: 'browser_error', error_codes: [], description: String(problem && problem.message || '') };
      try { await post(detail); } catch (ignored) {}
      show('Sign-in could not be completed. Return to the PowerShell window for details.');
    }
  })();
})();
</script></body></html>
"@
    $policy = "default-src 'none'; script-src 'nonce-$nonce'; style-src 'unsafe-inline'; connect-src 'self' https://login.microsoftonline.com https://graph.microsoft.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    New-HttpResponse 200 'OK' $page 'text/html; charset=utf-8' @{ 'Content-Security-Policy' = $policy }
}

function Invoke-CallbackRequest($Request, $Session) {
    if ($Request.Method -eq 'GET' -and $Request.Path -eq '/auth') {
        $query = Get-QueryParameters $Request.Query
        if ($null -eq $query) { return New-HttpResponse 400 'Bad Request' 'Invalid sign-in response. Return to the PowerShell window.' }
        if (-not $query.ContainsKey('state') -or -not (Test-ConstantTimeEqual $query['state'] $Session.State)) {
            return New-HttpResponse 400 'Bad Request' 'This sign-in tab belongs to a different attempt. Return to the PowerShell window.'
        }
        if ($query.ContainsKey('error')) {
            $Session.Result = New-Object PSObject -Property @{ stage = 'authorize'; error = $query['error']; error_codes = @(); description = $query['error_description'] }
            return New-HttpResponse 200 'OK' 'Sign-in did not complete. Return to the PowerShell window for details.'
        }
        if (-not $query.ContainsKey('code') -or -not $query['code']) {
            return New-HttpResponse 400 'Bad Request' 'Invalid sign-in response. Return to the PowerShell window.'
        }
        if ($Session.CodeServed) {
            return New-HttpResponse 410 'Gone' 'This sign-in response was already used. Return to the PowerShell window.'
        }
        $Session.CodeServed = $true
        return New-CallbackPage $Session $query['code']
    }
    if ($Request.Method -eq 'POST' -and $Request.Path -eq '/token-result') {
        $query = Get-QueryParameters $Request.Query
        $origin = $null
        if ($null -eq $query -or -not $query.ContainsKey('attempt') -or -not (Test-ConstantTimeEqual $query['attempt'] $Session.ResultNonce) -or
            -not $Request.Headers.TryGetValue('Origin', [ref]$origin) -or $origin -cne $script:CallbackOrigin) {
            return New-HttpResponse 403 'Forbidden' 'Forbidden.'
        }
        if ($null -ne $Session.Result) { return New-HttpResponse 409 'Conflict' 'Already completed.' }
        try { $Session.Result = $Request.Body | ConvertFrom-Json } catch { return New-HttpResponse 400 'Bad Request' 'Invalid result.' }
        return New-HttpResponse 204 'No Content'
    }
    New-HttpResponse 404 'Not Found' 'Not found.'
}

function Invoke-CallbackConnection($Client, $Certificate, $Session) {
    $Client.ReceiveTimeout = 5000
    $Client.SendTimeout = 5000
    $ssl = New-Object System.Net.Security.SslStream ($Client.GetStream(), $false)
    try {
        $ssl.AuthenticateAsServer($Certificate, $false, [System.Security.Authentication.SslProtocols]::Tls12, $false)
        $request = Read-HttpRequest $ssl
        Write-HttpResponse $ssl (Invoke-CallbackRequest $request $Session)
    } finally {
        $ssl.Dispose()
    }
}

function Open-SignInPage([string]$Url) {
    Write-Host 'Your browser will open the Microsoft sign-in page. Choose your work account.'
    Write-Host 'If it does not open, copy this address into Microsoft Edge using your work profile:'
    Write-Host $Url -ForegroundColor DarkGray
    if ($script:OnWindows) {
        try { Start-Process ('microsoft-edge:' + $Url) } catch { Write-Verbose 'Could not start Microsoft Edge automatically.' }
    }
}

function Wait-ForSignIn($Session, $Certificate) {
    $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, $script:CallbackPort)
    if ($script:OnWindows) { $listener.ExclusiveAddressUse = $true }
    try { $listener.Start() } catch {
        Stop-Export "Port $($script:CallbackPort) on this computer is already in use. Close other sign-in tools that may use it, then run this script again."
    }
    $pending = $null
    try {
        Open-SignInPage $Session.AuthorizeUrl
        $deadline = [DateTime]::UtcNow.AddSeconds($script:SignInTimeoutSeconds)
        while ($null -eq $Session.Result) {
            $remaining = ($deadline - [DateTime]::UtcNow).TotalMilliseconds
            if ($remaining -le 0) { Stop-Export 'Sign-in timed out after 5 minutes. Nothing was downloaded. Run the script again when you are ready.' }
            if ($null -eq $pending) { $pending = $listener.AcceptTcpClientAsync() }
            if (-not $pending.Wait([int][Math]::Min($remaining, 1000))) { continue }
            $client = $pending.Result
            $pending = $null
            try {
                Invoke-CallbackConnection $client $Certificate $Session
            } catch {
                Write-Verbose "Ignored a browser connection: $($_.Exception.Message)"
            } finally {
                $client.Close()
            }
        }
    } finally {
        $listener.Stop()
    }
    $Session.Result
}

function Get-SignInGuidance($Result) {
    $codes = @($Result.error_codes | ForEach-Object { "$_" })
    if ($Result.stage -eq 'onedrive') {
        return 'Your OneDrive could not be read. Open OneDrive in your browser once to make sure it is set up, then try again.'
    }
    if ($codes -contains '65001' -or $codes -contains '65004' -or $Result.error -eq 'consent_required') {
        return 'Your organization has not approved this sign-in for your account. Ask your IT support team for help.'
    }
    if ($codes -contains '53003' -or $codes -contains '53000' -or $codes -contains '530084') {
        return 'Your organization''s sign-in policy blocked this request. Ask your IT support team for help; do not use another account.'
    }
    if ($Result.error -eq 'access_denied') { return 'Sign-in was cancelled. Run the script again to retry.' }
    'Run the script again. If this repeats, send this message to your IT support team.'
}

function Invoke-SignIn([string]$LoginHint, $Certificate, [string]$KnownHost = '', [bool]$AdminMode = $false) {
    $verifier = New-RandomToken 32
    $session = @{
        State = New-RandomToken 24
        ResultNonce = New-RandomToken 24
        Verifier = $verifier
        CodeServed = $false
        Result = $null
        KnownHost = $KnownHost
        AdminMode = $AdminMode
        TokenEndpoint = 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token'
    }
    $parameters = [ordered]@{
        client_id = $script:ClientId
        response_type = 'code'
        redirect_uri = $script:RedirectUri
        response_mode = 'query'
        scope = $script:GraphScope
        prompt = 'select_account'
        code_challenge = (Get-PkceChallenge $verifier)
        code_challenge_method = 'S256'
        state = $session.State
    }
    if ($LoginHint) { $parameters['login_hint'] = $LoginHint }
    $query = ($parameters.Keys | ForEach-Object { $_ + '=' + [Uri]::EscapeDataString([string]$parameters[$_]) }) -join '&'
    $session.AuthorizeUrl = 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?' + $query

    $result = Wait-ForSignIn $session $Certificate
    if ($result.PSObject.Properties['error']) {
        Stop-Export ((Format-SignInError $result) + ' ' + (Get-SignInGuidance $result) + ' Nothing was downloaded.')
    }
    foreach ($name in @('graph_token', 'sharepoint_token', 'sharepoint_host')) {
        if (-not $result.PSObject.Properties[$name] -or -not ($result.$name -is [string]) -or -not $result.$name) {
            Stop-Export 'Sign-in returned an incomplete result. Nothing was downloaded. Run the script again.'
        }
    }
    if ($result.sharepoint_host -cnotmatch '^[a-z0-9-]+\.sharepoint(-df)?\.com$' -or ($KnownHost -and $result.sharepoint_host -cne $KnownHost)) {
        Stop-Export 'Sign-in returned an unexpected OneDrive address. Nothing was downloaded.'
    }
    if (-not $AdminMode -and -not ($result.drive_web_url -is [string] -and $result.drive_web_url)) {
        Stop-Export 'Your OneDrive address could not be read. Open OneDrive in your browser once, then run the script again. Nothing was downloaded.'
    }
    $result
}

function Test-CallbackHostResolvesLocally {
    try { $addresses = @([System.Net.Dns]::GetHostAddresses($script:CallbackHost)) } catch { return $false }
    if ($addresses.Count -eq 0) { return $false }
    foreach ($address in $addresses) { if (-not [System.Net.IPAddress]::IsLoopback($address)) { return $false } }
    @($addresses | Where-Object { $_.ToString() -eq '127.0.0.1' }).Count -gt 0
}

function Test-HostsHasCallbackEntry {
    $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    if (-not (Test-Path -LiteralPath $hostsPath)) { return $false }
    foreach ($line in [IO.File]::ReadAllLines($hostsPath)) {
        $content = $line.Split('#')[0]
        if ($content -match '(^|\s)cowork\.local\.microsoft\.com(\s|$)') { return $true }
    }
    $false
}

# Runs elevated in Windows PowerShell. Values are substituted from script-generated hexadecimal, Base64 and Base64url text only.
$script:ElevatedHelper = @'
$ErrorActionPreference = 'Stop'
$mode = '__MODE__'
$marker = '__MARKER__'
$addHosts = '__ADDHOSTS__' -eq 'true'
$certificateBase64 = '__CERTIFICATE__'
$thumbprint = '__THUMBPRINT__'
$hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$entry = '127.0.0.1 cowork.local.microsoft.com ' + $marker
$failed = $false
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store ('Root', 'LocalMachine')
if ($mode -eq 'Add') {
    try {
        $store.Open('ReadWrite')
        try { $store.Add((New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (,[Convert]::FromBase64String($certificateBase64)))) } finally { $store.Close() }
        if ($addHosts) {
            $text = [IO.File]::ReadAllText($hostsPath)
            $prefix = ''
            if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $prefix = "`r`n" }
            [IO.File]::AppendAllText($hostsPath, $prefix + $entry + "`r`n", [Text.Encoding]::ASCII)
        }
    } catch { $failed = $true }
}
if ($mode -eq 'Remove' -or $failed) {
    try {
        $text = [IO.File]::ReadAllText($hostsPath)
        if ($text.Contains($marker)) {
            $kept = @($text -split "`r?`n" | Where-Object { -not $_.EndsWith($marker) })
            [IO.File]::WriteAllText($hostsPath, ($kept -join "`r`n"), (New-Object System.Text.UTF8Encoding $false))
        }
    } catch { $failed = $true }
    try {
        $store.Open('ReadWrite')
        try { foreach ($certificate in @($store.Certificates.Find('FindByThumbprint', $thumbprint, $false))) { $store.Remove($certificate) } } finally { $store.Close() }
    } catch { $failed = $true }
}
try { & (Join-Path $env:SystemRoot 'System32\ipconfig.exe') /flushdns | Out-Null } catch { }
if ($failed) { exit 1 }
exit 0
'@

function Invoke-ElevatedHelper([string]$Mode, $Setup) {
    $helper = $script:ElevatedHelper.Replace('__MODE__', $Mode).Replace('__MARKER__', $Setup.Marker).Replace('__ADDHOSTS__', ([string]$Setup.AddHosts).ToLowerInvariant()).Replace('__CERTIFICATE__', [Convert]::ToBase64String($Setup.Certificate.RawData)).Replace('__THUMBPRINT__', $Setup.Certificate.Thumbprint)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($helper))
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    try {
        $process = Start-Process -FilePath $powershell -Verb RunAs -WindowStyle Hidden -PassThru -Wait -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
    } catch {
        return $false
    }
    $process.ExitCode -eq 0
}

function New-TemporaryCallbackCertificate {
    $settings = @{
        Subject = "CN=$($script:CallbackHost)"
        DnsName = $script:CallbackHost
        CertStoreLocation = 'Cert:\CurrentUser\My'
        Type = 'SSLServerAuthentication'
        KeyAlgorithm = 'RSA'
        KeyLength = 2048
        HashAlgorithm = 'SHA256'
        KeyExportPolicy = 'NonExportable'
        NotBefore = (Get-Date).AddMinutes(-5)
        NotAfter = (Get-Date).AddHours(2)
        FriendlyName = 'Autopilot export temporary sign-in certificate (safe to delete)'
    }
    try {
        New-SelfSignedCertificate @settings -TextExtension @('2.5.29.19={critical}{text}ca=0')
    } catch {
        New-SelfSignedCertificate @settings
    }
}

function Remove-TemporaryCallbackCertificate($Certificate) {
    if ($null -eq $Certificate) { return }
    $path = 'Cert:\CurrentUser\My\' + $Certificate.Thumbprint
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -DeleteKey -ErrorAction SilentlyContinue }
}

function Start-CallbackEnvironment {
    $resolvesLocally = Test-CallbackHostResolvesLocally
    if (-not $script:OnWindows) { Stop-Export 'This script runs on Windows only.' }
    if (-not $resolvesLocally -and (Test-HostsHasCallbackEntry)) {
        Stop-Export "Your hosts file already has a different entry for $($script:CallbackHost). Ask your IT support team to remove it, then run this script again."
    }
    $certificate = New-TemporaryCallbackCertificate
    $setup = New-Object PSObject -Property @{
        Certificate = $certificate
        Temporary = $true
        Applied = $false
        AddHosts = -not $resolvesLocally
        Marker = '# autopilot-export-' + (New-RandomToken 12)
    }
    Write-Host 'Windows will ask for administrator approval to prepare sign-in. Choose Yes.'
    if (-not (Invoke-ElevatedHelper 'Add' $setup)) {
        Remove-TemporaryCallbackCertificate $certificate
        Stop-Export 'Administrator approval was declined, or Windows blocked the temporary sign-in setup. Nothing was changed or downloaded.'
    }
    $setup.Applied = $true
    for ($attempt = 0; $attempt -lt 20 -and -not (Test-CallbackHostResolvesLocally); $attempt++) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-CallbackHostResolvesLocally)) {
        Stop-CallbackEnvironment $setup
        Stop-Export 'The temporary sign-in address did not take effect. Security software may have blocked the change. Ask your IT support team for help.'
    }
    $setup
}

function Stop-CallbackEnvironment($Setup) {
    if ($null -eq $Setup -or -not $Setup.Temporary) { return }
    if ($Setup.Applied) {
        Write-Host 'Windows will ask for administrator approval once more to remove the temporary sign-in setup. Choose Yes.'
        if (Invoke-ElevatedHelper 'Remove' $Setup) {
            $Setup.Applied = $false
        } else {
            Write-Warning ("The temporary sign-in setup could not be removed automatically. Ask your IT support team to remove the hosts file line ending in '$($Setup.Marker)' " +
                "and the local machine root certificate with thumbprint $($Setup.Certificate.Thumbprint). The certificate expires within two hours.")
        }
    }
    Remove-TemporaryCallbackCertificate $Setup.Certificate
    $Setup.Temporary = $false
}

function New-HttpClient {
    if ($PSVersionTable.PSEdition -eq 'Desktop') {
        Add-Type -AssemblyName System.Net.Http
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object System.Net.Http.HttpClient ($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(60)
    $client
}

function Get-InnermostMessage($Exception) {
    while ($Exception.InnerException) { $Exception = $Exception.InnerException }
    $Exception.Message
}

function Invoke-JsonGet($Client, [string]$Uri, [string]$Token) {
    $service = ([Uri]$Uri).Host
    for ($attempt = 1; ; $attempt++) {
        $request = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::Get, $Uri)
        try {
            $request.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue ('Bearer', $Token)
            $request.Headers.Accept.ParseAdd('application/json')
            try {
                $response = $Client.SendAsync($request).GetAwaiter().GetResult()
            } catch {
                $detail = (Get-InnermostMessage $_.Exception).Replace($Token, '[REDACTED]')
                if ($attempt -lt 3) {
                    Write-Verbose "Request to $service failed (attempt $attempt): $detail"
                    Start-Sleep -Seconds (2 * $attempt)
                    continue
                }
                Stop-Export "Could not connect to $service after 3 attempts. Check your network, VPN or proxy connection and run the script again. Nothing was downloaded. Details: $detail"
            }
            try {
                $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                $json = $null
                if ($text) { try { $json = $text | ConvertFrom-Json } catch { $json = $null } }
                return New-Object PSObject -Property @{ Status = [int]$response.StatusCode; Json = $json }
            } finally {
                $response.Dispose()
            }
        } finally {
            $request.Dispose()
        }
    }
}

function Get-PersonalDriveLocation([string]$DriveWebUrl) {
    $uri = $null
    if (-not [Uri]::TryCreate($DriveWebUrl, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or -not $uri.IsDefaultPort -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        Stop-Export 'Your OneDrive address was not in the expected format. Nothing was downloaded.'
    }
    $hostName = $uri.Host.ToLowerInvariant()
    $segments = $uri.AbsolutePath.Trim('/').Split('/')
    if ($hostName -notmatch '^[a-z0-9-]+\.sharepoint(-df)?\.com$' -or $segments.Length -ne 3 -or $segments[0] -ne 'personal' -or
        [Uri]::UnescapeDataString($segments[1]) -notmatch '^[A-Za-z0-9_.-]+$' -or [Uri]::UnescapeDataString($segments[1]) -match '^\.+$') {
        Stop-Export 'Your OneDrive is not a personal OneDrive for work or school that this script supports. Nothing was downloaded.'
    }
    $siteRoot = "https://$hostName/personal/$($segments[1])"
    New-Object PSObject -Property @{
        Host = $hostName
        SiteRoot = $siteRoot
        DriveApi = "$siteRoot/_api/v2.1/drive"
        DriveWebUrl = [Uri]::UnescapeDataString("https://$hostName" + $uri.AbsolutePath.TrimEnd('/'))
    }
}

# Converts an item web address in the user's own drive to an escaped drive-relative path.
function ConvertTo-DriveRelativePath([string]$ItemWebUrl, $Location) {
    $decoded = [Uri]::UnescapeDataString($ItemWebUrl).TrimEnd('/')
    $prefix = $Location.DriveWebUrl + '/'
    if (-not $decoded.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $segments = $decoded.Substring($prefix.Length).Split('/')
    foreach ($segment in $segments) {
        if (-not $segment -or $segment -eq '.' -or $segment -eq '..' -or $segment -match '[\x00-\x1f\x7f\\]') { return $null }
    }
    ($segments | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
}

function Test-UserPrincipalName([string]$Value) {
    $Value -match '^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'
}

# Returns the personal site root from any address inside a OneDrive for work or school, or $null.
function Get-PersonalSiteRoot([string]$Url, [string]$ExpectedHost) {
    $uri = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or -not $uri.IsDefaultPort -or $uri.UserInfo) { return $null }
    $hostName = $uri.Host.ToLowerInvariant()
    if ($hostName -notmatch '^[a-z0-9-]+\.sharepoint(-df)?\.com$' -or ($ExpectedHost -and $hostName -ne $ExpectedHost)) { return $null }
    $segments = $uri.AbsolutePath.Trim('/').Split('/')
    if ($segments.Length -lt 2 -or $segments[0] -ne 'personal') { return $null }
    $owner = [Uri]::UnescapeDataString($segments[1])
    if ($owner -notmatch '^[A-Za-z0-9_.-]+$' -or $owner -match '^\.+$') { return $null }
    "https://$hostName/personal/$($segments[1])"
}

function Get-AdminAccessGuidance([string]$Target) {
    "You do not have access to the OneDrive of $Target, so nothing was downloaded. To grant yourself temporary access, go to " +
    "https://admin.microsoft.com, select Users > Active users, select the user, open the OneDrive tab, and under 'Get access to files' " +
    "select 'Create link to files'. Then run this script again with -TargetOneDriveUrl set to that link, and remove your access when the export is complete."
}

function Resolve-TargetDriveLocation($Client, [string]$HostName, [string]$Target, [string]$GraphToken, [string]$SharePointToken, [string]$TargetUrl) {
    $escapedTarget = [Uri]::EscapeDataString($Target)
    $siteRoot = $null
    if ($TargetUrl) {
        $siteRoot = Get-PersonalSiteRoot $TargetUrl $HostName
        if (-not $siteRoot) { Stop-Export '-TargetOneDriveUrl is not a OneDrive for work or school address in this organization. Nothing was downloaded.' }
    }
    if (-not $siteRoot) {
        $drive = Invoke-JsonGet $Client ("https://graph.microsoft.com/v1.0/users/$escapedTarget/drive" + '?$select=webUrl') $GraphToken
        if ($drive.Status -eq 200 -and $drive.Json) { $siteRoot = Get-PersonalSiteRoot ([string]$drive.Json.webUrl) $HostName }
        else { Write-Verbose "Microsoft Graph could not read the user's OneDrive address (HTTP $($drive.Status))." }
    }
    if (-not $siteRoot) {
        $account = [Uri]::EscapeDataString("'i:0#.f|membership|$Target'")
        $userProfile = Invoke-JsonGet $Client "https://$HostName/_api/SP.UserProfiles.PeopleManager/GetPropertiesFor(accountName=@v)?@v=$account" $SharePointToken
        if ($userProfile.Status -eq 200 -and $userProfile.Json -and $userProfile.Json.PersonalUrl) {
            $siteRoot = Get-PersonalSiteRoot ([string]$userProfile.Json.PersonalUrl) $HostName
        } else {
            Write-Verbose "The SharePoint user profile could not be read (HTTP $($userProfile.Status))."
        }
    }
    if (-not $siteRoot) {
        Stop-Export "Could not find the OneDrive of $Target. Copy the user's OneDrive address from the Microsoft 365 admin center and run the script again with -TargetOneDriveUrl. Nothing was downloaded."
    }

    $driveInfo = Invoke-JsonGet $Client ("$siteRoot/_api/v2.1/drive" + '?$select=webUrl,owner') $SharePointToken
    if ($driveInfo.Status -eq 401 -or $driveInfo.Status -eq 403 -or $driveInfo.Status -eq 404) { Stop-Export (Get-AdminAccessGuidance $Target) }
    if ($driveInfo.Status -ne 200 -or -not $driveInfo.Json) { Stop-Export "Could not read the OneDrive of $Target (HTTP $($driveInfo.Status)). Nothing was downloaded." }
    $location = Get-PersonalDriveLocation ([string]$driveInfo.Json.webUrl)
    if ($location.SiteRoot -ne $siteRoot) { Stop-Export "The OneDrive address for $Target did not match its drive. Nothing was downloaded." }
    # Drive metadata can be readable without access to its files, so confirm the files are readable too.
    $rootInfo = Invoke-JsonGet $Client ("$($location.DriveApi)/root" + '?$select=id') $SharePointToken
    if ($rootInfo.Status -eq 401 -or $rootInfo.Status -eq 403 -or $rootInfo.Status -eq 404) { Stop-Export (Get-AdminAccessGuidance $Target) }

    $ownerUser = $null
    if ($driveInfo.Json.owner) { $ownerUser = $driveInfo.Json.owner.user }
    $ownerEmail = ''
    $ownerId = ''
    if ($ownerUser) { $ownerEmail = [string]$ownerUser.email; $ownerId = [string]$ownerUser.id }
    $identities = @($Target)
    $targetId = ''
    $directoryUser = Invoke-JsonGet $Client ("https://graph.microsoft.com/v1.0/users/$escapedTarget" + '?$select=id,mail,userPrincipalName') $GraphToken
    if ($directoryUser.Status -eq 200 -and $directoryUser.Json) {
        $identities += @([string]$directoryUser.Json.mail, [string]$directoryUser.Json.userPrincipalName) | Where-Object { $_ }
        $targetId = [string]$directoryUser.Json.id
    }
    $ownerMatches = ($ownerEmail -and ($identities | Where-Object { $_ -ieq $ownerEmail })) -or ($ownerId -and $targetId -and $ownerId -ieq $targetId)
    if (($ownerEmail -or $ownerId) -and -not $ownerMatches) {
        Stop-Export "This OneDrive belongs to $ownerEmail, not $Target. Nothing was downloaded."
    }
    if (-not $ownerMatches) { Write-Warning "The owner of $($location.SiteRoot) could not be confirmed. Check that it belongs to $Target before continuing." }
    $location | Add-Member -NotePropertyName Owner -NotePropertyValue $(if ($ownerEmail) { $ownerEmail } else { $Target })
    $location | Add-Member -NotePropertyName OwnerConfirmed -NotePropertyValue ([bool]$ownerMatches)
    $location
}

function Find-AutopilotWorkspaces($Client, $Location, [string]$GraphToken, [string]$SharePointToken, [string]$GraphDrivePath = 'me/drive') {
    $select = '?$select=id,name,webUrl,lastModifiedDateTime'
    $found = [ordered]@{}
    $addresses = New-Object System.Collections.Generic.List[string]
    foreach ($path in @("special/copilot/children/$($script:RepositoryName)", "root:/Documents/Copilot/$($script:RepositoryName)", "root:/Copilot/$($script:RepositoryName)")) {
        $addresses.Add("$($Location.DriveApi)/$path$select")
    }
    $search = Invoke-JsonGet $Client ("https://graph.microsoft.com/v1.0/$GraphDrivePath/root/search(q='$($script:RepositoryName)')" + '?$select=name,webUrl&$top=100') $GraphToken
    if ($search.Status -eq 200 -and $search.Json) {
        foreach ($item in @($search.Json.value)) {
            if ([string]$item.name -ceq $script:RepositoryName) {
                $relative = ConvertTo-DriveRelativePath ([string]$item.webUrl) $Location
                if ($relative) { $addresses.Add("$($Location.DriveApi)/root:/$relative$select") }
            }
        }
    } else {
        Write-Verbose "OneDrive search returned HTTP $($search.Status); checking the usual locations only."
    }
    $refused = 0
    foreach ($address in $addresses) {
        $response = Invoke-JsonGet $Client $address $SharePointToken
        Write-Verbose ("Checked " + $address.Substring($Location.DriveApi.Length).Split('?')[0] + ": HTTP $($response.Status)")
        # One location can be refused (for example another user's special folder) while others are readable.
        if ($response.Status -eq 401 -or $response.Status -eq 403) { $refused++; continue }
        if ($response.Status -ne 200 -or -not $response.Json) { continue }
        $item = $response.Json
        $id = [string]$item.id
        if ([string]$item.name -cne $script:RepositoryName -or -not $id -or $found.Contains($id)) { continue }
        if (-not (ConvertTo-DriveRelativePath ([string]$item.webUrl) $Location)) { continue }
        $found[$id] = New-Object PSObject -Property @{
            Id = $id
            WebUrl = [Uri]::UnescapeDataString([string]$item.webUrl)
            Folder = [Uri]::UnescapeDataString([string]$item.webUrl).Substring($Location.DriveWebUrl.Length).TrimStart('/')
            Modified = [string]$item.lastModifiedDateTime
            GitUrl = "$($Location.DriveApi)/items/$([Uri]::EscapeDataString($id))/git"
        }
    }
    if ($found.Count -eq 0 -and $refused -gt 0) {
        if ($script:TargetUserForGuidance) { Stop-Export (Get-AdminAccessGuidance $script:TargetUserForGuidance) }
        Stop-Export "OneDrive refused access (HTTP 401 or 403). Your organization may restrict this sign-in. Nothing was downloaded."
    }
    @($found.Values)
}

function Select-AutopilotWorkspace($Repositories) {
    # Windows PowerShell 5.1 has no Count on a single custom object, so normalize to an array.
    $Repositories = @($Repositories)
    if ($Repositories.Count -eq 0) {
        Stop-Export "No Autopilot workspace was found in your OneDrive. If you have used Autopilot with this account, ask your support team where your workspace is stored. Nothing was downloaded."
    }
    if ($Repositories.Count -eq 1) { return $Repositories[0] }
    Write-Host 'More than one Autopilot workspace was found in your OneDrive:'
    for ($i = 0; $i -lt $Repositories.Count; $i++) {
        Write-Host ("  {0}. {1}  (last changed {2})" -f ($i + 1), $Repositories[$i].Folder, $Repositories[$i].Modified)
    }
    while ($true) {
        $answer = Read-Host "Type the number to download (1-$($Repositories.Count))"
        $choice = 0
        if ([int]::TryParse($answer, [ref]$choice) -and $choice -ge 1 -and $choice -le $Repositories.Count) { return $Repositories[$choice - 1] }
    }
}

function Get-CleanEnvironment {
    $environment = @{}
    foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
        if (-not ([string]$entry.Key).ToUpperInvariant().StartsWith('GIT_')) { $environment[[string]$entry.Key] = [string]$entry.Value }
    }
    $environment
}

function Invoke-Process([string]$FilePath, [string[]]$Arguments, [hashtable]$Environment, [string]$WorkingDirectory, [string]$Secret) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = ($Arguments | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    if ($WorkingDirectory) { $startInfo.WorkingDirectory = $WorkingDirectory }
    if ($Environment) {
        $startInfo.EnvironmentVariables.Clear()
        foreach ($key in $Environment.Keys) { $startInfo.EnvironmentVariables[$key] = $Environment[$key] }
    }
    $process = [System.Diagnostics.Process]::Start($startInfo)
    try {
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $errorText = $errors.Result
        if ($Secret) { $errorText = $errorText.Replace($Secret, '[REDACTED]') }
        New-Object PSObject -Property @{ ExitCode = $process.ExitCode; Output = $output.Result; Error = $errorText.Trim() }
    } finally {
        $process.Dispose()
    }
}

function Test-GitHttps([string]$Git) {
    try {
        $result = Invoke-Process $Git @('--exec-path') (Get-CleanEnvironment) $null $null
    } catch {
        return $false
    }
    if ($result.ExitCode -ne 0) { return $false }
    $execPath = $result.Output.Trim()
    try {
        [IO.File]::Exists([IO.Path]::Combine($execPath, 'git-remote-https.exe')) -or [IO.File]::Exists([IO.Path]::Combine($execPath, 'git-remote-https'))
    } catch {
        $false
    }
}

function Find-Git {
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($command in @(Get-Command git -CommandType Application -All -ErrorAction SilentlyContinue)) { $candidates.Add($command.Path) }
    if ($script:OnWindows) {
        foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path ([string]$env:LOCALAPPDATA) 'Programs'))) {
            if ($root) { $candidates.Add((Join-Path $root 'Git\cmd\git.exe')) }
        }
    } else {
        $candidates.Add('/usr/bin/git')
    }
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if ((Test-Path -LiteralPath $candidate) -and (Test-GitHttps $candidate)) { return $candidate }
    }
    $null
}

function Get-Git {
    $git = Find-Git
    if ($git) { return $git }
    $winget = Get-Command winget -CommandType Application -ErrorAction SilentlyContinue
    if (-not $script:OnWindows -or -not $winget) {
        Stop-Export 'Git is required but was not found. Install Git for Windows from https://git-scm.com/download/win, then run this script again.'
    }
    Write-Host 'Git is required to download your repository and is not installed.'
    $answer = Read-Host 'Install Git for Windows now using Windows Package Manager (winget)? Type Y to install'
    if ($answer -notmatch '^(y|yes)$') {
        Stop-Export 'Git was not installed. Install Git for Windows from https://git-scm.com/download/win, then run this script again.'
    }
    # Send installer output to the console so it does not become part of this function's return value.
    & $winget.Path install --id Git.Git --exact --source winget | Out-Host
    $git = Find-Git
    if (-not $git) { Stop-Export 'Git installation did not complete. Install Git for Windows from https://git-scm.com/download/win, then run this script again.' }
    $git
}

function New-GitEnvironment([string]$Token, [string]$HostName, [string]$TemplateDirectory) {
    $environment = Get-CleanEnvironment
    $settings = @(
        @('credential.helper', ''),
        @('http.extraHeader', ''),
        @("http.https://$HostName/.extraHeader", "Authorization: Bearer $Token"),
        @('http.followRedirects', 'false'),
        @('http.sslVerify', 'true'),
        @('protocol.version', '2'),
        @('http.version', 'HTTP/1.1'),
        @('protocol.allow', 'never'),
        @('protocol.https.allow', 'always'),
        @('core.hooksPath', $TemplateDirectory)
    )
    $environment['GIT_CONFIG_NOSYSTEM'] = '1'
    $environment['GIT_CONFIG_GLOBAL'] = $(if ($script:OnWindows) { 'NUL' } else { '/dev/null' })
    $environment['GIT_TERMINAL_PROMPT'] = '0'
    $environment['GIT_TEMPLATE_DIR'] = $TemplateDirectory
    $environment['GIT_CONFIG_COUNT'] = [string]$settings.Count
    for ($i = 0; $i -lt $settings.Count; $i++) {
        $environment["GIT_CONFIG_KEY_$i"] = $settings[$i][0]
        $environment["GIT_CONFIG_VALUE_$i"] = $settings[$i][1]
    }
    $environment
}

function Get-RefMap([string]$Text) {
    $map = @{}
    foreach ($line in ($Text -split "`r?`n")) {
        if (-not $line) { continue }
        $parts = $line.Split("`t")
        if ($parts.Length -eq 2) { $map[$parts[1]] = $parts[0] }
    }
    $map
}

function Test-SameRefs([hashtable]$Left, [hashtable]$Right) {
    if ($Left.Count -ne $Right.Count) { return $false }
    foreach ($key in $Left.Keys) { if (-not $Right.ContainsKey($key) -or $Right[$key] -ne $Left[$key]) { return $false } }
    $true
}

function Resolve-OutputFolder([string]$Requested, [string]$Label = '') {
    if (-not $Requested) {
        $name = 'Autopilot export '
        if ($Label) { $name += ($Label -replace '[^A-Za-z0-9._-]', '_') + ' ' }
        $Requested = Join-Path $HOME ($name + (Get-Date -Format 'yyyy-MM-dd HHmmss'))
    }
    $path = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Requested)
    if ((Test-Path -LiteralPath $path) -or -not (Test-Path -LiteralPath (Split-Path -Parent $path) -PathType Container)) {
        Stop-Export "Choose a new folder whose parent folder already exists: $path"
    }
    foreach ($synced in @($env:OneDrive, $env:OneDriveCommercial, $env:OneDriveConsumer)) {
        if ($synced -and ($path + '\').StartsWith($synced.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
            Stop-Export "Choose a folder that OneDrive does not synchronize. $path is inside $synced."
        }
    }
    $path
}

function Invoke-ExportGit($Context, [string[]]$Arguments) {
    Invoke-Process $Context.Git $Arguments $Context.Environment $Context.WorkingDirectory $Context.Token
}

function New-PrivateDirectory([string]$Path) {
    if ($script:OnWindows -or $PSVersionTable.PSVersion.Major -lt 7) {
        New-Item -ItemType Directory -Path $Path | Out-Null
    } else {
        [void][IO.Directory]::CreateDirectory($Path, [IO.UnixFileMode]'UserRead, UserWrite, UserExecute')
    }
}

function Write-ExportReadme([string]$Folder, $Repository, [string]$Owner, [string]$ExportedBy, [bool]$HasLatestFiles) {
    $latest = $(if ($HasLatestFiles) { '"Latest files" contains a readable copy of the files in the most recent version.' } else { 'No readable copy of the latest files could be created; the full repository is still included.' })
    $text = @"
Autopilot workspace export
==========================

Downloaded:  $(Get-Date -Format 'yyyy-MM-dd HH:mm')
Owner:       $Owner
Exported by: $ExportedBy
Source:      $($Repository.WebUrl)

$latest
"repository.git" contains the full Git repository, including earlier versions and history.
Open it with Git, for example: git --git-dir "repository.git" log

This is a copy of personal data. Keep it on this device, do not share it, and delete it
when you no longer need it. Deleting this copy does not delete anything from Autopilot or OneDrive.
"@
    [IO.File]::WriteAllText((Join-Path $Folder 'README.txt'), $text, (New-Object System.Text.UTF8Encoding $false))
}

# Records who exported what, from where, and SHA-256 hashes of every exported file. Returns the manifest's own hash.
function Write-ExportManifest([string]$Folder, [hashtable]$Details) {
    $files = @()
    foreach ($file in (Get-ChildItem -LiteralPath $Folder -Recurse -Force -File | Sort-Object FullName)) {
        $relative = $file.FullName.Substring($Folder.Length).TrimStart('\', '/').Replace('\', '/')
        $files += [ordered]@{ path = $relative; bytes = $file.Length; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $Details['files'] = $files
    $manifestPath = Join-Path $Folder 'export-manifest.json'
    [IO.File]::WriteAllText($manifestPath, ($Details | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding $false))
    (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Export-AutopilotWorkspace([string]$Git, $Repository, $Location, [string]$Token, [string]$OutputFolder, [string]$Owner, [string]$ExportedBy) {
    $template = Join-Path ([IO.Path]::GetTempPath()) ('autopilot-export-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $template | Out-Null
    try {
        $context = New-Object PSObject -Property @{
            Git = $Git
            Environment = (New-GitEnvironment $Token $Location.Host $template)
            WorkingDirectory = $template
            Token = $Token
        }
        $before = Invoke-ExportGit $context @('ls-remote', '--refs', '--', $Repository.GitUrl)
        if ($before.ExitCode -ne 0) { Stop-Export "OneDrive did not allow the download. Nothing was saved.`n$($before.Error)" }
        $beforeRefs = Get-RefMap $before.Output

        New-PrivateDirectory $OutputFolder
        $repositoryPath = Join-Path $OutputFolder 'repository.git'
        Write-Host 'Downloading your memories, sessions and history. This can take a few minutes...'
        $clone = Invoke-ExportGit $context @('clone', '--mirror', '--quiet', '--', $Repository.GitUrl, $repositoryPath)
        $failedRefs = @()
        if ($clone.ExitCode -ne 0) {
            # SharePoint can fail to serve every reference in one pack; fetching them separately succeeds.
            Write-Host 'The one-step download failed. Downloading branches and tags one at a time instead...'
            Remove-Item -LiteralPath $repositoryPath -Recurse -Force -ErrorAction SilentlyContinue
            $clone = Invoke-ExportGit $context @('clone', '--bare', '--single-branch', '--no-tags', '--quiet', '--', $Repository.GitUrl, $repositoryPath)
            if ($clone.ExitCode -ne 0) {
                Stop-Export "The download failed. A partial copy may remain in $OutputFolder; it may contain personal data.`n$($clone.Error)"
            }
            $current = Get-RefMap (Invoke-ExportGit $context @('--git-dir', $repositoryPath, 'for-each-ref', '--format=%(objectname)%09%(refname)')).Output
            foreach ($ref in ($beforeRefs.Keys | Sort-Object)) {
                if ($current[$ref] -eq $beforeRefs[$ref]) { continue }
                if ($ref -notmatch '^refs/[A-Za-z0-9._/@+-]+$') { $failedRefs += $ref; continue }
                $fetch = Invoke-ExportGit $context @('--git-dir', $repositoryPath, 'fetch', '--no-tags', '--quiet', '--', $Repository.GitUrl, "+${ref}:${ref}")
                if ($fetch.ExitCode -ne 0) { $failedRefs += $ref }
            }
            if ($failedRefs.Count -gt 0) {
                Write-Warning "$($failedRefs.Count) branch or tag reference(s) could not be downloaded: $($failedRefs -join ', ')"
            }
        }
        $removeRemote = Invoke-ExportGit $context @('--git-dir', $repositoryPath, 'config', '--remove-section', 'remote.origin')
        if ($removeRemote.ExitCode -ne 0) { Write-Warning 'The copy was saved, but its link back to OneDrive could not be removed. Do not use it to upload changes.' }

        Write-Host 'Checking the downloaded copy...'
        $local = Invoke-ExportGit $context @('--git-dir', $repositoryPath, 'for-each-ref', '--format=%(objectname)%09%(refname)')
        $check = Invoke-ExportGit $context @('--git-dir', $repositoryPath, 'fsck', '--full', '--no-reflogs')
        $after = Invoke-ExportGit $context @('ls-remote', '--refs', '--', $Repository.GitUrl)
        $verified = ($local.ExitCode -eq 0) -and ($check.ExitCode -eq 0) -and ($after.ExitCode -eq 0) -and
            (Test-SameRefs $beforeRefs (Get-RefMap $local.Output)) -and (Test-SameRefs $beforeRefs (Get-RefMap $after.Output))

        $pathCount = 0
        $hasLatestFiles = $false
        if ($beforeRefs.Count -gt 0) {
            $tree = Invoke-ExportGit $context @('--git-dir', $repositoryPath, 'ls-tree', '-r', '--name-only', 'HEAD')
            if ($tree.ExitCode -eq 0) { $pathCount = @($tree.Output -split "`r?`n" | Where-Object { $_ }).Count }
            $zip = Join-Path $OutputFolder 'latest-files.zip'
            $archive = Invoke-ExportGit $context @('--git-dir', $repositoryPath, 'archive', '--format=zip', "--output=$zip", 'HEAD')
            if ($archive.ExitCode -eq 0) {
                $previousProgress = $ProgressPreference
                $ProgressPreference = 'SilentlyContinue'
                try {
                    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $OutputFolder 'Latest files')
                    Remove-Item -LiteralPath $zip
                    $hasLatestFiles = $true
                } catch {
                    Write-Warning "Some files could not be unpacked. They remain in $zip."
                } finally {
                    $ProgressPreference = $previousProgress
                }
            }
        }
        Write-ExportReadme $OutputFolder $Repository $Owner $ExportedBy $hasLatestFiles
        New-Object PSObject -Property @{ RefCount = $beforeRefs.Count; PathCount = $pathCount; Verified = $verified; HasLatestFiles = $hasLatestFiles; Refs = $beforeRefs; FailedRefs = $failedRefs }
    } finally {
        Remove-Item -LiteralPath $template -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-AutopilotExport {
    $setup = $null
    $client = $null
    $signIn = $null
    try {
        if (-not $script:OnWindows) { Stop-Export 'This script runs on Windows only.' }
        $adminMode = [bool]$TargetUser
        $knownHost = ''
        if ($adminMode) {
            if (-not (Test-UserPrincipalName $TargetUser)) { Stop-Export "-TargetUser must be a sign-in name such as user@contoso.com." }
            Write-Host "Autopilot workspace export (administrator): export the Autopilot workspace of $TargetUser." -ForegroundColor Cyan
            Write-Host 'Run this only for an approved request. Nothing in OneDrive is changed, shared or deleted.'
            if (-not $Reason) { $Reason = Read-Host 'Enter the approved request or case reference for this export' }
            if (-not $Reason -or -not $Reason.Trim()) { Stop-Export 'An approved request or case reference is required for an administrator export.' }
            $Reason = ($Reason -replace '[\x00-\x1f\x7f]+', ' ').Trim()
            if ($TargetOneDriveUrl) {
                $targetRoot = Get-PersonalSiteRoot $TargetOneDriveUrl ''
                if (-not $targetRoot) { Stop-Export '-TargetOneDriveUrl is not a OneDrive for work or school address.' }
                $knownHost = ([Uri]$targetRoot).Host
            }
        } else {
            if ($TargetOneDriveUrl -or $Reason) { Stop-Export '-TargetOneDriveUrl and -Reason are only used with -TargetUser.' }
            Write-Host 'Autopilot workspace export: download a private copy of your Autopilot memories and sessions.' -ForegroundColor Cyan
            Write-Host 'This reads your own Autopilot workspace from OneDrive. Nothing in OneDrive is changed, shared or deleted.'
        }

        Write-Step 'Checking this computer'
        $git = Get-Git
        Write-Host "Git found: $git"
        $output = Resolve-OutputFolder $OutputFolder $(if ($adminMode) { $TargetUser.Split('@')[0] } else { '' })
        Write-Host "The copy will be saved in: $output"
        if ($script:OnWindows) {
            Write-Host 'Next, Windows asks for administrator approval to set up sign-in temporarily, then your browser opens.'
        }
        [void](Read-Host 'Press Enter to continue, or close this window to cancel')

        Write-Step 'Preparing sign-in'
        $setup = Start-CallbackEnvironment
        Write-Step 'Signing in'
        try {
            $signIn = Invoke-SignIn $Account $setup.Certificate $knownHost $adminMode
        } finally {
            Stop-CallbackEnvironment $setup
        }

        $hostName = $signIn.sharepoint_host
        $graphClaims = Assert-AccessToken $signIn.graph_token $script:GraphAudiences 'OneDrive lookup'
        $downloadClaims = Assert-AccessToken $signIn.sharepoint_token @($script:SharePointAppId, "https://$hostName", "https://$hostName/") 'download'
        if ((Get-ClaimValue $graphClaims 'tid') -ne (Get-ClaimValue $downloadClaims 'tid') -or (Get-ClaimValue $graphClaims 'oid') -ne (Get-ClaimValue $downloadClaims 'oid')) {
            Stop-Export 'Sign-in returned tokens for different accounts. Nothing was downloaded. Run the script again.'
        }
        $userName = Get-TokenUserName $downloadClaims
        Write-Host "Signed in as $userName."
        $client = New-HttpClient

        if ($adminMode) {
            if ($userName -ieq $TargetUser) { Stop-Export 'You signed in as the target user. For your own data, run the script without -TargetUser.' }
            Write-Step "Finding the OneDrive of $TargetUser"
            $script:TargetUserForGuidance = $TargetUser
            $location = Resolve-TargetDriveLocation $client $hostName $TargetUser $signIn.graph_token $signIn.sharepoint_token $TargetOneDriveUrl
            $owner = $location.Owner
            $graphDrivePath = 'users/' + [Uri]::EscapeDataString($TargetUser) + '/drive'
        } else {
            $location = Get-PersonalDriveLocation $signIn.drive_web_url
            if ($location.Host -ne $hostName) { Stop-Export 'Sign-in returned an unexpected OneDrive address. Nothing was downloaded.' }
            $owner = $userName
            $graphDrivePath = 'me/drive'
        }

        Write-Step 'Finding the Autopilot workspace'
        $repository = Select-AutopilotWorkspace @(Find-AutopilotWorkspaces $client $location $signIn.graph_token $signIn.sharepoint_token $graphDrivePath)
        Write-Host "Found: $($repository.Folder)"
        if ($adminMode) {
            Write-Host "Owner: $owner"
            Write-Host "Reason: $Reason"
            $confirmation = Read-Host "Type $TargetUser to confirm this export"
            if ($confirmation.Trim() -ine $TargetUser) { Stop-Export 'The export was not confirmed. Nothing was downloaded.' }
        }

        Write-Step 'Downloading'
        $exportedAt = [DateTime]::UtcNow
        $summary = Export-AutopilotWorkspace $git $repository $location $signIn.sharepoint_token $output $owner $userName
        $refs = [ordered]@{}
        foreach ($name in ($summary.Refs.Keys | Sort-Object)) { $refs[$name] = $summary.Refs[$name] }
        $manifestHash = Write-ExportManifest $output ([ordered]@{
            schema = 'autopilot-workspace-export-manifest/1'
            exportStartedUtc = $exportedAt.ToString('o')
            exportCompletedUtc = [DateTime]::UtcNow.ToString('o')
            mode = $(if ($adminMode) { 'administrator' } else { 'self' })
            reason = $(if ($adminMode) { $Reason } else { $null })
            exportedBy = [ordered]@{ userName = $userName; objectId = (Get-ClaimValue $downloadClaims 'oid'); tenantId = (Get-ClaimValue $downloadClaims 'tid') }
            subject = [ordered]@{ requested = $(if ($adminMode) { $TargetUser } else { $userName }); oneDriveOwner = $owner; ownerConfirmed = $(if ($adminMode) { $location.OwnerConfirmed } else { $true }); oneDrive = $location.SiteRoot }
            source = [ordered]@{ webUrl = $repository.WebUrl; itemId = $repository.Id; gitUrl = $repository.GitUrl; lastModified = $repository.Modified }
            references = $refs
            verification = [ordered]@{ verified = $summary.Verified; referenceCount = $summary.RefCount; failedReferences = @($summary.FailedRefs) }
            tool = [ordered]@{ name = 'Export-AutopilotWorkspace.ps1'; sha256 = $(if ($PSCommandPath) { (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }); powershell = $PSVersionTable.PSVersion.ToString() }
        })

        Write-Step 'Finished'
        Write-Host "Saved to: $output" -ForegroundColor Green
        Write-Host "Copied $($summary.RefCount) branch or tag references; the latest version has $($summary.PathCount) files."
        if ($summary.Verified) {
            Write-Host 'The copy passed integrity checks, and the OneDrive repository was unchanged during the download.'
        } else {
            Write-Warning 'The copy was saved, but it could not be fully verified. Autopilot may have been updating it during the download. Run the script again into a new folder if you need a consistent copy.'
        }
        Write-Host 'This copy contains personal data. Keep it private and delete it when you no longer need it.'
        Write-Host "Evidence manifest: export-manifest.json (SHA-256 $manifestHash). Record this hash with the request."
        if ($adminMode) {
            Write-Host ''
            Write-Host "Remove your temporary access to the OneDrive of $TargetUser now. Open this page, remove $userName from Site Collection Administrators, and select OK:" -ForegroundColor Yellow
            Write-Host "  $($location.SiteRoot)/_layouts/15/mngsiteadmin.aspx"
            Write-Host 'Or, with the SharePoint Online Management Shell module, after Connect-SPOService:'
            Write-Host "  Set-SPOUser -Site '$($location.SiteRoot)' -LoginName '$userName' -IsSiteCollectionAdmin `$false"
        }
        if (-not $NoOpen -and $script:OnWindows) { Invoke-Item -LiteralPath $output }
        return 0
    } catch {
        Write-Host ''
        Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
        return 1
    } finally {
        if ($setup) { Stop-CallbackEnvironment $setup }
        if ($client) { $client.Dispose() }
        $signIn = $null
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    exit (Invoke-AutopilotExport)
}
