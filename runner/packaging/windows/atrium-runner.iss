; Inno-Setup-Installer für den Atrium-Runner (PC-Betrieb), pro Benutzer ohne Administratorrechte.
; Aufruf (Release-Pipeline): iscc /DAppVersion=0.4.0 /DArch=x64 /DSourceDir=<Bündel> /DOutputDir=<Ziel> atrium-runner.iss
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Arch
  #define Arch "x64"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\release\atrium-runner"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\release"
#endif

[Setup]
AppId={{6F0C2B4E-2D7A-4B8E-9B3C-4A1D3E5B7C90}
AppName=Atrium Runner
AppVersion={#AppVersion}
AppPublisher=Kalypzo Atrium
DefaultDirName={localappdata}\Programs\AtriumRunner
DefaultGroupName=Atrium Runner
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ChangesEnvironment=yes
OutputDir={#OutputDir}
OutputBaseFilename=atrium-runner-{#AppVersion}-windows-{#Arch}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Sicherheitshinweis vor der Installation (UTF-8 mit BOM, damit Umlaute stimmen)
InfoBeforeFile=info-before.txt
UninstallDisplayIcon={app}\atrium-runner.exe
#if Arch == "arm64"
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#else
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif

[Languages]
Name: "de"; MessagesFile: "compiler:Languages\German.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Beim Anmelden automatisch starten (Autostart einrichten)"; Flags: checkedonce
Name: "startnow"; Description: "Runner nach der Installation starten"; Flags: checkedonce

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Registry]
; Programmverzeichnis zum PATH des Benutzers hinzufügen
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Check: NeedsAddPath(ExpandConstant('{app}'))

[Icons]
Name: "{group}\Atrium Runner – Status"; Filename: "{cmd}"; Parameters: "/k ""{app}\atrium-runner.exe"" status"
Name: "{group}\Atrium Runner – Jetzt an Server übergeben"; Filename: "{app}\atrium-runner.exe"; Parameters: "handover"
Name: "{group}\Atrium Runner – Pausieren"; Filename: "{app}\atrium-runner.exe"; Parameters: "pause"
Name: "{group}\Atrium Runner – Fortsetzen"; Filename: "{app}\atrium-runner.exe"; Parameters: "resume"
Name: "{group}\Atrium Runner – Konfiguration"; Filename: "notepad.exe"; Parameters: """{userappdata}\AtriumRunner\runner.config.json"""

[Run]
Filename: "{app}\atrium-runner.exe"; Parameters: "init"; Flags: runhidden waituntilterminated
Filename: "{app}\atrium-runner.exe"; Parameters: "install --no-start"; Flags: runhidden waituntilterminated; Tasks: autostart
Filename: "{app}\atrium-runner.exe"; Parameters: "service-start"; Flags: runhidden nowait; Tasks: autostart and startnow
Filename: "notepad.exe"; Parameters: """{userappdata}\AtriumRunner\runner.config.json"""; Description: "Konfiguration öffnen (Atrium-Adresse und API-Key eintragen)"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\atrium-runner.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "AtriumRunnerUninstall"

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Param) + ';', ';' + Uppercase(OrigPath) + ';') = 0;
end;
