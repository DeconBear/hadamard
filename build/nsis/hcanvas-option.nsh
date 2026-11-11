!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var HcanvasCheckbox
Var HcanvasSelected

!macro customPageAfterChangeDir
  Page custom HcanvasPage HcanvasPageLeave
!macroend

Function HcanvasPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 14u "Optional components"
  Pop $0
  ${NSD_CreateCheckbox} 0 20u 100% 12u "Install Hadamard Canvas (standalone)"
  Pop $HcanvasCheckbox
  ${NSD_SetState} $HcanvasCheckbox ${BST_UNCHECKED}
  ${NSD_CreateLabel} 0 40u 100% 46u "Hadamard Canvas is a separate application. It is installed with its own uninstaller and can be removed without removing Hadamard."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function HcanvasPageLeave
  ${NSD_GetState} $HcanvasCheckbox $HcanvasSelected
FunctionEnd

!macro customInstall
  ${If} $HcanvasSelected == ${BST_CHECKED}
    DetailPrint "Installing Hadamard Canvas..."
    ExecWait '"$INSTDIR\resources\hcanvas-setup.exe" /S' $0
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "Hadamard Canvas installer returned code $0. You can install it later from the standalone installer."
    ${EndIf}
  ${EndIf}
!macroend
