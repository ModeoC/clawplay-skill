import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  readClawPlayConfig, writeClawPlayConfig, resolveApiKey,
  readPlaybook, readNotes, readLocalVersion,
  SKILL_ROOT, PLAYBOOK_FILE, SUPPRESSIBLE_SIGNALS, ClawPlayConfig,
} from '../review.js';

// ── Fixture helpers ─────────────────────────────────────────────────

const CONFIG_PATH = join(SKILL_ROOT, 'clawplay-config.json');
const PLAYBOOK_PATH = join(SKILL_ROOT, 'poker-playbook.md');
const NOTES_PATH = join(SKILL_ROOT, 'poker-notes.txt');
const SKILL_MD_PATH = join(SKILL_ROOT, 'SKILL.md');

let savedConfig: string | null = null;
let savedPlaybook: string | null = null;
let savedNotes: string | null = null;
let savedSkillMd: string | null = null;

function backup(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function restore(path: string, content: string | null) {
  if (content !== null) writeFileSync(path, content);
  else if (existsSync(path)) unlinkSync(path);
}

beforeEach(() => {
  savedConfig = backup(CONFIG_PATH);
  savedPlaybook = backup(PLAYBOOK_PATH);
  savedNotes = backup(NOTES_PATH);
  savedSkillMd = backup(SKILL_MD_PATH);
});

afterEach(() => {
  restore(CONFIG_PATH, savedConfig);
  restore(PLAYBOOK_PATH, savedPlaybook);
  restore(NOTES_PATH, savedNotes);
  restore(SKILL_MD_PATH, savedSkillMd);
});

// ── Constants ───────────────────────────────────────────────────────

describe('SKILL_ROOT and constants', () => {
  it('SKILL_ROOT is a non-empty string', () => {
    expect(typeof SKILL_ROOT).toBe('string');
    expect(SKILL_ROOT.length).toBeGreaterThan(0);
  });

  it('PLAYBOOK_FILE is poker-playbook.md under SKILL_ROOT', () => {
    expect(PLAYBOOK_FILE).toBe(join(SKILL_ROOT, 'poker-playbook.md'));
  });

  it('SUPPRESSIBLE_SIGNALS contains expected signal types', () => {
    expect(SUPPRESSIBLE_SIGNALS).toBeInstanceOf(Set);
    expect(SUPPRESSIBLE_SIGNALS.has('HAND_UPDATE')).toBe(true);
    expect(SUPPRESSIBLE_SIGNALS.has('INVITE_RECEIVED')).toBe(true);
    expect(SUPPRESSIBLE_SIGNALS.has('GAME_OVER')).toBe(false);
  });
});

// ── readClawPlayConfig ──────────────────────────────────────────────

describe('readClawPlayConfig', () => {
  it('returns empty object when config file is missing', () => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    expect(readClawPlayConfig()).toEqual({});
  });

  it('parses valid config with all fields', () => {
    const full: Record<string, unknown> = {
      apiKeyEnvVar: 'MY_KEY', accountId: 'acc-1', agentId: 'bot-1',
      listenerMode: 'game', reflectEveryNHands: 5,
      suppressedSignals: ['HAND_UPDATE', 'BOGUS_SIGNAL'],
      tableChat: { reactive: true, receiveOpponentChat: false },
      paused: true, maxSessionsPerDay: 3, maxHandsPerDay: 100,
      lastLaunchArgs: { channel: 'telegram', chatId: '999', account: 'bot' },
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(full));
    const cfg = readClawPlayConfig();
    expect(cfg.apiKeyEnvVar).toBe('MY_KEY');
    expect(cfg.listenerMode).toBe('game');
    expect(cfg.reflectEveryNHands).toBe(5);
    expect(cfg.suppressedSignals).toEqual(['HAND_UPDATE']); // BOGUS filtered out
    expect(cfg.tableChat).toEqual({ reactive: true, receiveOpponentChat: false });
    expect(cfg.paused).toBe(true);
    expect(cfg.maxSessionsPerDay).toBe(3);
    expect(cfg.lastLaunchArgs).toEqual({ channel: 'telegram', chatId: '999', account: 'bot' });
  });

  it('ignores invalid field types', () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({
      apiKeyEnvVar: 123, listenerMode: 'invalid', reflectEveryNHands: -1,
      maxSessionsPerDay: -1, // negative fails >= 0 check
    }));
    const cfg = readClawPlayConfig();
    expect(cfg.apiKeyEnvVar).toBeUndefined();
    expect(cfg.listenerMode).toBeUndefined();
    expect(cfg.reflectEveryNHands).toBeUndefined();
    expect(cfg.maxSessionsPerDay).toBeUndefined();
  });

  it('returns empty object for malformed JSON', () => {
    writeFileSync(CONFIG_PATH, '{not json!!!');
    expect(readClawPlayConfig()).toEqual({});
  });
});

