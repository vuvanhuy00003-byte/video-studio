!macro customCheckAppRunning
  DetailPrint "Closing K Studio before installing..."

  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Pop $1

  Sleep 1500
!macroend
