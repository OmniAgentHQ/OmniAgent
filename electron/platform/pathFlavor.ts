import path from 'node:path';

export type PathFlavor = 'win32' | 'posix';

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC = /^\\\\/;

export function pathFlavor(value: string): PathFlavor {
  if (WINDOWS_DRIVE.test(value) || WINDOWS_UNC.test(value)) return 'win32';
  if (value.startsWith('/')) return 'posix';
  return process.platform === 'win32' ? 'win32' : 'posix';
}

export function flavorOf(value: string) {
  return pathFlavor(value) === 'win32' ? path.win32 : path.posix;
}

export function isAbsoluteFlavored(value: string) {
  return flavorOf(value).isAbsolute(value);
}

export function joinFlavored(base: string, ...segments: string[]) {
  return flavorOf(base).join(base, ...segments);
}

export function resolveFlavored(value: string) {
  const flavored = flavorOf(value);
  if (flavored.isAbsolute(value)) return flavored.resolve(value);
  return path.resolve(value);
}
