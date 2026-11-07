// Builds the Windows installer: node scripts/package-windows.mjs gives Installers/OmniAgent-Win64.exe
//
// It is one exe: windows-installer.cs compiled with the C# compiler that ships with Windows, with the
// packed app appended. The engines aren't in it, because the installer fetches the latest ones on the
// user's computer.
//
// The checks at the end refuse to ship anything from outside the app or anything that carries this
// machine's paths. Set OMNI_PRIVATE_TERMS to a comma separated list to refuse more words, such as a name.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import * as asar from '@electron/asar';
import { installElectronSqlite } from './setup-native.mjs';
import yazl from 'yazl';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = path.join(root, 'scripts');
const productName = 'OmniAgent Core';
const unpacked = path.join(root, 'release', 'core', 'win-unpacked');
const output = path.join(root, 'Installers', 'OmniAgent-Win64.exe');
const preview = process.argv.includes('--preview');

const FRAMEWORK = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const REFERENCES = ['System.dll', 'System.Core.dll', 'System.Xaml.dll', 'System.Web.Extensions.dll', 'System.IO.Compression.dll', 'WPF\\PresentationCore.dll', 'WPF\\PresentationFramework.dll', 'WPF\\WindowsBase.dll'];

const NOT_THE_APP = [/(^|[\\/])\.claude([\\/]|$)/i, /(^|[\\/])website([\\/]|$)/i, /(^|[\\/])promo([\\/]|$)/i, /(^|[\\/])Installers([\\/]|$)/i, /omniagent-project/i, /(^|[\\/])\.env/i, /(^|[\\/])\.git([\\/]|$)/i, /\.DS_Store$/i, /(^|[\\/])@anthropic-ai([\\/]|$)/i, /(^|[\\/])@openai([\\/]|$)/i, /\.map$/i, /\.tsbuildinfo$/i];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

