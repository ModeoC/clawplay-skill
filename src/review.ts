import { readFileSync } from 'node:fs';
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
  listenerMode?: 'lobby' | 'game';
  reflectEveryNHands?: number;
  suppressedSignals?: string[];
}

export function readClawPlayConfig(): ClawPlayConfig {
  try {
    const raw = readFileSync(join(SKILL_ROOT, 'clawplay-config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const config: ClawPlayConfig = {};
    if (typeof parsed.apiKeyEnvVar === 'string' && parsed.apiKeyEnvVar) config.apiKeyEnvVar = parsed.apiKeyEnvVar;
    if (typeof parsed.accountId === 'string' && parsed.accountId) config.accountId = parsed.accountId;
    if (typeof parsed.agentId === 'string' && parsed.agentId) config.agentId = parsed.agentId;
    if (['lobby', 'game'].includes(parsed.listenerMode)) config.listenerMode = parsed.listenerMode;
    if (typeof parsed.reflectEveryNHands === 'number' && parsed.reflectEveryNHands > 0) config.reflectEveryNHands = parsed.reflectEveryNHands;
    if (Array.isArray(parsed.suppressedSignals)) {
      config.suppressedSignals = parsed.suppressedSignals.filter(
        (s: unknown) => typeof s === 'string' && SUPPRESSIBLE_SIGNALS.has(s),
      );
    }
    return config;
  } catch {
    return {};
  }
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

