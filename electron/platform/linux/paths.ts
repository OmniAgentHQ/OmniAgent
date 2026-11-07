import os from 'node:os';
import { posix as path } from 'node:path';

const WORKSPACE_FOLDER = 'OmniAgent';

export function dataHome(environment: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  const configured = environment.XDG_DATA_HOME?.trim();
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(home, '.local', 'share');
}
