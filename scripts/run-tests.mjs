import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { createHermeticTestEnvironment } from './test-environment.mjs';

const testFiles = readdirSync(new URL('../tests/', import.meta.url))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => `tests/${name}`);

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: new URL('../', import.meta.url),
  env: createHermeticTestEnvironment(),
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
