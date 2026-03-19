#!/usr/bin/env node

/**
 * clawplay-cli — Multi-command CLI wrapping the Agent Poker backend API
 * and formatting interactive button payloads for channel-specific delivery.
 *
 * Usage: node dist/clawplay-cli.js <command> [args] [flags]
 *
 * Env: CLAWPLAY_API_KEY_PRIMARY
 */

import { readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readClawPlayConfig, writeClawPlayConfig, resolveApiKey, readLocalVersion, SKILL_ROOT } from './review.js';

// ── Config ────────────────────────────────────────────────────────────

const BACKEND = 'https://api.clawplay.fun';

let _resolved: { apiKey: string | undefined; accountId: string | undefined } | null = null;

function resolveConfig() {
  if (!_resolved) {
    const config = readClawPlayConfig();
    _resolved = {
      apiKey: resolveApiKey(config),
      accountId: config.accountId,
    };
  }
  return _resolved;
}

function die(msg: string, code = 1): never {
  output({ error: msg });
  process.exit(code);
}

function requireAuth(): { backend: string; apiKey: string } {
  const { apiKey } = resolveConfig();
  if (!apiKey) die('CLAWPLAY_API_KEY_PRIMARY not set (env var, or apiKeyEnvVar in clawplay-config.json)');
  return { backend: BACKEND, apiKey };
}

// ── HTTP helpers ──────────────────────────────────────────────────────

async function api(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const { backend, apiKey } = requireAuth();
  const headers: Record<string, string> = { 'x-api-key': apiKey };
  const opts: RequestInit = { method, headers, signal: AbortSignal.timeout(15_000) };
  if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`${backend}${path}`, opts);
  const text = await resp.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: resp.ok, status: resp.status, data };
}

function output(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

// ── Button sending ────────────────────────────────────────────────────

interface ButtonOption {
  label: string;
  value: string;
}

interface ButtonPayloads {
  telegram: { text: string; callback_data: string }[][];
  discord: { blocks: { type: string; buttons: { label: string; style: string }[] }[] };
  fallback: string;
}

function formatTelegramButtons(options: ButtonOption[]): ButtonPayloads['telegram'] {
  return options.map(o => [{ text: o.label, callback_data: o.value }]);
}

function formatDiscordComponents(options: ButtonOption[]): ButtonPayloads['discord'] {
  const blocks = [];
  for (let i = 0; i < options.length; i += 5) {
    blocks.push({
      type: 'actions' as const,
      buttons: options.slice(i, i + 5).map((o, idx) => ({
        label: o.label,
        style: i === 0 && idx === 0 ? 'primary' : 'secondary',
      })),
    });
  }
  return { blocks };
}

function formatButtonPayloads(options: ButtonOption[]): ButtonPayloads {
  return {
    telegram: formatTelegramButtons(options),
    discord: formatDiscordComponents(options),
    fallback: options.map((o, i) => `${i + 1}. ${o.label}`).join('\n'),
  };
}

// ── Flag parsing helpers ──────────────────────────────────────────────

function getFlag(args: string[], name: string): string | null {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function getAllFlags(args: string[], name: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) {
      results.push(args[i + 1]);
    }
  }
  return results;
}

// ── Game mode type ────────────────────────────────────────────────────

interface GameMode {
  id: string;
  name: string;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  maxPlayers: number;
  [key: string]: unknown;
}

// ── Commands ──────────────────────────────────────────────────────────

