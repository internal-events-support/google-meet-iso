; Upgrade from GMeet ISO: nsis.guid in package.json is the old app's, so the old version is removed and replaced.
; Installs to "...\Google Meet ISO" instead of the old "...\GMeet ISO".
!define OLD_DIR_SUFFIX "\GMeet ISO"

!ifndef BUILD_UNINSTALLER
  !macro useNewInstallDir
    StrLen $R8 "${OLD_DIR_SUFFIX}"
    IntOp $R8 0 - $R8
    StrCpy $R9 $INSTDIR "" $R8
    ${if} $R9 == "${OLD_DIR_SUFFIX}"
      StrCpy $INSTDIR $INSTDIR $R8
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${endIf}
  !macroend

  ; Silent installs have no pages.
  !macro customInit
    ${if} ${Silent}
      !insertmacro useNewInstallDir
    ${endIf}
  !macroend

  ; Runs right after the folder page, which shows the old folder on an upgrade.
  !macro customPageAfterChangeDir
    Page custom useNewInstallDirPage
    Function useNewInstallDirPage
      !insertmacro useNewInstallDir
      Abort
    FunctionEnd
  !macroend

  ; Remove the installer copy the old version left behind.
  !macro customInstall
    SetShellVarContext current
    Delete "$LOCALAPPDATA\gmeet-iso-updater\installer.exe"
    RMDir "$LOCALAPPDATA\gmeet-iso-updater"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endIf}
  !macroend
!endif

!include "getProcessInfo.nsh"
Var pid

; The default check only looks in the new folder. Look in the old one instead, or the old uninstaller
; would close a running GMeet ISO without asking.
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !ifndef BUILD_UNINSTALLER
    StrCpy $R7 $INSTDIR
    ReadRegStr $R8 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $R8 != ""
      StrCpy $INSTDIR $R8
    ${endIf}
  !endif
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    StrCpy $INSTDIR $R7
  !endif
!macroend
