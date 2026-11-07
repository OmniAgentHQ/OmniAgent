// Compiles the macOS automation helper as one universal binary, so the same file is correct in both
// the Intel and the Apple Silicon package. The arm64 slice cannot be run on an Intel build machine.
// No -g: the helper carries no debug info, and with it no build-machine paths.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

if (process.platform !== 'darwin') {
  process.stdout.write('Skipped the automation helper: it is only built on macOS.\n');
  process.exit(0);
}

const source = path.resolve('native', 'macos', 'OmniAgentHelper.m');
const output = path.resolve('build', 'OmniAgentHelper');

execFileSync('clang', [
  '-arch', 'x86_64',
  '-arch', 'arm64',
  '-fobjc-arc',
  '-O2',
  '-mmacosx-version-min=13.0',
  '-framework', 'Foundation',
  '-framework', 'ApplicationServices',
  '-framework', 'CoreGraphics',
  '-framework', 'AppKit',
  '-framework', 'ScreenCaptureKit',
  source,
  '-o', output
], { stdio: 'inherit' });

process.stdout.write(`Built ${path.relative(process.cwd(), output)} (x86_64 + arm64, ${Math.round(fs.statSync(output).size / 1024)} KB).\n`);