function buildApp() {
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'dist-electron'), { recursive: true, force: true });
  fs.rmSync(unpacked, { recursive: true, force: true });
  run('npm', ['run', 'build'], { shell: true });
  run(process.execPath, [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--config', 'electron-builder.json', '--win', 'dir', '--x64', '-c.npmRebuild=false'], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
}

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

function refuseStrayFiles(names) {
  const strays = names.filter((name) => NOT_THE_APP.some((pattern) => pattern.test(name)));
  if (strays.length) throw new Error(`The app contains files it shouldn't:\n  ${strays.slice(0, 20).join('\n  ')}`);
}

function refuseMissingFiles(names) {
  const has = (ending) => names.some((name) => name.replaceAll('\\', '/').endsWith(ending));
  for (const required of [`${productName}.exe`, 'resources/app.asar', 'resources/icon.ico', 'resources/OmniAgent.Runtime.exe', 'resources/input-helper.ps1', 'better_sqlite3.node']) {
    if (!has(required)) throw new Error(`The app is missing ${required}.`);
  }
}

function machinePaths() {
  const paths = [root, os.homedir()].flatMap((text) => [`${text}\\`, `${text.replaceAll('\\', '/')}/`, `${text.replaceAll('\\', '\\\\')}\\\\`]);
  return paths.flatMap((text) => [Buffer.from(text), Buffer.from(text.toLowerCase()), Buffer.from(text, 'utf16le')]);
}

// Whole words only, so ordinary identifiers in Electron's own code don't trip the check.
function privateWords() {
  const words = (process.env.OMNI_PRIVATE_TERMS ?? '').split(',').map((word) => word.trim()).filter(Boolean);
  return words.flatMap((word) => {
    const letters = [...word].map((letter) => letter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return [
      new RegExp(`(?<![A-Za-z0-9_])${letters.join('')}(?![A-Za-z0-9_])`, 'i'),
      new RegExp(`(?<![A-Za-z0-9_]\\x00)${letters.join('\\x00')}\\x00(?![A-Za-z0-9_])`, 'i')
    ];
  });
}

function refuseMachineDetails(files, labels = (file) => path.relative(unpacked, file)) {
  const paths = machinePaths();
  const words = privateWords();
  for (const file of files) {
    const contents = fs.readFileSync(file);
    const hit = paths.find((marker) => contents.includes(marker));
    if (hit) throw new Error(`${labels(file)} contains "${hit.toString('latin1').replaceAll('\0', '')}". Stopping before this ships.`);
    const text = words.length ? contents.toString('latin1') : '';
    const match = words.map((word) => text.match(word)).find(Boolean);
    if (match) throw new Error(`${labels(file)} contains "${match[0].replaceAll('\0', '')}" near "${text.slice(Math.max(0, match.index - 40), match.index + 40).replace(/[^\x20-\x7e]/g, '.')}". Stopping before this ships.`);
  }
}

function inspectApp(temporary) {
  const files = filesUnder(unpacked);
  const names = files.map((file) => path.relative(unpacked, file));
  const archive = path.join(unpacked, 'resources', 'app.asar');
  const packed = asar.listPackage(archive).map((name) => name.replace(/^[\\/]/, ''));
  refuseMissingFiles(names);
  refuseStrayFiles([...names, ...packed]);

  const contents = path.join(temporary, 'asar');
  asar.extractAll(archive, contents);
  refuseMachineDetails(files);
  refuseMachineDetails(filesUnder(contents), (file) => `app.asar: ${path.relative(contents, file)}`);

  return files;
}

// A fixed time and sorted names mean the same app always packs to the same bytes.
async function packApp(files, target) {
  const zip = new yazl.ZipFile();
  const zipped = pipeline(zip.outputStream, fs.createWriteStream(target));
  const time = new Date(2026, 0, 1);
  for (const file of [...files].sort()) {
    zip.addFile(file, path.relative(unpacked, file).replaceAll('\\', '/'), { mtime: time, mode: 0o644, compress: true, compressionLevel: 9 });
  }
  zip.end();
  await zipped;
}

function compileInstaller(temporary, version) {
  const source = path.join(temporary, 'installer.cs');
  const template = fs.readFileSync(path.join(scripts, 'windows-installer.cs'), 'utf8').replaceAll('@@APP_VERSION@@', version);
  if (template.includes('@@')) throw new Error('The installer template has an unfilled value.');
  fs.writeFileSync(source, template);

  const program = path.join(temporary, 'installer.exe');
  run(path.join(FRAMEWORK, 'csc.exe'), [
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/debug-', '/warnaserror-',
    ...(preview ? ['/define:PREVIEW'] : []),
    `/out:${program}`,
    `/win32icon:${path.join(root, 'build', 'icon.ico')}`,
    `/win32manifest:${path.join(scripts, 'windows-installer.manifest')}`,
    `/resource:${path.join(root, 'build', 'icon.png')},logo.png`,
    `/resource:${path.join(scripts, 'windows-installer.xaml')},windows-installer.xaml`,
    ...REFERENCES.map((reference) => `/reference:${path.join(FRAMEWORK, reference)}`),
    source
  ]);
  return program;
}

async function joinInstaller(program, archive, target) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
  const footer = Buffer.alloc(48);
  footer.writeBigInt64LE(BigInt(fs.statSync(archive).size), 0);
  hash.digest().copy(footer, 8);
  footer.write('OMNIPACK', 40, 'ascii');

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const writer = fs.createWriteStream(target);
  writer.write(fs.readFileSync(program));
  for await (const chunk of fs.createReadStream(archive)) {
    if (!writer.write(chunk)) await new Promise((resolve) => writer.once('drain', resolve));
  }
  writer.end(footer);
  await new Promise((resolve, reject) => { writer.once('finish', resolve); writer.once('error', reject); });
}

if (process.platform !== 'win32') throw new Error('The Windows installer can only be built on Windows.');

const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omniagent-installer-'));
try {
  if (preview) {
    // Compiles just the window, with a switch that saves each state as a picture.
    const program = compileInstaller(temporary, version);
    const target = path.join(root, 'release', 'core', 'installer-preview.exe');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(program, target);
    console.log(`=== Done: ${path.relative(root, target)} ===`);
  } else {
    run('npm', ['run', 'build:icon'], { shell: true });
    await installElectronSqlite();
    buildApp();
    const files = inspectApp(temporary);
    const archive = path.join(temporary, 'app.zip');
    await packApp(files, archive);
    const program = compileInstaller(temporary, version);
    refuseMachineDetails([program], () => 'The installer program');
    await joinInstaller(program, archive, output);
    console.log(`=== Done: Installers/${path.basename(output)} (${Math.round(fs.statSync(output).size / 1_048_576)} MB) ===`);
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
