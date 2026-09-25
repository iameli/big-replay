#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId=BigReplay.Desktop
AppName=Big Replay
AppVersion={#AppVersion}
AppPublisher=Big Replay
AppPublisherURL=https://github.com/iameli/big-replay
AppSupportURL=https://github.com/iameli/big-replay/issues
AppUpdatesURL=https://github.com/iameli/big-replay/releases/latest
DefaultDirName={localappdata}\Programs\Big Replay
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
AppMutex=Local\BigReplay.Desktop
; Never force-close the recorder while it is finishing a replay.
CloseApplications=no
RestartApplications=no
UninstallDisplayIcon={app}\BigReplay.exe
OutputDir=..\dist
OutputBaseFilename=BigReplay-Setup
VersionInfoVersion={#AppVersion}
VersionInfoDescription=Big Replay Installer
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UsePreviousTasks=yes

[Tasks]
Name: startup; Description: "Start Big Replay when I sign in to Windows"; GroupDescription: "Automatic recording:"; Flags: unchecked

[Files]
Source: "..\dist\BigReplay\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Big Replay"; Filename: "{app}\BigReplay.exe"; WorkingDir: "{app}"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: BigReplay; ValueData: """{app}\BigReplay.exe"""; Flags: uninsdeletevalue; Tasks: startup
; Unchecking startup on a later install must remove the earlier registration.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: BigReplay; Flags: deletevalue; Tasks: not startup

[Run]
Filename: "{app}\BigReplay.exe"; Description: "Launch Big Replay"; Flags: nowait postinstall skipifsilent
