// The macOS counterpart to build-icon.mjs: turns the 1024px master into build/icon.icns (the app
// bundle's icon) and build/icon-dock.png (the Dock icon for dev runs, which have no bundle).
// Uses only tools that ship with macOS, so it adds no dependency.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

if (process.platform !== 'darwin') {
  process.stdout.write('Skipped icon.icns: iconutil only exists on macOS.\n');
  process.exit(0);
}

const master = path.resolve('build', 'icon-mac.png');
const iconset = path.resolve('build', 'icon.iconset');
const sizes = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
];

await fs.rm(iconset, { recursive: true, force: true });
await fs.mkdir(iconset, { recursive: true });
for (const [name, pixels] of sizes) {
  execFileSync('sips', ['-z', String(pixels), String(pixels), master, '--out', path.join(iconset, name)], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.resolve('build', 'icon.icns')]);
await fs.rm(iconset, { recursive: true, force: true });
await fs.copyFile(master, path.resolve('build', 'icon-dock.png'));
process.stdout.write('Created build/icon.icns and build/icon-dock.png from build/icon-mac.png.\n');
