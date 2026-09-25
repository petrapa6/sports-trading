// `prepare` script: installs the lefthook git hooks (gitleaks pre-commit) from the repository root.
// Silently does nothing outside a git checkout (e.g. inside the Docker build).
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

let root;
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  process.exit(0);
}

const require = createRequire(import.meta.url);
let exe;
try {
  exe = require('lefthook/get-exe.js').getExePath();
} catch {
  console.warn('lefthook is not installed; git hooks were not installed');
  process.exit(0);
}
const result = spawnSync(exe, ['install'], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
