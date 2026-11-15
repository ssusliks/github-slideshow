import { Capacitor } from '@capacitor/core';

/** Thin wrapper over Capacitor so the rest of the game never checks platforms directly. */
export const isNative = (): boolean => Capacitor.isNativePlatform();
export const platformName = (): 'android' | 'ios' | 'web' => Capacitor.getPlatform() as 'android' | 'ios' | 'web';

export interface Lifecycle {
  /** app went to background (or the tab was hidden). Must be synchronous-safe. */
  onPause: () => void;
  onResume: () => void;
  /** Android hardware back button. */
  onBack: () => void;
}

/**
 * Wires app lifecycle. "Pause" is delivered from every available signal (Capacitor App state,
 * visibilitychange, pagehide) because none of them is reliable alone on all devices.
 */
export async function installLifecycle(l: Lifecycle): Promise<void> {
  let paused = false;
  const pause = () => { if (!paused) { paused = true; l.onPause(); } };
  const resume = () => { if (paused) { paused = false; l.onResume(); } };
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? pause() : resume()));
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', resume);
  if (isNative()) {
    try {
      const { App } = await import('@capacitor/app');
      await App.addListener('appStateChange', (s) => (s.isActive ? resume() : pause()));
      await App.addListener('backButton', () => l.onBack());
    } catch (e) {
      console.warn('App plugin unavailable', e);
    }
  }
}

export async function nativePreferences(): Promise<any | null> {
  if (!isNative()) return null;
  try { return (await import('@capacitor/preferences')).Preferences; } catch { return null; }
}

let hapticsMod: any = null;
/** Short vibration; silently does nothing where unsupported. */
export function vibrate(kind: 'light' | 'medium' | 'heavy' = 'light'): void {
  try {
    if (isNative()) {
      if (!hapticsMod) { import('@capacitor/haptics').then((m) => { hapticsMod = m; }).catch(() => undefined); return; }
      const style = kind === 'heavy' ? hapticsMod.ImpactStyle.Heavy : kind === 'medium' ? hapticsMod.ImpactStyle.Medium : hapticsMod.ImpactStyle.Light;
      hapticsMod.Haptics.impact({ style }).catch(() => undefined);
    } else if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(kind === 'heavy' ? 40 : kind === 'medium' ? 20 : 10);
    }
  } catch { /* haptics are optional */ }
}

export function exitApp(): void {
  if (isNative()) import('@capacitor/app').then((m) => m.App.exitApp()).catch(() => undefined);
}

/** Custom native plugin (android/app/.../AppIntegrityPlugin.java); absent on web/iOS. */
export function integrityPlugin(): { getInfo(): Promise<{ signature: string; installer: string; debuggable: boolean }>; getThermal(): Promise<{ status: number }> } | null {
  const p = (Capacitor as any).Plugins?.AppIntegrity;
  return isNative() && platformName() === 'android' && p ? p : null;
}
