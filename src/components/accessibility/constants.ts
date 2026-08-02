export const A11Y_STORAGE_KEY = 'reflect-accessibility-settings';

export const TEXT_SCALE_MIN = 100;
export const TEXT_SCALE_MAX = 150;
export const TEXT_SCALE_STEP = 10;

export type AccessibilityContrast = 'normal' | 'high' | 'inverted';

export interface AccessibilitySettings {
  textScale: number;
  contrast: AccessibilityContrast;
  grayscale: boolean;
  underlineLinks: boolean;
  readableFont: boolean;
  largeCursor: boolean;
  reduceMotion: boolean;
}

export const DEFAULT_SETTINGS_BASE: Omit<AccessibilitySettings, 'reduceMotion'> = {
  textScale: TEXT_SCALE_MIN,
  contrast: 'normal',
  grayscale: false,
  underlineLinks: false,
  readableFont: false,
  largeCursor: false,
};

export function clampTextScale(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : TEXT_SCALE_MIN;
  const stepped = Math.round(n / TEXT_SCALE_STEP) * TEXT_SCALE_STEP;
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, stepped));
}

export function isContrast(value: unknown): value is AccessibilityContrast {
  return value === 'normal' || value === 'high' || value === 'inverted';
}

/** OS-level default, used only when the visitor has never touched the widget. */
export function getSystemReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function getDefaultSettings(): AccessibilitySettings {
  return { ...DEFAULT_SETTINGS_BASE, reduceMotion: getSystemReducedMotion() };
}

export function readStoredSettings(): AccessibilitySettings {
  if (typeof window === 'undefined') return getDefaultSettings();
  try {
    const raw = window.localStorage.getItem(A11Y_STORAGE_KEY);
    if (!raw) return getDefaultSettings();
    const parsed = JSON.parse(raw) as Partial<AccessibilitySettings>;
    return {
      textScale: clampTextScale(parsed.textScale),
      contrast: isContrast(parsed.contrast) ? parsed.contrast : 'normal',
      grayscale: !!parsed.grayscale,
      underlineLinks: !!parsed.underlineLinks,
      readableFont: !!parsed.readableFont,
      largeCursor: !!parsed.largeCursor,
      reduceMotion: typeof parsed.reduceMotion === 'boolean' ? parsed.reduceMotion : getSystemReducedMotion(),
    };
  } catch {
    return getDefaultSettings();
  }
}
