Option Explicit

Dim shell
Dim fso
Dim appDir
Dim command
Dim exitCode
Dim statusPath
Dim detail
Dim statusFile
Dim launcherPath

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcherPath = appDir & "\scripts\launch-cfs-app.ps1"
If fso.FileExists(launcherPath) Then
  command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Quote(launcherPath)
Else
  command = "cmd.exe /d /s /c " & Quote(Quote(appDir & "\START_CFS_APP.bat") & " --worker")
End If
exitCode = shell.Run(command, 0, True)

If exitCode <> 0 Then
  statusPath = appDir & "\artifacts\startup\latest-status.txt"
  detail = ""
  If fso.FileExists(statusPath) Then
    Set statusFile = fso.OpenTextFile(statusPath, 1)
    detail = Trim(statusFile.ReadAll)
    statusFile.Close
  End If
  shell.Popup "CFS could not be started." & vbCrLf & vbCrLf & detail & vbCrLf & vbCrLf & "Open artifacts\startup\latest-status.txt and the newest start log in the CFS folder for details.", 0, "CFS startup", 16
End If

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
