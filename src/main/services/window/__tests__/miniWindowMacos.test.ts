import { describe, expect, it } from 'vitest'

import { shouldHideAppAfterHidingMiniWindow, shouldUnhideAppBeforeShowingMiniWindow } from '../miniWindowMacos'

describe('miniWindowMacos helpers', () => {
  describe('shouldUnhideAppBeforeShowingMiniWindow', () => {
    it('returns true only on macOS when app is hidden', () => {
      expect(shouldUnhideAppBeforeShowingMiniWindow({ isMac: true, isAppHidden: true })).toBe(true)
      expect(shouldUnhideAppBeforeShowingMiniWindow({ isMac: true, isAppHidden: false })).toBe(false)
      expect(shouldUnhideAppBeforeShowingMiniWindow({ isMac: false, isAppHidden: true })).toBe(false)
    })
  })

  describe('shouldHideAppAfterHidingMiniWindow', () => {
    it('returns false on non-macOS', () => {
      expect(
        shouldHideAppAfterHidingMiniWindow({
          isMac: false,
          macosMajorVersion: 15,
          wasMainWindowFocused: false,
          isMainWindowVisible: false
        })
      ).toBe(false)
    })

    it('returns false on macOS 26+', () => {
      expect(
        shouldHideAppAfterHidingMiniWindow({
          isMac: true,
          macosMajorVersion: 26,
          wasMainWindowFocused: false,
          isMainWindowVisible: false
        })
      ).toBe(false)
    })

    it('returns true only when main window is not visible and it was not focused', () => {
      expect(
        shouldHideAppAfterHidingMiniWindow({
          isMac: true,
          macosMajorVersion: 15,
          wasMainWindowFocused: false,
          isMainWindowVisible: false
        })
      ).toBe(true)

      expect(
        shouldHideAppAfterHidingMiniWindow({
          isMac: true,
          macosMajorVersion: 15,
          wasMainWindowFocused: true,
          isMainWindowVisible: false
        })
      ).toBe(false)

      expect(
        shouldHideAppAfterHidingMiniWindow({
          isMac: true,
          macosMajorVersion: 15,
          wasMainWindowFocused: false,
          isMainWindowVisible: true
        })
      ).toBe(false)
    })
  })
})
