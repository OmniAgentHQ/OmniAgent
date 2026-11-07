// Builds the OmniAgent Core DMGs into Installers/, one at a time.
//
// Silicon goes first so Intel is the last build: each one recompiles better-sqlite3 in node_modules.
// Run it through taskpolicy (see package:core:mac), and it waits for the machine to settle between builds.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canvasFolder = path.join(root, 'node_modules', '@napi-rs');
const parkedFolder = path.join(root, 'node_modules', '.parked-canvas');
const installers = path.join(root, 'Installers');

const BUILDS = [
  { arch: 'arm64', other: 'x64', flag: '--arm64', file: 'OmniAgent-Mac-Silicon.dmg' },
  { arch: 'x64', other: 'arm64', flag: '--x64', file: 'OmniAgent-Mac-Intel.dmg' }
];

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

async function waitForQuietMachine() {
  await sleep(15_000);
  for (let waited = 0; os.loadavg()[0] > 4 && waited < 24; waited += 1) await sleep(10_000);
}

// npm only installs the canvas package for the CPU it's running on, so Silicon's is fetched directly.
function fetchCanvas(arch) {
  const target = path.join(canvasFolder, `canvas-darwin-${arch}`);
  if (fs.existsSync(target)) return;
  const { version } = JSON.parse(fs.readFileSync(path.join(canvasFolder, 'canvas', 'package.json'), 'utf8'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omniagent-canvas-'));
  try {
    const tarball = execFileSync('npm', ['pack', `@napi-rs/canvas-darwin-${arch}@${version}`, '--pack-destination', temporary, '--silent'], { cwd: temporary, encoding: 'utf8' }).trim().split('\n').pop();
    fs.mkdirSync(target);
    execFileSync('tar', ['-xzf', path.join(temporary, tarball), '-C', target, '--strip-components=1']);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function parkCanvas(arch) {
  const installed = path.join(canvasFolder, `canvas-darwin-${arch}`);
  if (!fs.existsSync(installed)) return;
  fs.mkdirSync(parkedFolder, { recursive: true });
  fs.renameSync(installed, path.join(parkedFolder, arch));
}

function restoreParkedCanvas() {
  if (!fs.existsSync(parkedFolder)) return;
  for (const arch of fs.readdirSync(parkedFolder)) fs.renameSync(path.join(parkedFolder, arch), path.join(canvasFolder, `canvas-darwin-${arch}`));
  fs.rmSync(parkedFolder, { recursive: true, force: true });
}

if (process.platform !== 'darwin') throw new Error('The Mac installers can only be built on macOS.');

restoreParkedCanvas();
fs.mkdirSync(installers, { recursive: true });
run('npm', ['run', 'build']);

for (const [index, build] of BUILDS.entries()) {
  if (index > 0) await waitForQuietMachine();
  console.log(`\n=== Building ${build.file} ===`);
  fetchCanvas(build.arch);
  parkCanvas(build.other);
  try {
    run('npx', ['electron-builder', '--config', 'electron-builder.json', '--mac', 'dmg', build.flag], { CSC_IDENTITY_AUTO_DISCOVERY: 'false', JOBS: '2' });
  } finally {
    restoreParkedCanvas();
  }
  const built = path.join(root, 'release', 'core', `OmniAgent-Core-${build.arch}.dmg`);
  fs.rmSync(path.join(installers, build.file), { force: true });
  fs.renameSync(built, path.join(installers, build.file));
  console.log(`=== Done: Installers/${build.file} (${Math.round(fs.statSync(path.join(installers, build.file)).size / 1_048_576)} MB) ===`);
}

fs.rmSync(path.join(canvasFolder, 'canvas-darwin-arm64'), { recursive: true, force: true });
