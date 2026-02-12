; Custom NSIS installer include for Mnemora
; Included by electron-builder via the `include` option.
; NOTE: MUI_HEADERIMAGE, MUI_WELCOMEFINISHPAGE_BITMAP, MUI_ICON etc.
;       are already defined by electron-builder from electron-builder.json5.
;       Do NOT redefine them here.
;
; ${PRODUCT_NAME} is set by electron-builder from productName in config,
; so text below automatically adapts to "Mnemora" vs "Mnemora - Nightly".

; ── Welcome Page Text ────────────────────────────────────────────────
!define MUI_WELCOMEPAGE_TITLE "Welcome to ${PRODUCT_NAME}"
!define MUI_WELCOMEPAGE_TEXT "Setup will guide you through the installation of ${PRODUCT_NAME}.$\r$\n$\r$\n${PRODUCT_NAME} is your intelligent digital memory assistant$\r$\n— it captures, organizes, and resurfaces the moments that matter.$\r$\n$\r$\nClick Next to continue."

; ── Finish Page Text ─────────────────────────────────────────────────
!define MUI_FINISHPAGE_TITLE "${PRODUCT_NAME} Installation Complete"
!define MUI_FINISHPAGE_TEXT "${PRODUCT_NAME} has been installed on your computer.$\r$\n$\r$\nClick Finish to close Setup."
!define MUI_FINISHPAGE_LINK "Visit Mnemora on GitHub"
!define MUI_FINISHPAGE_LINK_LOCATION "https://github.com/mbaxszy7/Mnemora"

; ── Custom macro: runs after files are extracted ─────────────────────
!macro customInstall
  DetailPrint "Finalizing ${PRODUCT_NAME} installation..."
!macroend
