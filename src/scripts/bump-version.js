/**
 * bump-version.js — Bumps the version in SKILL.md frontmatter and syncs to package.json.
 *
 * Usage: node scripts/bump-version.js [patch|minor|major]
 * Default: patch
 *
 * SKILL.md is the source of truth. After bumping, the new version is written
 * to both SKILL.md and package.json to keep them in sync.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_MD = join(__dirname, '..', 'SKILL.md');
const PKG_JSON = join(__dirname, '..', 'package.json');

const part = process.argv[2] || 'patch';
if (!['patch', 'minor', 'major'].includes(part)) {
  console.error(`Usage: bump-version.js [patch|minor|major] (got "${part}")`);
  process.exit(1);
}

const content = readFileSync(SKILL_MD, 'utf8');
const match = content.match(/^(version:\s*)(\d+\.\d+\.\d+)$/m);
if (!match) {
  console.error('Could not find version: X.Y.Z in SKILL.md frontmatter');
  process.exit(1);
}

const [major, minor, patch_] = match[2].split('.').map(Number);
let newVersion;
switch (part) {
  case 'major': newVersion = `${major + 1}.0.0`; break;
  case 'minor': newVersion = `${major}.${minor + 1}.0`; break;
  case 'patch': newVersion = `${major}.${minor}.${patch_ + 1}`; break;
}

// Update SKILL.md (source of truth)
const updated = content.replace(match[0], `${match[1]}${newVersion}`);
writeFileSync(SKILL_MD, updated);

// Sync to package.json
const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8'));
pkg.version = newVersion;
writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2) + '\n');

console.log(newVersion);
