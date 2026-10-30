Option Explicit

Dim fso, shell, baseDir, nodeExe, serverJs, edgeExe, portFile, logFile
Dim dataRoot, port, i, http, healthy, q, cmd, edgeArgs, errText

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = baseDir
nodeExe = baseDir & "\runtime\node\node.exe"
serverJs = baseDir & "\server.js"
logFile = baseDir & "\server.log"
q = Chr(34)

If Not fso.FileExists(nodeExe) Then
  Fail "Missing Node runtime: " & nodeExe
End If
If Not fso.FileExists(serverJs) Then
  Fail "Missing server.js: " & serverJs
End If

dataRoot = shell.ExpandEnvironmentStrings("%MINEPILOT_HOME%")
If dataRoot = "%MINEPILOT_HOME%" Or dataRoot = "" Then
  dataRoot = baseDir & "\data"
End If
portFile = dataRoot & "\web-port.txt"

On Error Resume Next
If fso.FileExists(portFile) Then fso.DeleteFile portFile, True
On Error GoTo 0

cmd = "cmd.exe /c " & q & q & nodeExe & q & " " & q & serverJs & q & " >> " & q & logFile & q & " 2>&1" & q
shell.Run cmd, 0, False

port = 0
For i = 1 To 160
  WScript.Sleep 250
  If fso.FileExists(portFile) Then
    On Error Resume Next
    Dim stream
    Set stream = fso.OpenTextFile(portFile, 1, False)
    port = CLng(Trim(stream.ReadAll))
    stream.Close
    On Error GoTo 0
    If port > 0 Then Exit For
  End If
Next

If port = 0 Then
  Fail "Local service did not start." & vbCrLf & vbCrLf & Tail(logFile)
End If

healthy = False
For i = 1 To 40
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", "http://127.0.0.1:" & port & "/health", False
  http.Send
  If Err.Number = 0 And http.Status = 200 Then healthy = True
  On Error GoTo 0
  If healthy Then Exit For
  WScript.Sleep 250
Next

If Not healthy Then
  Fail "Local service is not responding." & vbCrLf & vbCrLf & Tail(logFile)
End If

edgeExe = shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
If Not fso.FileExists(edgeExe) Then
  edgeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe"
End If
If Not fso.FileExists(edgeExe) Then
  edgeExe = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Microsoft\Edge\Application\msedge.exe"
End If
If Not fso.FileExists(edgeExe) Then
  Fail "Microsoft Edge was not found."
End If

edgeArgs = "--app=http://127.0.0.1:" & port & "/?web=1 --no-first-run --no-default-browser-check --disable-sync --disable-features=msEdgeFirstRunExperience"
Dim edgeProfile
edgeProfile = baseDir & "\edge-profile"
If Not fso.FolderExists(edgeProfile) Then fso.CreateFolder edgeProfile
edgeArgs = edgeArgs & " --user-data-dir=" & q & edgeProfile & q
shell.Run q & edgeExe & q & " " & edgeArgs, 1, False

' Keep this script alive: some security products kill child processes when the
' launcher exits. It also gives the page time to connect.
Dim connected
connected = False
For i = 1 To 80
  WScript.Sleep 500
  If IsConnected(port) Then
    connected = True
    Exit For
  End If
Next

If Not connected Then
  Fail "Edge window did not connect to MinePilot." & vbCrLf & vbCrLf & Tail(logFile)
End If

Do
  WScript.Sleep 5000
  If Not IsHealthy(port) Then Exit Do
Loop

Function HttpGet(url)
  Dim request
  HttpGet = ""
  On Error Resume Next
  Set request = CreateObject("MSXML2.XMLHTTP")
  request.Open "GET", url, False
  request.Send
  If Err.Number = 0 Then HttpGet = request.ResponseText
  On Error GoTo 0
End Function

Function IsHealthy(port)
  IsHealthy = (HttpGet("http://127.0.0.1:" & port & "/health") = "ok")
End Function

Function IsConnected(port)
  Dim body
  body = HttpGet("http://127.0.0.1:" & port & "/api/status")
  IsConnected = (InStr(body, """connected"":true") > 0)
End Function

Sub Fail(message)
  Dim noDialog
  noDialog = shell.ExpandEnvironmentStrings("%MINEPILOT_NO_DIALOG%")
  If noDialog = "1" Then
    WScript.Echo "MINEPILOT_ERROR: " & message
  Else
    MsgBox message, 16, "MinePilot"
  End If
  WScript.Quit 1
End Sub

Function Tail(file)
  Dim text, size, start, f
  Tail = "(no log)"
  On Error Resume Next
  If Not fso.FileExists(file) Then Exit Function
  Set f = fso.OpenTextFile(file, 1, False)
  text = f.ReadAll
  f.Close
  If Len(text) > 3000 Then text = Mid(text, Len(text) - 3000)
  Tail = text
  On Error GoTo 0
End Function