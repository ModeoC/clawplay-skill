/**
 * stage.js — Stages bundled skill files for GitHub distribution.
 *
 * Reads esbuild output from build/ and produces a flat staged/ directory:
 *   staged/
 *   ├── SKILL.md              ← skill instructions (rewritten from source)
 *   ├── HEARTBEAT.md          ← heartbeat routine
 *   ├── clawplay-listener.js  ← self-contained bundle
 *   ├── clawplay-cli.js       ← self-contained bundle
 *   └── clawplay-config.json  ← default config
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STAGED = join(ROOT, 'staged');

// 1. Clean and create staging directory
rmSync(STAGED, { recursive: true, force: true });
mkdirSync(STAGED, { recursive: true });

// 2. Copy bundled executables (fail fast if build/ is missing)
for (const file of ['clawplay-listener.js', 'clawplay-cli.js']) {
  const src = join(ROOT, 'build', file);
  if (!existsSync(src)) {
    console.error(`Missing build artifact: ${src}\nRun "npm run bundle" first.`);
    process.exit(1);
  }
  copyFileSync(src, join(STAGED, file));
}

// 3. Generate default config (agents override this for multi-agent setups)
writeFileSync(join(STAGED, 'clawplay-config.json'),
  JSON.stringify({ apiKeyEnvVar: 'CLAWPLAY_API_KEY_PRIMARY', listenerMode: 'lobby', reflectEveryNHands: 3, maxSessionsPerDay: 2, maxHandsPerDay: 40, paused: false, suppressedSignals: ['DECISION_STATUS'], tableChat: { reactive: true } }, null, 2) + '\n');

// 4. Copy and rewrite poker SKILL.md
let skill = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');

// Rewrite dist/ references to bare filenames (bundled files live alongside SKILL.md)
skill = skill.replace(/dist\/clawplay-listener\.js/g, 'clawplay-listener.js');
skill = skill.replace(/dist\/clawplay-cli\.js/g, 'clawplay-cli.js');

// Remove the "Note: compile first" line (not needed for pre-bundled distribution)
skill = skill.replace(/\n\n\*\*Note:\*\* The game loop must be compiled first\.[^\n]*\n/, '\n');

writeFileSync(join(STAGED, 'SKILL.md'), skill);

// 4b. Copy HEARTBEAT.md (self-contained heartbeat routine — no rewriting needed)
copyFileSync(join(ROOT, 'HEARTBEAT.md'), join(STAGED, 'HEARTBEAT.md'));

// 4c. Copy start-listener.sh (listener launch wrapper)
copyFileSync(join(ROOT, 'start-listener.sh'), join(STAGED, 'start-listener.sh'));

// 5. Summary
const files = ['SKILL.md', 'HEARTBEAT.md', 'clawplay-listener.js', 'clawplay-cli.js', 'clawplay-config.json', 'start-listener.sh'];
console.log('Staged skill to staged/:');
for (const f of files) console.log(`  ${f}`);
