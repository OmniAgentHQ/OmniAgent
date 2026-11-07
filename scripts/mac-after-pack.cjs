// Signs the packaged Mac app with the OmniAgent certificate, before electron-builder wraps it in a DMG.
//
// electron-builder can't do this itself: it only accepts trusted identities, and this self-signed one
// needs no trust to sign. Its afterSign hook is skipped when it didn't sign, so this has to be afterPack.
// The certificate is loaded into a throwaway keychain, so the login keychain and system trust stay untouched.
//
// It also refuses to finish if any native file can't run on the target CPU, because a Silicon build
// made on an Intel Mac can't be launched here to find that out.

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Arch } = require('builder-util');

const SIGNING_DIR = process.env.OMNIAGENT_SIGNING_DIR || path.join(os.homedir(), 'Desktop', 'OmniAgent-Signing');
const CPU_TYPES = { x64: 0x01000007, arm64: 0x0100000c };
const FAT_MAGIC = 0xcafebabe;
const THIN_MAGIC = 0xfeedfacf;
const LINKED_FILE_TYPES = new Set([2, 6, 8]); // executable, dylib, bundle. Skips stray .o files.

// Errors name the step, never the arguments, because some arguments are passwords.
function run(command, args, label = args[0]) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (failure) {
    throw new Error(`${command} ${label} failed: ${String(failure.stderr ?? '').trim()}`);
  }
}

function machOCpuTypes(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(128);
    if (fs.readSync(descriptor, header, 0, header.length, 0) < 16) return null;
    if (header.readUInt32BE(0) === FAT_MAGIC) {
      const count = header.readUInt32BE(4);
      if (count === 0 || count > 4) return null; // Java class files share this magic number.
      return Array.from({ length: count }, (_, index) => header.readUInt32BE(8 + index * 20));
    }
    if (header.readUInt32LE(0) !== THIN_MAGIC) return null;
    return LINKED_FILE_TYPES.has(header.readUInt32LE(12)) ? [header.readUInt32LE(4)] : null;
  } finally {
    fs.closeSync(descriptor);
  }
}

function walk(directory, files, bundles) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (/\.(app|framework)$/.test(entry.name)) bundles.push(full);
      walk(full, files, bundles);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
}

// A bundle's main binary is signed along with its bundle, and refuses to be signed alone.
function isBundleMainBinary(file) {
  return /\.app\/Contents\/MacOS\/[^/]+$/.test(file) || /\/([^/]+)\.framework\/Versions\/[^/]+\/\1$/.test(file);
}

function withSigningIdentity(use) {
  const certificate = path.join(SIGNING_DIR, 'OmniAgent-signing.crt');
  const bundle = path.join(SIGNING_DIR, 'OmniAgent-signing.p12');
  const passwordFile = path.join(SIGNING_DIR, 'password.txt');
  for (const file of [certificate, bundle, passwordFile]) {
    if (!fs.existsSync(file)) throw new Error(`Signing file missing: ${path.basename(file)}. Nothing was signed.`);
  }
  const identity = new crypto.X509Certificate(fs.readFileSync(certificate)).fingerprint.replaceAll(':', '');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'omniagent-sign-'));
  const keychain = path.join(folder, 'signing.keychain-db');
  const keychainPassword = crypto.randomBytes(24).toString('hex');
  const searchList = run('security', ['list-keychains', '-d', 'user']).split('\n').map((line) => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
  try {
    run('security', ['create-keychain', '-p', keychainPassword, keychain]);
    run('security', ['set-keychain-settings', keychain]);
    run('security', ['unlock-keychain', '-p', keychainPassword, keychain]);
    run('security', ['import', bundle, '-k', keychain, '-P', fs.readFileSync(passwordFile, 'utf8').trim(), '-T', '/usr/bin/codesign', '-T', '/usr/bin/security']);
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, keychain]);
    run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...searchList]);
    use(identity);
  } finally {
    try {
      run('security', ['list-keychains', '-d', 'user', '-s', ...searchList]);
      run('security', ['delete-keychain', keychain]);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }
}

module.exports = async function signMacApp(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const arch = Arch[context.arch];
  const cpu = CPU_TYPES[arch];
  if (!cpu) throw new Error(`Unexpected Mac architecture: ${arch}`);

  const unpacked = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules');
  for (const required of [path.join('better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), path.join('@napi-rs', `canvas-darwin-${arch}`, `skia.darwin-${arch}.node`)]) {
    if (!fs.existsSync(path.join(unpacked, required))) throw new Error(`Native module missing from the ${arch} app: ${required}`);
  }

  const files = [];
  const bundles = [];
  walk(path.join(app, 'Contents'), files, bundles);

  const loose = [];
  for (const file of files) {
    const cpuTypes = machOCpuTypes(file);
    if (!cpuTypes) continue;
    if (!cpuTypes.includes(cpu)) throw new Error(`${path.relative(app, file)} can't run on ${arch}. Stopping before this ships.`);
    if (!isBundleMainBinary(file)) loose.push(file);
  }

  withSigningIdentity((identity) => {
    const sign = (target) => run('codesign', ['--force', '--timestamp=none', '--sign', identity, target], path.basename(target));
    for (const file of loose) sign(file);
    for (const bundle of bundles.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)) sign(bundle);
    sign(app);
  });
  run('codesign', ['--verify', '--deep', '--strict', app], 'verify');
  console.log(`  • signed ${arch} app as OmniAgent Developers (${loose.length} native files, ${bundles.length} bundles)`);
};
