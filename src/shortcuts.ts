export const IS_MAC = window.omni?.platform === 'darwin';

export const MOD = IS_MAC ? '⌘' : 'Ctrl';

export type Shortcut = { keys: string[]; label: string };

export const SHORTCUT_GROUPS: Array<{ title: string; items: Shortcut[] }> = [
  {
    title: 'Writing a prompt',
    items: [
      { keys: [MOD, 'K'], label: 'Jump to the prompt box' },
      { keys: ['@'], label: 'Choose an agent while typing' },
      { keys: ['Enter'], label: 'Send' },
      { keys: ['Shift', 'Enter'], label: 'New line' },
      { keys: [MOD, '.'], label: 'Stop every agent that is working' }
    ]
  },
  {
    title: 'Projects and tabs',
    items: [
      { keys: [MOD, 'N'], label: 'New project' },
      { keys: [MOD, 'O'], label: 'Open this project’s folder' },
      { keys: ['Ctrl', 'Tab'], label: 'Next tab' },
      { keys: ['Ctrl', 'Shift', 'Tab'], label: 'Previous tab' },
      { keys: [MOD, '1–9'], label: 'Go to tab 1–9' },
      { keys: [MOD, 'W'], label: 'Close this tab' }
    ]
  },
  {
    title: 'Moving around',
    items: [
      { keys: [IS_MAC ? '⌘' : 'Alt', '←'], label: 'Go back' },
      { keys: [IS_MAC ? '⌘' : 'Alt', '→'], label: 'Go forward' },
      { keys: [MOD, 'B'], label: 'Show or hide the projects panel' },
      { keys: [MOD, ','], label: 'Settings' },
      { keys: [MOD, 'Shift', 'A'], label: 'Your AI accounts' },
      { keys: [MOD, 'Shift', 'D'], label: 'Switch dark mode' },
      { keys: ['Esc'], label: 'Close a menu or window' }
    ]
  }
];

export function focusPrompt() {
  for (const delay of [30, 200, 500]) {
    window.setTimeout(() => {
      const area = document.querySelector<HTMLTextAreaElement>('.editor textarea');
      if (area && document.activeElement !== area && !document.querySelector('.modal-backdrop')) area.focus();
    }, delay);
  }
}
