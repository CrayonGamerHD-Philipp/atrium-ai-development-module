' Atrium Runner: Oberflaeche ohne Konsolenfenster oeffnen (Startmenue, nach der Installation)
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run """" & dir & "\atrium-runner.exe"" app", 0, False
