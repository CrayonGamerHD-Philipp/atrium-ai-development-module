param([string]$Config = $env:RUNNER_CONFIG, [string]$Name = $env:RUNNER_NAME)
$ErrorActionPreference = 'Stop'
if (-not $Config) { $Config = Read-Host 'Pfad zur Konfiguration' }
$Config = (Resolve-Path -LiteralPath $Config).Path
foreach ($cmd in @('node', 'npm', 'git', 'gh')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "Fehlt: $cmd" }
}
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
if ([int]((& $node -p 'process.versions.node.split(".")[0]')) -lt 24) { throw 'Node.js 24 oder neuer erforderlich.' }
foreach ($cmd in @('claude', 'codex', 'gemini')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Write-Warning "$cmd wurde nicht gefunden." }
}
$runner = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $runner
try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci fehlgeschlagen.' }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Runner-Build fehlgeschlagen.' }
} finally { Pop-Location }
$base = Join-Path $env:APPDATA 'atrium-aidev-runner'
$logs = Join-Path $env:LOCALAPPDATA 'atrium-aidev-runner'
New-Item -ItemType Directory -Force -Path $base, $logs | Out-Null
# Vererbung entfernen und ausschließlich dem aktuellen Benutzer Zugriff geben.
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($sid)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $base -AclObject $acl
$c = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
if ($env:ATRIUM_URL) { $c | Add-Member -NotePropertyName atriumUrl -NotePropertyValue $env:ATRIUM_URL -Force }
if ($env:ATRIUM_API_KEY) { $c | Add-Member -NotePropertyName apiKey -NotePropertyValue $env:ATRIUM_API_KEY -Force }
if (-not $c.atriumUrl) { $c | Add-Member -NotePropertyName atriumUrl -NotePropertyValue (Read-Host 'Atrium-URL') -Force }
if (-not $c.apiKey) {
    $secret = Read-Host 'Atrium-API-Key' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try { $c | Add-Member -NotePropertyName apiKey -NotePropertyValue ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) -Force }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
if (-not $c.atriumUrl -or -not $c.apiKey) { throw 'Atrium-URL und API-Key sind erforderlich.' }
if ($Name) { $c | Add-Member -NotePropertyName name -NotePropertyValue $Name -Force }
$c | Add-Member -NotePropertyName mode -NotePropertyValue 'desktop' -Force
$configDest = Join-Path $base 'config.json'
[IO.File]::WriteAllText($configDest, ($c | ConvertTo-Json -Depth 30), (New-Object System.Text.UTF8Encoding($false)))
# Auch eine bereits vorhandene Datei erhält die eingeschränkte ACL.
$fileAcl = New-Object System.Security.AccessControl.FileSecurity
$fileAcl.SetAccessRuleProtection($true, $false)
$fileAcl.SetOwner($sid)
$fileAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
Set-Acl -LiteralPath $configDest -AclObject $fileAcl
function Quote-PS([string]$value) { return "'" + $value.Replace("'", "''") + "'" }
$wrapper = Join-Path $base 'start.ps1'
$script = @"
`$env:PATH = $(Quote-PS $env:PATH)
Set-Location -LiteralPath $(Quote-PS $runner)
& $(Quote-PS $node) $(Quote-PS (Join-Path $runner 'dist\main.js')) start --config $(Quote-PS $configDest) 1>> $(Quote-PS (Join-Path $logs 'stdout.log')) 2>> $(Quote-PS (Join-Path $logs 'stderr.log'))
exit `$LASTEXITCODE
"@
[IO.File]::WriteAllText($wrapper, $script, (New-Object System.Text.UTF8Encoding($false)))
# VBScript startet PowerShell verborgen und gibt deren Exitcode an die Aufgabenplanung zurück.
$vbs = Join-Path $base 'start.vbs'
$escaped = $wrapper.Replace('"', '""')
[IO.File]::WriteAllText($vbs, "Set shell = CreateObject(""WScript.Shell"")`r`ncode = shell.Run(""powershell.exe -NoProfile -ExecutionPolicy Bypass -File """"$escaped"""""", 0, True)`r`nWScript.Quit code`r`n")
$taskName = 'Atrium-Aidev-Runner'
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument ('"' + $vbs + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Installiert. Logs: $logs"
Write-Host "Konten anmelden: cd `"$runner`"; node dist/main.js login <konto> --config `"$configDest`""
Write-Host "Prüfen: node dist/main.js probe --config `"$configDest`". In Atrium den Runner freigeben."
