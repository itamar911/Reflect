'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  A11Y_STORAGE_KEY,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  TEXT_SCALE_STEP,
  getDefaultSettings,
  readStoredSettings,
  type AccessibilityContrast,
  type AccessibilitySettings,
} from './constants';

interface AccessibilityContextValue extends AccessibilitySettings {
  increaseTextScale: () => void;
  decreaseTextScale: () => void;
  setContrast: (contrast: AccessibilityContrast) => void;
  toggleGrayscale: () => void;
  toggleUnderlineLinks: () => void;
  toggleReadableFont: () => void;
  toggleLargeCursor: () => void;
  toggleReduceMotion: () => void;
  reset: () => void;
}

const AccessibilityContext = createContext<AccessibilityContextValue | null>(null);

export function AccessibilityProvider({ children }: { children: React.ReactNode }) {
  // Lazy-init reads localStorage directly (server returns defaults, since
  // `window` is undefined there). This never mismatches hydration: nothing
  // visible depends on these values until the panel is opened, by which
  // point hydration has long finished — see AccessibilityInitScript for the
  // part that actually has to run before first paint (the <html> attributes).
  const [settings, setSettings] = useState<AccessibilitySettings>(readStoredSettings);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-a11y-text-scale', String(settings.textScale));
    root.setAttribute('data-a11y-contrast', settings.contrast);
    root.setAttribute('data-a11y-grayscale', String(settings.grayscale));
    root.setAttribute('data-a11y-underline-links', String(settings.underlineLinks));
    root.setAttribute('data-a11y-readable-font', String(settings.readableFont));
    root.setAttribute('data-a11y-large-cursor', String(settings.largeCursor));
    root.setAttribute('data-a11y-reduce-motion', String(settings.reduceMotion));
    try {
      window.localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage can be unavailable (private mode, quota) — the setting still
      // applies for the current tab via the attributes set above.
    }
  }, [settings]);

  const increaseTextScale = useCallback(() => {
    setSettings((s) => ({ ...s, textScale: Math.min(TEXT_SCALE_MAX, s.textScale + TEXT_SCALE_STEP) }));
  }, []);
  const decreaseTextScale = useCallback(() => {
    setSettings((s) => ({ ...s, textScale: Math.max(TEXT_SCALE_MIN, s.textScale - TEXT_SCALE_STEP) }));
  }, []);
  const setContrast = useCallback((contrast: AccessibilityContrast) => {
    setSettings((s) => ({ ...s, contrast }));
  }, []);
  const toggleGrayscale = useCallback(() => setSettings((s) => ({ ...s, grayscale: !s.grayscale })), []);
  const toggleUnderlineLinks = useCallback(() => setSettings((s) => ({ ...s, underlineLinks: !s.underlineLinks })), []);
  const toggleReadableFont = useCallback(() => setSettings((s) => ({ ...s, readableFont: !s.readableFont })), []);
  const toggleLargeCursor = useCallback(() => setSettings((s) => ({ ...s, largeCursor: !s.largeCursor })), []);
  const toggleReduceMotion = useCallback(() => setSettings((s) => ({ ...s, reduceMotion: !s.reduceMotion })), []);
  // Re-checks the OS motion preference rather than hardcoding it off, so
  // "reset" lands on exactly what a first-time visitor would see.
  const reset = useCallback(() => setSettings(getDefaultSettings()), []);

  return (
    <AccessibilityContext.Provider
      value={{
        ...settings,
        increaseTextScale,
        decreaseTextScale,
        setContrast,
        toggleGrayscale,
        toggleUnderlineLinks,
        toggleReadableFont,
        toggleLargeCursor,
        toggleReduceMotion,
        reset,
      }}
    >
      {children}
    </AccessibilityContext.Provider>
  );
}

export function useAccessibility(): AccessibilityContextValue {
  const ctx = useContext(AccessibilityContext);
  if (!ctx) throw new Error('useAccessibility must be used within AccessibilityProvider');
  return ctx;
}
