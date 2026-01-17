export function shouldUnhideAppBeforeShowingMiniWindow(params: { isMac: boolean; isAppHidden: boolean }): boolean {
  return params.isMac && params.isAppHidden
}

export function shouldHideAppAfterHidingMiniWindow(params: {
  isMac: boolean
  macosMajorVersion: number
  wasMainWindowFocused: boolean
  isMainWindowVisible: boolean
}): boolean {
  if (!params.isMac) return false

  // On macOS 26+, the miniWindow popup would not change focus to previous application.
  // Keep the existing behavior: don't hide the whole app in that case.
  if (Number.isFinite(params.macosMajorVersion) && params.macosMajorVersion >= 26) return false

  // Hybrid rule (#12037): only hide the whole app if the main window isn't visible.
  // This keeps focus-restoration behavior for "Quick Assistant from another app" cases,
  // without unexpectedly hiding Cherry Studio when the main window is already open.
  return !params.wasMainWindowFocused && !params.isMainWindowVisible
}
