import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
const env = { ...process.env };

if (process.platform === 'win32') {
  env.CL = [env.CL, `/d1trimfile:"${path.join(root, 'node_modules', 'better-sqlite3')}"`].filter(Boolean).join(' ');
  env._LINK_ = [env._LINK_, '/PDBALTPATH:%_PDB%'].filter(Boolean).join(' ');
}

const result = spawnSync(process.execPath, [cli, '-f', '-w', 'better-sqlite3'], { stdio: 'inherit', env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
