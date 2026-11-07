// Runs after npm install. The app runs on Electron, not Node, so better-sqlite3 needs the build made
// for Electron rather than the one npm just installed.
//
// Windows: better-sqlite3 12.11.1 has no Electron 43 build, so this fetches the 12.11.2 one. It's the
// same code with those builds added, and it's on GitHub but not npm, so its checksum is pinned here.
// macOS and Linux: @electron/rebuild compiles it, which needs a C++ compiler.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQLITE_ABI = '148';
const SQLITE_URL = `https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.2/better-sqlite3-v12.11.2-electron-v${SQLITE_ABI}-win32-x64.tar.gz`;
const SQLITE_SHA256 = 'd97ef08db295d22ebe429468f896814c641ec016fef82aac76cf6f11988511bc';

export async function installElectronSqlite() {
  const abi = fs.readFileSync(path.join(root, 'node_modules', 'electron', 'abi_version'), 'utf8').trim();
  if (abi !== SQLITE_ABI) throw new Error(`Electron's ABI is ${abi}, and the pinned better-sqlite3 is for ${SQLITE_ABI}. Update the pin in scripts/setup-native.mjs.`);

  const response = await fetch(SQLITE_URL);
  if (!response.ok) throw new Error(`better-sqlite3 could not be downloaded (${response.status}).`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha256').update(archive).digest('hex') !== SQLITE_SHA256) throw new Error('better-sqlite3 failed its checksum check.');

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omniagent-sqlite-'));
  try {
    const file = path.join(temporary, 'sqlite.tar.gz');
    fs.writeFileSync(file, archive);
    const tar = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe');
    const unpacked = spawnSync(tar, ['-xzf', file, '-C', temporary], { stdio: 'inherit' });
    if (unpacked.error) throw unpacked.error;
    if (unpacked.status !== 0) throw new Error('better-sqlite3 could not be unpacked.');
    const release = path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release');
    fs.mkdirSync(release, { recursive: true });
    fs.copyFileSync(path.join(temporary, 'build', 'Release', 'better_sqlite3.node'), path.join(release, 'better_sqlite3.node'));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform === 'win32' && process.arch === 'x64') {
    await installElectronSqlite();
    console.log('better-sqlite3 is ready for Electron.');
  } else {
    const rebuilt = spawnSync(process.execPath, [path.join(root, 'scripts', 'rebuild-native.mjs')], { stdio: 'inherit' });
    if (rebuilt.status !== 0) process.exit(rebuilt.status ?? 1);
  }
}
