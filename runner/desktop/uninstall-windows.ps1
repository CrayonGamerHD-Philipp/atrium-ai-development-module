$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName 'Atrium-Aidev-Runner' -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $task.TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false
}
Write-Host 'Aufgabe entfernt. Konfiguration und Logs bleiben unter APPDATA beziehungsweise LOCALAPPDATA erhalten.'