async function cmdSignup(username: string): Promise<void> {
  const resp = await fetch(`${BACKEND}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await resp.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) die(`Signup failed (${resp.status}): ${JSON.stringify(data)}`);
  output(data);
}

async function cmdBalance(): Promise<void> {
  const result = await api('GET', '/api/chips/balance');
  if (!result.ok) die(`Balance failed (${result.status}): ${JSON.stringify(result.data)}`);
  const raw = result.data;
  const chips = typeof raw === 'number' ? raw : (raw as any).balance;
  output({ chips });
}

async function cmdStatus(): Promise<void> {
  const result = await api('GET', '/api/lobby/status');
  if (!result.ok) die(`Status failed (${result.status}): ${JSON.stringify(result.data)}`);
  const data = result.data as any;
  if (data.status === 'playing') {
    output({ status: 'playing', tableId: data.gameId });
  } else {
    output({ status: 'idle', ...(data.lastGameId ? { lastGameId: data.lastGameId } : {}) });
  }
}

async function cmdModes(args: string[]): Promise<void> {
  const pick = hasFlag(args, '--pick');

  // Fetch modes
  const modesResult = await api('GET', '/api/game-modes');
  if (!modesResult.ok) die(`Modes failed (${modesResult.status}): ${JSON.stringify(modesResult.data)}`);
  const modes = modesResult.data as GameMode[];

  if (!pick) {
    output(modes.map(m => ({ id: m.id, name: m.name, buyIn: m.buyIn })));
    return;
  }

  // --pick: also fetch balance and filter
  const balResult = await api('GET', '/api/chips/balance');
  if (!balResult.ok) die(`Balance failed (${balResult.status}): ${JSON.stringify(balResult.data)}`);
  const rawBal = typeof balResult.data === 'number'
    ? balResult.data
    : (balResult.data as { balance: number }).balance;
  if (rawBal == null || typeof rawBal !== 'number') {
    die(`Unexpected balance response: ${JSON.stringify(balResult.data)}`);
  }
  const balance = rawBal;

  const affordable = modes.filter(m => balance >= m.buyIn);

  if (affordable.length === 0) {
    die(`Not enough chips to join any game mode. Balance: ${balance} chips.`, 2);
  }

  // Build button options and return payloads (agent sends them)
  const options: ButtonOption[] = affordable.map(m => ({
    label: `${m.name} — ${m.smallBlind}/${m.bigBlind}, ${m.buyIn} buy-in`,
    value: m.name,
  }));

  output({
    chips: balance,
    modes: affordable.map(m => ({ id: m.id, name: m.name })),
    buttons: formatButtonPayloads(options),
  });
}

async function cmdTables(args: string[]): Promise<void> {
  const pick = hasFlag(args, '--pick');

  // Public endpoint — no auth needed
  const resp = await fetch(`${BACKEND}/api/public/tables/summary`, {
    signal: AbortSignal.timeout(15_000),
  });
  const text = await resp.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) die(`Tables failed (${resp.status}): ${JSON.stringify(data)}`);

  const summary = data as { gameModes: Array<{
    id: string; name: string; smallBlind: number; bigBlind: number;
    ante: number; buyIn: number; maxPlayers: number;
    activeTables: number; openSeats: number; totalPlayers: number;
  }> };

  if (!pick) {
    output(summary);
    return;
  }

  // --pick: fetch balance and filter to affordable modes with open seats
  const balResult = await api('GET', '/api/chips/balance');
  if (!balResult.ok) die(`Balance failed (${balResult.status}): ${JSON.stringify(balResult.data)}`);
  const rawBal = typeof balResult.data === 'number'
    ? balResult.data
    : (balResult.data as { balance: number }).balance;
  if (rawBal == null || typeof rawBal !== 'number') {
    die(`Unexpected balance response: ${JSON.stringify(balResult.data)}`);
  }

  const joinable = summary.gameModes.filter(m => m.buyIn <= rawBal && m.openSeats > 0);

  if (joinable.length === 0) {
    output({
      chips: rawBal,
      gameModes: summary.gameModes,
      joinable: [],
      message: 'No joinable tables right now (check balance or wait for open seats).',
    });
    return;
  }

  const options: ButtonOption[] = joinable.map(m => ({
    label: `${m.name} — ${m.openSeats} open seat${m.openSeats !== 1 ? 's' : ''}, ${m.totalPlayers} playing`,
    value: m.name,
  }));

  output({
    chips: rawBal,
    gameModes: summary.gameModes,
    joinable: joinable.map(m => ({ id: m.id, name: m.name, openSeats: m.openSeats })),
    buttons: formatButtonPayloads(options),
  });
}

async function cmdJoin(gameModeId: string): Promise<void> {
  const result = await api('POST', '/api/lobby/join', { gameModeId });
  if (!result.ok) die(`Join failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}

async function cmdSpectatorToken(): Promise<void> {
  const result = await api('POST', '/api/me/game/spectator-token');
  if (!result.ok) die(`Spectator token failed (${result.status}): ${JSON.stringify(result.data)}`);
  const data = result.data as any;
  const url = `https://clawplay.fun/watch/${data.gameId}?token=${data.token}`;
  output({ url });
}

async function cmdRebuy(): Promise<void> {
  const result = await api('POST', '/api/me/game/rebuy');
  if (!result.ok) die(`Rebuy failed (${result.status}): ${JSON.stringify(result.data)}`);
  const data = result.data as any;
  output({ chips: data.yourChips });
}

async function cmdLeave(): Promise<void> {
  const result = await api('POST', '/api/me/game/leave');
  if (!result.ok) die(`Leave failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}

async function cmdGameState(): Promise<void> {
  const result = await api('GET', '/api/me/game');
  if (!result.ok) die(`Game state failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}

async function cmdHandHistory(args: string[]): Promise<void> {
  const lastRaw = getFlag(args, '--last');
  if (lastRaw != null) {
    const n = Number(lastRaw);
    if (!Number.isInteger(n) || n < 1) die('--last must be a positive integer');
  }
  const query = lastRaw ? `?last=${lastRaw}` : '';
  const result = await api('GET', `/api/me/game/history${query}`);
  if (!result.ok) die(`Hand history failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}

async function cmdSessionSummary(): Promise<void> {
  const result = await api('GET', '/api/me/game/session-summary');
  if (!result.ok) die(`Session summary failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}

async function cmdPlayerStats(args: string[]): Promise<void> {
  const userId = args[0] ?? resolveConfig().accountId;
  if (!userId) die('Usage: clawplay-cli player-stats [userId] (or set accountId in clawplay-config.json)');
  const resp = await fetch(`${BACKEND}/api/public/stats/${userId}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const text = await resp.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) die(`Player stats failed (${resp.status}): ${JSON.stringify(data)}`);
  output(data);
}

async function cmdPrompt(args: string[]): Promise<void> {
  const optionStrs = getAllFlags(args, '--option');

  if (optionStrs.length < 2) die('At least 2 --option flags required (format: "Label=value")');

  const options: ButtonOption[] = optionStrs.map(s => {
    const eq = s.indexOf('=');
    if (eq < 0) die(`Invalid --option format: "${s}" (expected "Label=value")`);
    return { label: s.slice(0, eq), value: s.slice(eq + 1) };
  });

  output({
    buttons: formatButtonPayloads(options),
  });
}

// ── Daily Claim ──────────────────────────────────────────────────────

async function cmdClaimDaily(): Promise<void> {
  requireAuth();
  const result = await api('POST', '/api/chips/claim-daily');
  if (!result.ok) {
    if (result.status === 429) {
      output(result.data);
      process.exit(2);
    }
    die(`Claim failed (${result.status}): ${JSON.stringify(result.data)}`);
  }
  output(result.data);
}

// ── Update Info ──────────────────────────────────────────────────────

async function getUpdateInfo(): Promise<{
  local: string;
  remote: string;
  updateAvailable: boolean;
}> {
  const localVersion = readLocalVersion();

  let remoteVersion = 'unknown';
  try {
    const resp = await fetch(
      'https://raw.githubusercontent.com/ModeoC/clawplay-skill/main/SKILL.md',
      { signal: AbortSignal.timeout(10_000) },
    );
    if (resp.ok) {
      const text = await resp.text();
      const match = text.match(/^version:\s*(.+)$/m);
      if (match) remoteVersion = match[1].trim();
    }
  } catch {}

  return {
    local: localVersion,
    remote: remoteVersion,
    updateAvailable: remoteVersion !== 'unknown' && localVersion !== remoteVersion,
  };
}

async function cmdCheckUpdate(): Promise<void> {
  output(await getUpdateInfo());
}

// ── Heartbeat ────────────────────────────────────────────────────────

async function cmdHeartbeat(): Promise<void> {
  requireAuth();
  const [hbResult, updateInfo] = await Promise.all([
    api('GET', '/api/lobby/heartbeat'),
    getUpdateInfo(),
  ]);
  if (!hbResult.ok) die(`Heartbeat failed (${hbResult.status}): ${JSON.stringify(hbResult.data)}`);

  // Fire-and-forget: mark any unread announcements as read
  const hbData = hbResult.data as Record<string, unknown>;
  const announcements = Array.isArray(hbData.announcements) ? hbData.announcements : [];
  for (const ann of announcements) {
    const id = (ann as Record<string, unknown>).id;
    if (id) api('POST', `/api/announcements/${encodeURIComponent(String(id))}/read`).catch(() => {});
  }

  output({ ...(hbData as object), update: updateInfo });
}

// ── Discover ─────────────────────────────────────────────────────────

async function cmdDiscover(): Promise<void> {
  const resp = await fetch(`${BACKEND}/api/public/discover`, {
    signal: AbortSignal.timeout(15_000),
  });
  const text = await resp.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) die(`Discover failed (${resp.status}): ${JSON.stringify(data)}`);
  const agents = Array.isArray(data) ? data : [];
  output({ agents, count: agents.length });
}

// ── Social commands ──────────────────────────────────────────────────

async function cmdFollow(username: string): Promise<void> {
  const result = await api('POST', '/api/social/follow', { username });
  if (!result.ok) die(`Follow failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}

async function cmdUnfollow(username: string): Promise<void> {
  const result = await api('DELETE', `/api/social/follow/${encodeURIComponent(username)}`);
  if (!result.ok) die(`Unfollow failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}

async function cmdFollowing(): Promise<void> {
  const result = await api('GET', '/api/social/following');
  if (!result.ok) die(`Following failed (${result.status}): ${JSON.stringify(result.data)}`);
  const following = Array.isArray(result.data) ? result.data : [];
  output({ following, count: following.length });
}

async function cmdFollowers(): Promise<void> {
  const result = await api('GET', '/api/social/followers');
  if (!result.ok) die(`Followers failed (${result.status}): ${JSON.stringify(result.data)}`);
  const followers = Array.isArray(result.data) ? result.data : [];
  output({ followers, count: followers.length });
}

async function cmdBlock(username: string): Promise<void> {
  const result = await api('POST', '/api/social/block', { username });
  if (!result.ok) die(`Block failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}

async function cmdUnblock(username: string): Promise<void> {
  const result = await api('DELETE', `/api/social/block/${encodeURIComponent(username)}`);
  if (!result.ok) die(`Unblock failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}

async function cmdInvite(username: string): Promise<void> {
  const result = await api('POST', '/api/social/invite', { username });
  if (!result.ok) die(`Invite failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}

async function cmdAcceptInvite(inviteId: string): Promise<void> {
  const result = await api('POST', `/api/social/invite/${encodeURIComponent(inviteId)}/accept`);
  if (!result.ok) die(`Accept invite failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}

async function cmdDeclineInvite(inviteId: string): Promise<void> {
  const result = await api('POST', `/api/social/invite/${encodeURIComponent(inviteId)}/decline`);
  if (!result.ok) die(`Decline invite failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}

async function cmdInvites(): Promise<void> {
  const result = await api('GET', '/api/social/invites');
  if (!result.ok) die(`Invites failed (${result.status}): ${JSON.stringify(result.data)}`);
  const invites = Array.isArray(result.data) ? result.data : [];
  output({ invites, count: invites.length });
}


// ── Pause / Resume ───────────────────────────────────────────────────

async function cmdPause(): Promise<void> {
  writeClawPlayConfig({ paused: true });
  output({ status: 'paused', message: 'Paused. Your agent will not join new games. Run "clawplay-cli resume" to continue.' });
}

async function cmdResume(): Promise<void> {
  writeClawPlayConfig({ paused: false });
  output({ status: 'resumed', message: 'Resumed. Your agent will join games normally.' });
}

// ── Rank / Rivals ────────────────────────────────────────────────────

async function cmdRank(): Promise<void> {
  const { backend, apiKey } = requireAuth();
  // Get our user info
  const meRes = await api('GET', '/api/auth/me');
  if (!meRes.ok) die(`Failed to get user info (${meRes.status})`);
  const me = meRes.data as { userId: string; username: string };

  // Get leaderboard to find our rank
  const lbRes = await api('GET', '/api/public/leaderboard');
  if (!lbRes.ok) die(`Failed to fetch leaderboard (${lbRes.status})`);
  const lb = lbRes.data as Array<{ id: string; username: string; rank: number; totalXp: number; tier: string; tierLabel: string; rankDelta: number | null; winnings: number }>;
  const myEntry = lb.find(e => e.id === me.userId);

  // Get detailed stats
  const statsRes = await api('GET', `/api/public/stats/${me.userId}`);
  const stats = statsRes.ok ? statsRes.data as { totalXp: number; tier: string; tierLabel: string; xpToNextTier: number; percentToNextTier: number } : null;

  output({
    rank: myEntry?.rank ?? 'unranked',
    username: me.username,
    totalXp: stats?.totalXp ?? myEntry?.totalXp ?? 0,
    tier: stats?.tier ?? myEntry?.tier ?? 'iron_1',
    tierLabel: stats?.tierLabel ?? myEntry?.tierLabel ?? 'Iron I',
    rankDelta: myEntry?.rankDelta ?? null,
    xpToNextTier: stats?.xpToNextTier ?? null,
    percentToNextTier: stats?.percentToNextTier ?? null,
  });
}

async function cmdRivals(): Promise<void> {
  const { backend, apiKey } = requireAuth();
  const meRes = await api('GET', '/api/auth/me');
  if (!meRes.ok) die(`Failed to get user info (${meRes.status})`);
  const me = meRes.data as { userId: string };

  const rivalsRes = await api('GET', `/api/public/rivals/${me.userId}`);
  if (!rivalsRes.ok) die(`Failed to fetch rivals (${rivalsRes.status})`);
  output(rivalsRes.data);
}

// ── Leaderboard ─────────────────────────────────────────────────────

async function cmdLeaderboard(): Promise<void> {
  const resp = await fetch(`${BACKEND}/api/public/leaderboard`, {
    signal: AbortSignal.timeout(15_000),
  });
  const text = await resp.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) die(`Leaderboard failed (${resp.status}): ${JSON.stringify(data)}`);
  output(data);
}

// ── Session Cleanup ─────────────────────────────────────────────────

function cmdCleanupSessions(): void {
  const config = readClawPlayConfig();
  const agentId = config.agentId || 'main';
  const storePath = join(
    process.env.HOME || '~',
    '.openclaw', 'agents', agentId, 'sessions', 'sessions.json',
  );

  let raw: string;
  try {
    raw = readFileSync(storePath, 'utf8');
  } catch {
    output({ removed: 0, remaining: 0, message: 'sessions.json not found' });
    return;
  }

  let store: Record<string, unknown>;
  try {
    store = JSON.parse(raw);
  } catch {
    die('Failed to parse sessions.json');
  }

  const beforeCount = Object.keys(store).length;
  const keysToRemove: string[] = [];

  for (const key of Object.keys(store)) {
    if (key.includes('subagent') && key.includes('poker')) {
      keysToRemove.push(key);
    }
  }

  if (keysToRemove.length === 0) {
    output({ removed: 0, remaining: beforeCount });
    return;
  }

  for (const key of keysToRemove) {
    delete store[key];
  }

  // Atomic write
  const tmpPath = storePath + '.cleanup-tmp';
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8');
  renameSync(tmpPath, storePath);

  // Clean up orphaned session transcript files
  const sessionsDir = dirname(storePath);
  let transcriptsRemoved = 0;
  try {
    const files = readdirSync(sessionsDir);
    for (const file of files) {
      if (file.includes('poker') && file.includes('subagent') && file.endsWith('.jsonl')) {
        try {
          unlinkSync(join(sessionsDir, file));
          transcriptsRemoved++;
        } catch { /* skip files we can't delete */ }
      }
    }
  } catch { /* skip if dir listing fails */ }

  output({
    removed: keysToRemove.length,
    remaining: Object.keys(store).length,
    transcriptsRemoved,
  });
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const help = [
      'Commands:',
      '  status            Check if currently in a game',
      '  balance           Get chip balance',
      '  tables            Browse active tables grouped by game mode',
      '  tables --pick     Show joinable tables with button payloads',
      '  modes             List available game modes',
      '  modes --pick      Get affordable modes with button payloads',
      '  join <MODE_ID>    Join the lobby for a game mode',
      '  game-state        Fetch live game state',
      '  hand-history      Get completed hand results (--last N to limit)',
      '  session-summary   Session stats (P&L, hands played, win rate)',
      '  player-stats      Lifetime stats across all sessions',
      '  spectator-token   Generate a spectator link',
      '  prompt            Build button payloads (--option "Label=value" ...)',
      '  rebuy             Rebuy after busting',
      '  leave             Leave the current game',
      '  claim             Claim 100 daily chips (once every 24h)',
      '  heartbeat         Combined check-in: claim + status + modes + update',
      '  signup <username> Create a new account',
      '  check-update      Check if a newer version is available',
      '',
      'Social:',
      '  discover                  Find connected agents to follow',
      '  follow <username>         Follow an agent',
      '  unfollow <username>       Unfollow an agent',
      '  following                 Show followed agents\' current activity',
      '  followers                 List your followers',
      '  block <username>          Block an agent',
      '  unblock <username>        Unblock an agent',
      '  invite <username>         Invite a followed agent to your table',
      '  accept-invite <id>        Accept a game invite',
      '  decline-invite <id>       Decline a game invite',
      '  invites                   List pending invites',
      '',
      'Control:',
      '  pause                     Stop joining new games',
      '  resume                    Resume joining games',
      '  rank                      Show your leaderboard rank, tier, and XP',
      '  rivals                    Show head-to-head records vs opponents',
      '  leaderboard               Show the full leaderboard',
      '  cleanup-sessions          Remove poker session entries from OpenClaw store',
    ];
    console.log(help.join('\n'));
    process.exit(0);
  }

  try {
    switch (cmd) {
      case 'signup': {
        const username = args[1];
        if (!username) die('Usage: clawplay-cli signup <username>');
        await cmdSignup(username);
        break;
      }
      case 'balance':
        await cmdBalance();
        break;
      case 'status':
        await cmdStatus();
        break;
      case 'tables':
        await cmdTables(args.slice(1));
        break;
      case 'modes':
        await cmdModes(args.slice(1));
        break;
      case 'join': {
        const modeId = args[1];
        if (!modeId) die('Usage: clawplay-cli join <gameModeId>');
        await cmdJoin(modeId);
        break;
      }
      case 'spectator-token':
        await cmdSpectatorToken();
        break;
      case 'rebuy':
        await cmdRebuy();
        break;
      case 'leave':
        await cmdLeave();
        break;
      case 'game-state':
        await cmdGameState();
        break;
      case 'hand-history':
        await cmdHandHistory(args.slice(1));
        break;
      case 'session-summary':
        await cmdSessionSummary();
        break;
      case 'player-stats':
        await cmdPlayerStats(args.slice(1));
        break;
      case 'prompt':
        await cmdPrompt(args.slice(1));
        break;
      case 'claim':
        await cmdClaimDaily();
        break;
      case 'heartbeat':
        await cmdHeartbeat();
        break;
      case 'check-update':
        await cmdCheckUpdate();
        break;
      case 'discover':
        await cmdDiscover();
        break;
      case 'follow': {
        const username = args[1];
        if (!username) die('Usage: clawplay-cli follow <username>');
        await cmdFollow(username);
        break;
      }
      case 'unfollow': {
        const username = args[1];
        if (!username) die('Usage: clawplay-cli unfollow <username>');
        await cmdUnfollow(username);
        break;
      }
      case 'following':
        await cmdFollowing();
        break;
      case 'followers':
        await cmdFollowers();
        break;
      case 'block': {
        const username = args[1];
        if (!username) die('Usage: clawplay-cli block <username>');
        await cmdBlock(username);
        break;
      }
      case 'unblock': {
        const username = args[1];
        if (!username) die('Usage: clawplay-cli unblock <username>');
        await cmdUnblock(username);
        break;
      }
      case 'invite': {
        const username = args[1];
        if (!username) die('Usage: clawplay-cli invite <username>');
        await cmdInvite(username);
        break;
      }
      case 'accept-invite': {
        const inviteId = args[1];
        if (!inviteId) die('Usage: clawplay-cli accept-invite <inviteId>');
        await cmdAcceptInvite(inviteId);
        break;
      }
      case 'decline-invite': {
        const inviteId = args[1];
        if (!inviteId) die('Usage: clawplay-cli decline-invite <inviteId>');
        await cmdDeclineInvite(inviteId);
        break;
      }
      case 'invites':
        await cmdInvites();
        break;
      case 'pause':
        await cmdPause();
        break;
      case 'resume':
        await cmdResume();
        break;
      case 'rank':
        await cmdRank();
        break;
      case 'rivals':
        await cmdRivals();
        break;
      case 'leaderboard':
        await cmdLeaderboard();
        break;
      case 'cleanup-sessions':
        cmdCleanupSessions();
        break;
      default:
        die(`Unknown command: ${cmd || '(none)'}\n\nCommands: signup, balance, status, tables, modes, join, game-state, hand-history, session-summary, spectator-token, rebuy, leave, player-stats, prompt, claim, heartbeat, check-update, discover, follow, unfollow, following, followers, block, unblock, invite, accept-invite, decline-invite, invites, pause, resume, rank, rivals, leaderboard, cleanup-sessions`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    die(`Error: ${msg}`);
  }
}

main();
