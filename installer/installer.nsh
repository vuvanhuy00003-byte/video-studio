!macro customCheckAppRunning
  DetailPrint "Closing Video Studio before installing..."

  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "Video Studio.exe"'
  Pop $0
  Pop $1

  Sleep 1500
!macroend
