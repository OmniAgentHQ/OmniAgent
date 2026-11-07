export type PermissionState = 'granted' | 'denied' | 'unknown';

export type LinuxPermissionReport = {
  platform: 'linux';
  accessibility: PermissionState;
  screenRecording: PermissionState;
  blockedTools: string[];
  detail?: string;
};

export type LinuxPermissionStatus = {
  route: string;
  granted: boolean;
  needsGrant: boolean;
  capture: string;
  detail?: string;
};

const POINTER_TOOLS = ['click_element', 'scroll_page'];
const KEYBOARD_TOOLS = ['type_text', 'press_key'];
const SCREEN_TOOLS = ['read_screen', 'take_screenshot'];

export function reportFromStatus(status: LinuxPermissionStatus | null): LinuxPermissionReport {
  if (!status || !status.route) {
    return {
      platform: 'linux',
      accessibility: 'unknown',
      screenRecording: 'unknown',
      blockedTools: [...POINTER_TOOLS, ...KEYBOARD_TOOLS, ...SCREEN_TOOLS]
    };
  }
  if (status.route !== 'portal') {
    return { platform: 'linux', accessibility: 'granted', screenRecording: 'granted', blockedTools: [] };
  }
  const granted = status.granted;
  return {
    platform: 'linux',
    accessibility: granted ? 'granted' : 'denied',
    screenRecording: status.capture === 'portal' && granted ? 'granted' : granted ? 'unknown' : 'denied',
    blockedTools: granted ? [] : [...POINTER_TOOLS, ...KEYBOARD_TOOLS, ...SCREEN_TOOLS],
    ...(status.detail ? { detail: status.detail } : {})
  };
}
