import fs from 'node:fs';

export function loginShell() {
  const configured = process.env.SHELL?.trim();
  if (configured && fs.existsSync(configured)) return configured;
  const fallbacks = process.platform === 'darwin'
    ? ['/bin/zsh', '/bin/bash', '/bin/sh']
    : ['/bin/bash', '/bin/sh'];
  return fallbacks.find((candidate) => fs.existsSync(candidate)) ?? '/bin/sh';
}

export function shellCommand(command: string) {
  return { executable: loginShell(), args: ['-lc', command] };
}

export function shellScript(scriptPath: string) {
  return { executable: loginShell(), args: ['-l', scriptPath] };
}

export function shellScriptName() {
  return 'program.sh';
}
