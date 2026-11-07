import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'native', 'windows');
const venv = path.join(source, '.venv');
const output = path.join(root, 'build', 'python-runtime');
const work = path.join(source, '.pyinstaller');
const check = process.argv.includes('--check');
const windows = process.platform === 'win32';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function findPython312() {
  const candidates = windows
    ? [['py', ['-3.12']], ['python3.12', []], ['python', []]]
    : [['python3.12', []], ['python3', []]];
  for (const [command, args] of candidates) {
    const version = capture(command, [...args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])']);
    if (version === '3.12') return { command, args };
  }
  const uvPython = capture('uv', ['python', 'find', '3.12']);
  if (uvPython) return { command: uvPython, args: [] };
  throw new Error('Python 3.12 was not found. Install it (for example: uv python install 3.12) and run again.');
}

if (!windows) {
  console.error('OmniAgent.Runtime.exe is a Windows binary; build it on Windows.');
  process.exit(1);
}

const venvPython = path.join(venv, 'Scripts', 'python.exe');
if (!fs.existsSync(venvPython)) {
  const python = findPython312();
  run(python.command, [...python.args, '-m', 'venv', venv]);
}
run(venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
run(venvPython, ['-m', 'pip', 'install', '--quiet', '-r', path.join(source, 'requirements-build.txt')]);

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const collected = ['requests', 'bs4', 'PIL', 'psutil', 'openpyxl', 'docx', 'pptx', 'pypdf', 'pywinauto', 'comtypes'];
const hidden = ['win32api', 'win32con', 'win32gui', 'win32process', 'win32clipboard', 'win32com', 'win32com.client', 'win32com.shell', 'win32com.shell.shell', 'win32com.shell.shellcon', 'win32timezone', 'pythoncom', 'pywintypes'];
run(venvPython, [
  '-m', 'PyInstaller',
  '--noconfirm', '--clean', '--onefile', '--console',
  '--name', 'OmniAgent.Runtime',
  '--distpath', output,
  '--workpath', path.join(work, 'work'),
  '--specpath', path.join(work, 'spec'),
  '--paths', source,
  ...collected.flatMap((name) => ['--collect-all', name]),
  ...hidden.flatMap((name) => ['--hidden-import', name]),
  path.join(source, 'main.py')
], { cwd: source });
fs.rmSync(work, { recursive: true, force: true });

const executable = path.join(output, 'OmniAgent.Runtime.exe');
if (!fs.existsSync(executable)) throw new Error('PyInstaller finished but the executable is missing.');
console.log(`Built ${path.relative(root, executable)} (${(fs.statSync(executable).size / 1024 / 1024).toFixed(1)} MB).`);

if (check) {
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  let answer = '';
  child.stdout.on('data', (chunk) => { answer += chunk; });
  child.stdin.write(JSON.stringify({ id: 'health-1', method: 'health', params: {} }) + '\n');
  child.stdin.end();
  child.on('exit', (code) => {
    const line = answer.split('\n').find((item) => item.includes('"health-1"'));
    if (!line) {
      console.error(`The runtime did not answer the health request (exit ${code}).`);
      process.exit(1);
    }
    console.log(`Health: ${line.trim()}`);
  });
}
