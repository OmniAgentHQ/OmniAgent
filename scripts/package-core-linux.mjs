// Builds the OmniAgent Core Linux installer, Installers/OmniAgent-Linux.sh.
//
// It's one self-extracting script: linux-installer.sh with the packed app appended. The ChatGPT and
// Claude engines aren't in it, because the installer fetches the latest ones on the user's computer.
//
// better-sqlite3 is compiled here because its published Electron 43 builds need glibc 2.41. The
// linux-glibc-compat files keep this build loadable back to glibc 2.28, and the checks at the end
// refuse to ship anything that drifted past that or carries this machine's paths.

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = path.join(root, 'scripts');
const unpacked = path.join(root, 'release', 'core', 'linux-unpacked');
const output = path.join(root, 'Installers', 'OmniAgent-Linux.sh');
const sqliteBuild = path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release');

const GLIBC_FLOOR = '2.28';
const WRAPPED_CALLS = ['stat64', 'fstat64', 'lstat64', 'pthread_once'];

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

function compilePortableSqlite() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omniagent-compat-'));
  try {
    const object = path.join(temporary, 'compat.o');
    run('gcc', ['-O2', '-fPIC', '-c', path.join(scripts, 'linux-glibc-compat.c'), '-o', object]);
    run(process.execPath, [path.join(scripts, 'rebuild-native.mjs')], {
      CPPFLAGS: `-include ${path.join(scripts, 'linux-glibc-compat.h')} -ffile-prefix-map=${root}=.`,
      LDFLAGS: `${object} -Wl,--wrap=${WRAPPED_CALLS.join(',--wrap=')} -static-libstdc++ -static-libgcc -Wl,--exclude-libs,ALL`
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  run('strip', ['--strip-unneeded', path.join(sqliteBuild, 'better_sqlite3.node')]);
}

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

function isElf(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(4);
    return fs.readSync(descriptor, header, 0, 4, 0) === 4 && header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally {
    fs.closeSync(descriptor);
  }
}

function newerVersion(left, right) {
  const [a, b] = [left, right].map((version) => version.split('.').map(Number));
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

function refuseNewerGlibc(files) {
  for (const file of files.filter(isElf)) {
    const symbols = execFileSync('objdump', ['-T', file], { encoding: 'utf8', maxBuffer: 256 * 1_048_576 });
    for (const [, version] of symbols.matchAll(/GLIBC_(\d[\d.]*)/g)) {
      if (newerVersion(version, GLIBC_FLOOR)) throw new Error(`${path.relative(unpacked, file)} needs glibc ${version}. Stopping before this ships.`);
    }
    if (file.endsWith('better_sqlite3.node') && /GLIBCXX_/.test(symbols)) throw new Error('better-sqlite3 still needs the system libstdc++. Stopping before this ships.');
  }
}

function refuseMachinePaths(files) {
  // The trailing slash matters: docs inside dependencies mention paths like /home/user1.
  const markers = [root, os.homedir()].map((text) => Buffer.from(`${text}/`));
  for (const file of files) {
    const contents = fs.readFileSync(file);
    if (markers.some((marker) => contents.includes(marker))) throw new Error(`${path.relative(unpacked, file)} contains a path from this machine. Stopping before this ships.`);
  }
}

function packApp() {
  const archive = path.join(os.tmpdir(), `omniagent-core-${process.pid}.tar.gz`);
  // The numeric owner keeps this machine's user name out of the archive, and gzip -n its timestamps.
  execFileSync('sh', ['-c', 'tar -C "$1" --sort=name --owner=0 --group=0 --numeric-owner --transform "s,^linux-unpacked,app," -cf - linux-unpacked | gzip -9n > "$2"', 'sh', path.dirname(unpacked), archive], { stdio: 'inherit' });
  return archive;
}

function writeInstaller(archive, files) {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const payload = fs.readFileSync(archive);
  const appBytes = files.reduce((total, file) => total + fs.statSync(file).size, 0);
  const script = fs.readFileSync(path.join(scripts, 'linux-installer.sh'), 'utf8')
    .replace('@@APP_VERSION@@', version)
    .replace('@@PAYLOAD_BYTES@@', String(payload.length))
    .replace('@@PAYLOAD_SHA256@@', crypto.createHash('sha256').update(payload).digest('hex'))
    .replace('@@APP_KB@@', String(Math.ceil(appBytes / 1024)));
  if (script.includes('@@')) throw new Error('The installer template has an unfilled value.');

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, Buffer.concat([Buffer.from(script), payload]), { mode: 0o755 });
  fs.chmodSync(output, 0o755);
}

if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('The Linux installer can only be built on 64-bit Linux.');

run('npm', ['run', 'build']);
compilePortableSqlite();
run('npx', ['electron-builder', '--config', 'electron-builder.json', '--linux', 'dir', '--x64', '-c.npmRebuild=false']);

const files = filesUnder(unpacked);
refuseNewerGlibc(files);
refuseMachinePaths(files);

const archive = packApp();
try {
  writeInstaller(archive, files);
} finally {
  fs.rmSync(archive, { force: true });
}
console.log(`=== Done: Installers/${path.basename(output)} (${Math.round(fs.statSync(output).size / 1_048_576)} MB) ===`);
