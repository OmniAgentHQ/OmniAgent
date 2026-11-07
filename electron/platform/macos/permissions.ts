import { systemPreferences, shell, desktopCapturer } from 'electron';

export type PermissionState = 'granted' | 'denied' | 'unknown';

export type PermissionReport = {
  platform: 'macos';
  accessibility: PermissionState;
  screenRecording: PermissionState;
  blockedTools: string[];
};

const ACCESSIBILITY_TOOLS = ['click_element', 'type_text', 'press_key', 'scroll_page', 'focus_window'];
const SCREEN_TOOLS = ['read_screen', 'take_screenshot'];

export function accessibilityGranted() {
  return systemPreferences.isTrustedAccessibilityClient(false);
}

export function screenRecordingState(): PermissionState {
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'granted') return 'granted';
  if (status === 'denied' || status === 'restricted') return 'denied';
  return 'unknown';
}

export function permissionReport(): PermissionReport {
  const accessibility = accessibilityGranted();
  const screenRecording = screenRecordingState();
  return {
    platform: 'macos',
    accessibility: accessibility ? 'granted' : 'denied',
    screenRecording,
    blockedTools: [
      ...(accessibility ? [] : ACCESSIBILITY_TOOLS),
      ...(screenRecording === 'granted' ? [] : SCREEN_TOOLS)
    ]
  };
}

export function requestAccessibility() {
  return systemPreferences.isTrustedAccessibilityClient(true);
}

export async function requestScreenRecording() {
  try {
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  } catch {
  }
  return screenRecordingState();
}

export function openPermissionSettings(which: 'accessibility' | 'screenRecording') {
  const pane = which === 'accessibility'
    ? 'com.apple.preference.security?Privacy_Accessibility'
    : 'com.apple.preference.security?Privacy_ScreenCapture';
  return shell.openExternal(`x-apple.systempreferences:${pane}`);
}
