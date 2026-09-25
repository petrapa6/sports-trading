// Pre-commit secret scan (run by lefthook from the repository root).
//
// 1. Refuses staged files that must never be committed, even when force-added
//    (keys, PEMs, local config, databases, .env files).
// 2. Runs `gitleaks` on the staged changes with the repository's .gitleaks.toml.
//    If gitleaks is not installed, falls back to a built-in private-key scan and
//    says so; CI always runs the real gitleaks.
import { execFileSync, spawnSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const root = git('rev-parse', '--show-toplevel').trim();
process.chdir(root);

const staged = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean);

const FORBIDDEN = [
  /(^|\/)config\.local\.json$/,
  /\.(key|pem)$/,
  /\.db($|[-.])/,
  /(^|\/)\.env($|\.)/,
  /(^|\/)\.local\//,
];
const forbidden = staged.filter((f) => FORBIDDEN.some((re) => re.test(f)));
if (forbidden.length > 0) {
  console.error(
    `secret-scan: refusing to commit files that must stay out of git:\n  ${forbidden.join('\n  ')}`,
  );
  process.exit(1);
}

const hasGitleaks = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).status === 0;
if (hasGitleaks) {
  const r = spawnSync(
    'gitleaks',
    ['git', '--pre-commit', '--staged', '--redact', '--no-banner', '--config', '.gitleaks.toml', '.'],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) {
    console.error('secret-scan: gitleaks found a potential secret; commit rejected.');
    process.exit(1);
  }
  process.exit(0);
}

console.warn(
  'secret-scan: gitleaks is not installed (see README); using the built-in private-key check only.',
);
const PEM = /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY( BLOCK)?-----/;
const ALLOW = [/^SPEC\.md$/];
const hits = [];
for (const file of staged) {
  if (ALLOW.some((re) => re.test(file))) continue;
  let content;
  try {
    content = git('show', `:${file}`);
  } catch {
    continue;
  }
  if (PEM.test(content)) hits.push(file);
}
if (hits.length > 0) {
  console.error(`secret-scan: private key material found in:\n  ${hits.join('\n  ')}`);
  process.exit(1);
}
