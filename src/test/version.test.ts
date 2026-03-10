import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_MD = join(__dirname, '..', 'SKILL.md');

// ── Regex: version parsing (clawplay-cli.ts style — permissive) ─────────

describe('version parsing (permissive regex)', () => {
  const regex = /^version:\s*(.+)$/m;

  it('extracts version from standard frontmatter', () => {
    const content = '---\nname: test\nversion: 1.5.0\n---';
    expect(content.match(regex)?.[1].trim()).toBe('1.5.0');
  });

  it('extracts version with extra whitespace', () => {
    const content = 'version:   2.0.0  ';
    expect(content.match(regex)?.[1].trim()).toBe('2.0.0');
  });

  it('extracts version with pre-release tag', () => {
    const content = 'version: 1.5.0-beta';
    expect(content.match(regex)?.[1].trim()).toBe('1.5.0-beta');
  });

  it('returns null when no version line exists', () => {
    const content = '---\nname: test\n---';
    expect(content.match(regex)).toBeNull();
  });

  it('matches first version line in multiline content', () => {
    const content = 'version: 1.0.0\nsome text\nversion: 2.0.0';
    expect(content.match(regex)?.[1].trim()).toBe('1.0.0');
  });
});

// ── Regex: version parsing (bump-version.js style — strict) ──────────

describe('version parsing (strict regex)', () => {
  const regex = /^(version:\s*)(\d+\.\d+\.\d+)$/m;

  it('matches standard semver', () => {
    const content = 'version: 1.5.0';
    const m = content.match(regex);
    expect(m?.[2]).toBe('1.5.0');
  });

  it('captures the prefix for replacement', () => {
    const content = 'version: 1.5.0';
    const m = content.match(regex);
    expect(m?.[1]).toBe('version: ');
  });

  it('rejects pre-release tags', () => {
    const content = 'version: 1.5.0-beta';
    expect(content.match(regex)).toBeNull();
  });

  it('rejects non-numeric versions', () => {
    const content = 'version: latest';
    expect(content.match(regex)).toBeNull();
  });
});

// ── Bump computation ─────────────────────────────────────────────────

describe('bump computation', () => {
  function bump(version: string, part: 'patch' | 'minor' | 'major'): string {
    const [major, minor, patch] = version.split('.').map(Number);
    switch (part) {
      case 'major': return `${major + 1}.0.0`;
      case 'minor': return `${major}.${minor + 1}.0`;
      case 'patch': return `${major}.${minor}.${patch + 1}`;
    }
  }

  it('bumps patch', () => expect(bump('1.5.0', 'patch')).toBe('1.5.1'));
  it('bumps minor', () => expect(bump('1.5.3', 'minor')).toBe('1.6.0'));
  it('bumps major', () => expect(bump('1.5.3', 'major')).toBe('2.0.0'));
  it('handles zero versions', () => expect(bump('0.0.0', 'patch')).toBe('0.0.1'));
  it('resets lower parts on minor bump', () => expect(bump('1.2.9', 'minor')).toBe('1.3.0'));
  it('resets lower parts on major bump', () => expect(bump('1.9.9', 'major')).toBe('2.0.0'));
});

// ── updateAvailable logic ────────────────────────────────────────────

describe('updateAvailable logic', () => {
  function isUpdateAvailable(local: string, remote: string): boolean {
    return remote !== 'unknown' && local !== remote;
  }

  it('returns false when versions match', () => {
    expect(isUpdateAvailable('1.5.0', '1.5.0')).toBe(false);
  });

  it('returns true when remote is newer', () => {
    expect(isUpdateAvailable('1.5.0', '1.6.0')).toBe(true);
  });

  it('returns true when local is ahead (known trade-off)', () => {
    expect(isUpdateAvailable('1.6.0', '1.5.0')).toBe(true);
  });

  it('returns false when remote is unknown', () => {
    expect(isUpdateAvailable('1.5.0', 'unknown')).toBe(false);
  });

  it('returns false when both are unknown', () => {
    expect(isUpdateAvailable('unknown', 'unknown')).toBe(false);
  });

  it('returns true when local is unknown but remote is known', () => {
    expect(isUpdateAvailable('unknown', '1.5.0')).toBe(true);
  });
});

// ── bump-version.js integration ──────────────────────────────────────

describe('bump-version.js integration', () => {
  const original = readFileSync(SKILL_MD, 'utf8');

  afterAll(() => {
    // Always restore original SKILL.md
    writeFileSync(SKILL_MD, original);
  });

  it('bumps patch and writes to SKILL.md', () => {
    // Ensure we start from a known version
    const versionBefore = original.match(/^version:\s*(.+)$/m)?.[1].trim();
    expect(versionBefore).toBeTruthy();

    const result = execFileSync('node', ['scripts/bump-version.js', 'patch'], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
    }).trim();

    const [major, minor, patch] = versionBefore!.split('.').map(Number);
    expect(result).toBe(`${major}.${minor}.${patch + 1}`);

    // Verify file was actually written
    const after = readFileSync(SKILL_MD, 'utf8');
    expect(after).toContain(`version: ${result}`);
  });

  it('bumps minor and resets patch', () => {
    // Restore to original first (previous test modified it)
    writeFileSync(SKILL_MD, original);

    const result = execFileSync('node', ['scripts/bump-version.js', 'minor'], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
    }).trim();

    const [major, minor] = original.match(/^version:\s*(.+)$/m)![1].trim().split('.').map(Number);
    expect(result).toBe(`${major}.${minor + 1}.0`);
  });

  it('rejects invalid bump type', () => {
    expect(() => {
      execFileSync('node', ['scripts/bump-version.js', 'invalid'], {
        cwd: join(__dirname, '..'),
        encoding: 'utf8',
        stdio: 'pipe',
      });
    }).toThrow();
  });
});
