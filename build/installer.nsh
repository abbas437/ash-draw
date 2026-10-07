; ASH Draw Studio (appId com.ashpmcs.drawstudio) - custom NSIS hooks, included by
; electron-builder via nsis.include. Same technique as ASH PDF Studio.
;
; Registers the app as an *available* handler for .dxf and .dwg ("Open with" list and
; Settings > Default apps) WITHOUT changing the default value of Software\Classes\.dxf
; or Software\Classes\.dwg. electron-builder's built-in `fileAssociations`
; (APP_ASSOCIATE) writes that default value, which can make this app the handler
; without asking - so it is not used. The user picks the default in Windows Settings.
;
; The open command passes the file as "%1"; electron/main.js accepts argv entries that
; match /\.(dxf|dwg)$/i (first launch and second-instance), so keep both lists in sync.
;
; SHELL_CONTEXT is HKCU for per-user installs (perMachine: false), HKLM otherwise.

!define ASH_PROGID_DXF "ASHPMCS.DrawStudio.DXF"
!define ASH_PROGID_DWG "ASHPMCS.DrawStudio.DWG"
!define ASH_CAPS "Software\ASH PMCS\ASH Draw Studio\Capabilities"

!macro ashRegisterProgId PROGID DESC
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}" "" "${DESC}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\shell\open" "" "Open with ASH Draw Studio"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\shell\open\command" "" '"$appExe" "%1"'
!macroend

!macro customInstall
  !insertmacro ashRegisterProgId "${ASH_PROGID_DXF}" "DXF drawing"
  !insertmacro ashRegisterProgId "${ASH_PROGID_DWG}" "DWG drawing"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.dxf\OpenWithProgids" "${ASH_PROGID_DXF}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.dwg\OpenWithProgids" "${ASH_PROGID_DWG}"

  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "ASH Draw Studio"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".dxf" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".dwg" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$appExe" "%1"'

  WriteRegStr SHELL_CONTEXT "${ASH_CAPS}" "ApplicationName" "ASH Draw Studio"
  WriteRegStr SHELL_CONTEXT "${ASH_CAPS}" "ApplicationDescription" "Free DXF/DWG drawing viewer and editor"
  WriteRegStr SHELL_CONTEXT "${ASH_CAPS}\FileAssociations" ".dxf" "${ASH_PROGID_DXF}"
  WriteRegStr SHELL_CONTEXT "${ASH_CAPS}\FileAssociations" ".dwg" "${ASH_PROGID_DWG}"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "ASH Draw Studio" "${ASH_CAPS}"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.dxf\OpenWithProgids" "${ASH_PROGID_DXF}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.dwg\OpenWithProgids" "${ASH_PROGID_DWG}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${ASH_PROGID_DXF}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${ASH_PROGID_DWG}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "ASH Draw Studio"
  DeleteRegKey SHELL_CONTEXT "Software\ASH PMCS\ASH Draw Studio"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\ASH PMCS"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
