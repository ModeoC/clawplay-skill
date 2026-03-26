import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
const __dirname = dirname(process.argv[1]);
// tsc → __dirname is dist/, esbuild dev → build/, bundled → skill root
export const SKILL_ROOT = __dirname.endsWith(sep + 'dist') || __dirname.endsWith(sep + 'build')
  ? join(__dirname, '..')
  : __dirname;
export const PLAYBOOK_FILE = join(SKILL_ROOT, 'poker-playbook.md');

/** Valid signal types that can be suppressed via config. */
export const SUPPRESSIBLE_SIGNALS = new Set([
  'DECISION_STATUS',
  'HAND_UPDATE',
  'INVITE_RECEIVED',
  'WAITING_FOR_PLAYERS',
  'REBUY_AVAILABLE',
  'NEW_FOLLOWER',
  'INVITE_RESPONSE',
]);

export interface ClawPlayConfig {
  apiKeyEnvVar?: string;
  accountId?: string;
  agentId?: string;
  reflectEveryNHands?: number;
  suppressedSignals?: string[];
  tableChat?: { reactive?: boolean; receiveOpponentChat?: boolean };
  lastLaunchArgs?: { channel: string; chatId: string; account?: string };
  paused?: boolean;
  maxSessionsPerDay?: number;
  maxHandsPerDay?: number;
  /** Per-task model overrides. Format: "provider/model" (e.g. "openrouter/mistralai/mistral-small-2603"). */
  models?: {
    /** Model for poker decision and reactive chat calls. Falls back to agent default if unset. */
    decision?: string;
    /** Model for reflection calls. Falls back to agent default if unset. */
    reflection?: string;
  };
}

export function readClawPlayConfig(): ClawPlayConfig {
  try {
    const raw = readFileSync(join(SKILL_ROOT, 'clawplay-config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const config: ClawPlayConfig = {};
    if (typeof parsed.apiKeyEnvVar === 'string' && parsed.apiKeyEnvVar) config.apiKeyEnvVar = parsed.apiKeyEnvVar;
    if (typeof parsed.accountId === 'string' && parsed.accountId) config.accountId = parsed.accountId;
    if (typeof parsed.agentId === 'string' && parsed.agentId) config.agentId = parsed.agentId;
    if (typeof parsed.reflectEveryNHands === 'number' && parsed.reflectEveryNHands > 0) config.reflectEveryNHands = parsed.reflectEveryNHands;
    if (Array.isArray(parsed.suppressedSignals)) {
      config.suppressedSignals = parsed.suppressedSignals.filter(
        (s: unknown) => typeof s === 'string' && SUPPRESSIBLE_SIGNALS.has(s),
      );
    }
    if (parsed.tableChat && typeof parsed.tableChat === 'object') {
      config.tableChat = {};
      if (typeof parsed.tableChat.reactive === 'boolean') config.tableChat.reactive = parsed.tableChat.reactive;
      if (typeof parsed.tableChat.receiveOpponentChat === 'boolean') config.tableChat.receiveOpponentChat = parsed.tableChat.receiveOpponentChat;
    }
    if (typeof parsed.paused === 'boolean') config.paused = parsed.paused;
    if (typeof parsed.maxSessionsPerDay === 'number' && parsed.maxSessionsPerDay >= 0) config.maxSessionsPerDay = parsed.maxSessionsPerDay;
    if (typeof parsed.maxHandsPerDay === 'number' && parsed.maxHandsPerDay >= 0) config.maxHandsPerDay = parsed.maxHandsPerDay;
    if (parsed.lastLaunchArgs && typeof parsed.lastLaunchArgs === 'object') {
      const la = parsed.lastLaunchArgs;
      if (typeof la.channel === 'string' && typeof la.chatId === 'string') {
        config.lastLaunchArgs = { channel: la.channel, chatId: la.chatId };
        if (typeof la.account === 'string') config.lastLaunchArgs.account = la.account;
      }
    }
    if (parsed.models && typeof parsed.models === 'object') {
      config.models = {};
      if (typeof parsed.models.decision === 'string' && parsed.models.decision) config.models.decision = parsed.models.decision;
      if (typeof parsed.models.reflection === 'string' && parsed.models.reflection) config.models.reflection = parsed.models.reflection;
    }
    return config;
  } catch {
    return {};
  }
}

/**
 * Write a partial update to clawplay-config.json, preserving existing fields.
 */
export function writeClawPlayConfig(updates: Partial<ClawPlayConfig>): void {
  const configPath = join(SKILL_ROOT, 'clawplay-config.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch { /* file missing or invalid — start fresh */ }
  const merged = { ...existing, ...updates };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
}

export function resolveApiKey(config: ClawPlayConfig): string | undefined {
  const envVar = config.apiKeyEnvVar || 'CLAWPLAY_API_KEY_PRIMARY';

  // Try process.env first (set by gateway)
  if (process.env[envVar]) return process.env[envVar];

  // Fallback: read directly from openclaw.json (works before gateway restart)
  try {
    const ocPath = join(process.env.HOME || '/root', '.openclaw', 'openclaw.json');
    const oc = JSON.parse(readFileSync(ocPath, 'utf8'));
    const val = oc?.env?.vars?.[envVar];
    if (typeof val === 'string' && val) return val;
  } catch {}

  return undefined;
}

export function readPlaybook(): string {
  try {
    return readFileSync(PLAYBOOK_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

export function readLocalVersion(): string {
  try {
    const skillMd = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8');
    const match = skillMd.match(/^version:\s*(.+)$/m);
    return match ? match[1].trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function readNotes(): string {
  try {
    return readFileSync(join(SKILL_ROOT, 'poker-notes.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

