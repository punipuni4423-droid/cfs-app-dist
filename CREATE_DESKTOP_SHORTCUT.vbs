Option Explicit

Dim shell
Dim fso
Dim appDir
Dim desktop
Dim programs
Dim shortcutPath
Dim startMenuShortcutPath
Dim iconPath
Dim launchTarget

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
desktop = shell.SpecialFolders("Desktop")
programs = shell.SpecialFolders("Programs")
shortcutPath = desktop & "\CFS App.lnk"
startMenuShortcutPath = programs & "\CFS App.lnk"
iconPath = appDir & "\public\cfs-app-icon.ico"
launchTarget = appDir & "\LAUNCH_CFS_APP.cmd"
If Not fso.FileExists(launchTarget) Then
  launchTarget = appDir & "\LAUNCH_CFS_APP.vbs"
End If

CreateCfsShortcut shortcutPath
CreateCfsShortcut startMenuShortcutPath

MsgBox "CFS App shortcuts were created on the Desktop and Start menu." & vbCrLf & vbCrLf & "Shortcut target folder:" & vbCrLf & appDir, vbInformation, "CFS App"

Sub CreateCfsShortcut(path)
  Dim shortcut
  Set shortcut = shell.CreateShortcut(path)
  shortcut.TargetPath = launchTarget
  shortcut.WorkingDirectory = appDir
  If fso.FileExists(iconPath) Then
    shortcut.IconLocation = iconPath & ",0"
  Else
    shortcut.IconLocation = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\shell32.dll,220"
  End If
  shortcut.Description = "Start CFS App from " & appDir
  shortcut.Save
End Sub
