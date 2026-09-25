/**
 * `npm run dev`: validates the configuration first (so a bad setting exits non-zero
 * immediately instead of leaving a watcher waiting), then runs the server under
 * `tsx watch` for reload-on-save. Only the server's JSON log lines reach stdout.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadConfigOrExit } from '../src/server/boot.js';

loadConfigOrExit();

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');

const child = spawn(process.execPath, [tsxCli, 'watch', '--clear-screen=false', 'src/server/main.ts'], {
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