// ── writeClawPlayConfig ─────────────────────────────────────────────

describe('writeClawPlayConfig', () => {
  it('creates config when file does not exist', () => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    writeClawPlayConfig({ paused: true });
    const written = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    expect(written.paused).toBe(true);
  });

  it('merges updates into existing config', () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ accountId: 'old', agentId: 'bot' }));
    writeClawPlayConfig({ accountId: 'new', paused: false });
    const merged = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    expect(merged.accountId).toBe('new');
    expect(merged.agentId).toBe('bot');
    expect(merged.paused).toBe(false);
  });
});

// ── resolveApiKey ───────────────────────────────────────────────────

describe('resolveApiKey', () => {
  const envKey = 'TEST_CLAWPLAY_KEY_9823';
  let savedEnv: string | undefined;

  beforeEach(() => { savedEnv = process.env[envKey]; });
  afterEach(() => {
    if (savedEnv !== undefined) process.env[envKey] = savedEnv;
    else delete process.env[envKey];
  });

  it('returns env var value when set', () => {
    process.env[envKey] = 'secret-from-env';
    expect(resolveApiKey({ apiKeyEnvVar: envKey })).toBe('secret-from-env');
  });

  it('falls back to CLAWPLAY_API_KEY_PRIMARY when no apiKeyEnvVar', () => {
    const fallback = 'CLAWPLAY_API_KEY_PRIMARY';
    const prev = process.env[fallback];
    process.env[fallback] = 'primary-key';
    try {
      expect(resolveApiKey({})).toBe('primary-key');
    } finally {
      if (prev !== undefined) process.env[fallback] = prev;
      else delete process.env[fallback];
    }
  });

  it('returns undefined when env var is not set and openclaw.json missing', () => {
    delete process.env[envKey];
    // With a custom env var name that doesn't exist, and no openclaw.json fallback
    expect(resolveApiKey({ apiKeyEnvVar: envKey })).toBeUndefined();
  });
});

// ── readPlaybook ────────────────────────────────────────────────────

describe('readPlaybook', () => {
  it('returns trimmed content when file exists', () => {
    writeFileSync(PLAYBOOK_PATH, '  play tight  \n');
    expect(readPlaybook()).toBe('play tight');
  });

  it('returns empty string when file is missing', () => {
    if (existsSync(PLAYBOOK_PATH)) unlinkSync(PLAYBOOK_PATH);
    expect(readPlaybook()).toBe('');
  });
});

// ── readNotes ───────────────────────────────────────────────────────

describe('readNotes', () => {
  it('returns trimmed content when file exists', () => {
    writeFileSync(NOTES_PATH, '\n  bluff more\n\n');
    expect(readNotes()).toBe('bluff more');
  });

  it('returns empty string when file is missing', () => {
    if (existsSync(NOTES_PATH)) unlinkSync(NOTES_PATH);
    expect(readNotes()).toBe('');
  });
});

// ── readLocalVersion ────────────────────────────────────────────────

describe('readLocalVersion', () => {
  it('extracts version from SKILL.md frontmatter', () => {
    writeFileSync(SKILL_MD_PATH, '---\nname: poker\nversion: 2.3.1\n---\n# Skill');
    expect(readLocalVersion()).toBe('2.3.1');
  });

  it('returns unknown when no version line', () => {
    writeFileSync(SKILL_MD_PATH, '---\nname: poker\n---');
    expect(readLocalVersion()).toBe('unknown');
  });

  it('returns unknown when SKILL.md is missing', () => {
    if (existsSync(SKILL_MD_PATH)) unlinkSync(SKILL_MD_PATH);
    expect(readLocalVersion()).toBe('unknown');
  });
});
