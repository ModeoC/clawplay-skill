import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock review.ts before any imports ────────────────────────────────

const mockWriteClawPlayConfig = vi.fn();

vi.mock('../review.js', () => ({
  readClawPlayConfig: () => ({ apiKeyEnvVar: 'TEST_CLAWPLAY_KEY', accountId: 'test-account-123' }),
  writeClawPlayConfig: mockWriteClawPlayConfig,
  resolveApiKey: () => 'test-api-key-abc',
  readLocalVersion: () => '1.4.2',
  SKILL_ROOT: '/tmp/test-skill-root',
}));

// ── Capture infrastructure ───────────────────────────────────────────

let stdoutChunks: string[] = [];
let consoleLogChunks: string[] = [];
let exitCode: number | undefined;

const originalArgv = [...process.argv];

function setArgv(...args: string[]) {
  process.argv = ['node', 'clawplay-cli.js', ...args];
}

/**
 * Parse the FIRST JSON written to stdout — this is the meaningful output.
 * When die() is called, main()'s catch block re-calls die() producing a second
 * output with "Error: __EXIT_N__". We always want the first one.
 */
function firstOutput(): unknown {
  const first = stdoutChunks[0];
  if (!first) return undefined;
  return JSON.parse(first.trim());
}

/**
 * Mock fetch to return a specific response.
 * Can be called multiple times for sequential responses.
 */
function mockFetchResponse(
  data: unknown,
  opts: { ok?: boolean; status?: number } = {},
) {
  const { ok = true, status = 200 } = opts;
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok,
    status,
    text: async () => JSON.stringify(data),
    headers: new Headers(),
  } as Response);
}

function mockFetchResponses(...responses: Array<{ data: unknown; ok?: boolean; status?: number }>) {
  const spy = vi.spyOn(globalThis, 'fetch');
  for (const r of responses) {
    spy.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => JSON.stringify(r.data),
      headers: new Headers(),
    } as Response);
  }
}

// ── Setup / Teardown ─────────────────────────────────────────────────

beforeEach(() => {
  stdoutChunks = [];
  consoleLogChunks = [];
  exitCode = undefined;
  mockWriteClawPlayConfig.mockReset();

  // Capture stdout.write
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  });

  // Capture console.log (used by help text)
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    consoleLogChunks.push(args.map(String).join(' '));
  });

  // Mock process.exit to record the exit code without throwing.
  // die() is typed `: never` but our mock lets it return, so code continues
  // after die(). This is fine — we use firstOutput() to capture the first
  // (meaningful) output, and exitCode to detect that die() was called.
  // This approach avoids unhandled rejections from the floating main() promise.
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
    if (exitCode === undefined) {
      exitCode = typeof code === 'number' ? code : 0;
    }
    // Return without throwing — code after die() continues but is harmless
    return undefined as never;
  });
});

afterEach(() => {
  process.argv = [...originalArgv];
  vi.restoreAllMocks();
  // Clear module cache so each test gets a fresh main() execution
  vi.resetModules();
});

// ── Helper to run the CLI ────────────────────────────────────────────

/**
 * Dynamically import the CLI module, which auto-runs main().
 *
 * Since main() is called as a fire-and-forget at module level (line 828),
 * we need to wait for the floating promise to settle. We do this by giving
 * the microtask queue a chance to drain after the module loads.
 */
async function runCli(...args: string[]): Promise<void> {
  setArgv(...args);
  await import('../clawplay-cli.js');
  // Let the main() async work complete (it's a floating promise from module eval)
  await new Promise(resolve => setTimeout(resolve, 0));
}

// ══════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════

describe('CLI — help', () => {
  it('prints help text and exits 0 when no command given', async () => {
    await runCli(); // no args
    expect(exitCode).toBe(0);
    expect(consoleLogChunks.length).toBeGreaterThan(0);
    expect(consoleLogChunks[0]).toContain('Commands:');
  });

  it('prints help for --help flag', async () => {
    await runCli('--help');
    expect(exitCode).toBe(0);
    expect(consoleLogChunks[0]).toContain('Commands:');
  });

  it('prints help for -h flag', async () => {
    await runCli('-h');
    expect(exitCode).toBe(0);
    expect(consoleLogChunks[0]).toContain('balance');
  });
});

describe('CLI — unknown command', () => {
  it('dies with error for unknown command', async () => {
    await runCli('nonexistent-cmd');
    expect(exitCode).toBe(1);
    const out = firstOutput() as { error: string };
    expect(out.error).toContain('Unknown command: nonexistent-cmd');
  });
});

describe('CLI — balance', () => {
  it('outputs chip balance from numeric response', async () => {
    mockFetchResponse(5000);
    await runCli('balance');
    expect(exitCode).toBeUndefined(); // no exit = success
    const out = firstOutput() as { chips: number };
    expect(out.chips).toBe(5000);
  });

  it('outputs chip balance from object response', async () => {
    mockFetchResponse({ balance: 1234 });
    await runCli('balance');
    const out = firstOutput() as { chips: number };
    expect(out.chips).toBe(1234);
  });

  it('dies on API error', async () => {
    mockFetchResponse({ message: 'Unauthorized' }, { ok: false, status: 401 });
    await runCli('balance');
    expect(exitCode).toBe(1);
    const out = firstOutput() as { error: string };
    expect(out.error).toContain('Balance failed (401)');
  });
});

describe('CLI — status', () => {
  it('outputs playing status with tableId', async () => {
    mockFetchResponse({ status: 'playing', gameId: 'table-xyz' });
    await runCli('status');
    const out = firstOutput() as { status: string; tableId: string };
    expect(out.status).toBe('playing');
    expect(out.tableId).toBe('table-xyz');
  });

  it('outputs idle status', async () => {
    mockFetchResponse({ status: 'idle' });
    await runCli('status');
    const out = firstOutput() as { status: string };
    expect(out.status).toBe('idle');
  });

  it('includes lastGameId when present', async () => {
    mockFetchResponse({ status: 'idle', lastGameId: 'prev-game' });
    await runCli('status');
    const out = firstOutput() as { status: string; lastGameId: string };
    expect(out.status).toBe('idle');
    expect(out.lastGameId).toBe('prev-game');
  });
});

describe('CLI — modes', () => {
  const sampleModes = [
    { id: 'mode-1', name: 'Low Stakes', smallBlind: 5, bigBlind: 10, buyIn: 100, maxPlayers: 6 },
    { id: 'mode-2', name: 'High Stakes', smallBlind: 50, bigBlind: 100, buyIn: 1000, maxPlayers: 6 },
  ];

  it('lists modes without --pick', async () => {
    mockFetchResponse(sampleModes);
    await runCli('modes');
    const out = firstOutput() as Array<{ id: string; name: string; buyIn: number }>;
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('mode-1');
    expect(out[0].name).toBe('Low Stakes');
    expect(out[0].buyIn).toBe(100);
  });

  it('filters affordable modes with --pick and includes button payloads', async () => {
    // First call: GET /api/game-modes
    // Second call: GET /api/chips/balance
    mockFetchResponses(
      { data: sampleModes },
      { data: { balance: 500 } },
    );
    await runCli('modes', '--pick');
    const out = firstOutput() as { chips: number; modes: unknown[]; buttons: unknown };
    expect(out.chips).toBe(500);
    // Only Low Stakes (buyIn 100) is affordable with 500 chips
    expect(out.modes).toHaveLength(1);
    expect((out.modes[0] as { name: string }).name).toBe('Low Stakes');
    expect(out.buttons).toBeDefined();
  });

  it('dies when no affordable modes with --pick', async () => {
    mockFetchResponses(
      { data: sampleModes },
      { data: { balance: 10 } }, // too broke for any mode
    );
    await runCli('modes', '--pick');
    expect(exitCode).toBe(2);
    const out = firstOutput() as { error: string };
    expect(out.error).toContain('Not enough chips');
  });
});

describe('CLI — join', () => {
  it('joins a game mode', async () => {
    mockFetchResponse({ status: 'seated', tableId: 'table-123' });
    await runCli('join', 'low-stakes');
    const out = firstOutput() as { status: string; tableId: string };
    expect(out.status).toBe('seated');
    expect(out.tableId).toBe('table-123');
  });

  it('dies without mode argument', async () => {
    await runCli('join');
    expect(exitCode).toBe(1);
    const out = firstOutput() as { error: string };
    expect(out.error).toContain('Usage: clawplay-cli join');
  });
});

describe('CLI — game-state', () => {
  it('outputs game state', async () => {
    const gameState = { gameId: 'g-1', phase: 'PREFLOP', pot: 30, yourChips: 970 };
    mockFetchResponse(gameState);
    await runCli('game-state');
    const out = firstOutput() as Record<string, unknown>;
    expect(out.phase).toBe('PREFLOP');
    expect(out.pot).toBe(30);
  });
});

describe('CLI — hand-history', () => {
  it('fetches hand history without --last', async () => {
    mockFetchResponse([{ hand: 1, winner: 'Bot' }]);
    await runCli('hand-history');
    const out = firstOutput() as unknown[];
    expect(out).toHaveLength(1);
  });

  it('passes --last as query param', async () => {
    mockFetchResponse([{ hand: 5 }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify([{ hand: 5 }]),
      headers: new Headers(),
    } as Response);
    await runCli('hand-history', '--last', '3');
    // Verify the URL includes ?last=3
    const callUrl = fetchSpy.mock.calls[0][0] as string;
    expect(callUrl).toContain('/api/me/game/history?last=3');
  });

  it('dies on invalid --last value', async () => {
    await runCli('hand-history', '--last', 'abc');
    expect(exitCode).toBe(1);
    const out = firstOutput() as { error: string };
    expect(out.error).toContain('--last must be a positive integer');
  });
});

describe('CLI — session-summary', () => {
  it('outputs session summary', async () => {
    const summary = { handsPlayed: 20, netChips: 150, winRate: 0.35 };
    mockFetchResponse(summary);
    await runCli('session-summary');
    const out = firstOutput() as Record<string, unknown>;
    expect(out.handsPlayed).toBe(20);
  });
});

describe('CLI — spectator-token', () => {
  it('returns formatted spectator URL', async () => {
    mockFetchResponse({ gameId: 'game-42', token: 'stk_abc' });
    await runCli('spectator-token');
    const out = firstOutput() as { url: string };
    expect(out.url).toBe('https://clawplay.fun/watch/game-42?token=stk_abc');
  });
});

describe('CLI — rebuy', () => {
  it('outputs chips after rebuy', async () => {
    mockFetchResponse({ yourChips: 1000 });
    await runCli('rebuy');
    const out = firstOutput() as { chips: number };
    expect(out.chips).toBe(1000);
  });
});

describe('CLI — leave', () => {
  it('outputs leave response', async () => {
    mockFetchResponse({ status: 'left' });
    await runCli('leave');
    const out = firstOutput() as { status: string };
    expect(out.status).toBe('left');
  });
});

describe('CLI — signup', () => {
  it('signs up a user', async () => {
    mockFetchResponse({ apiKey: 'key-123', userId: 'user-1' });
    await runCli('signup', 'testbot');
    const out = firstOutput() as { apiKey: string; userId: string };
    expect(out.apiKey).toBe('key-123');
  });

  it('dies without username', async () => {
    await runCli('signup');
    expect(exitCode).toBe(1);
    const out = firstOutput() as { error: string };
    expect(out.error).toContain('Usage: clawplay-cli signup');
  });

  it('dies on signup failure', async () => {
    mockFetchResponse({ message: 'Username taken' }, { ok: false, status: 409 });
    await runCli('signup', 'taken-name');
    expect(exitCode).toBe(1);
    const out = firstOutput() as { error: string };
    expect(out.error).toContain('Signup failed (409)');
  });
});

describe('CLI — claim', () => {
  it('outputs claim result on success', async () => {
    mockFetchResponse({ claimed: 100, balance: 1100 });
    await runCli('claim');
    const out = firstOutput() as { claimed: number; balance: number };
    expect(out.claimed).toBe(100);
  });

  it('exits with code 2 on 429 (already claimed)', async () => {
    mockFetchResponse(
      { message: 'Already claimed today', nextClaimAt: '2026-03-19T00:00:00Z' },
      { ok: false, status: 429 },
    );
    await runCli('claim');
    expect(exitCode).toBe(2);
    const out = firstOutput() as { message: string };
    expect(out.message).toContain('Already claimed');
  });

  it('dies on other claim errors', async () => {
    mockFetchResponse({ message: 'Server error' }, { ok: false, status: 500 });
    await runCli('claim');
    expect(exitCode).toBe(1);
    const out = firstOutput() as { error: string };
    expect(out.error).toContain('Claim failed (500)');
  });
});

describe('CLI — check-update', () => {
  it('reports update info', async () => {
    // getUpdateInfo() fetches GitHub raw SKILL.md and parses version from frontmatter.
    // readLocalVersion() is mocked to return '1.4.2' via review.js mock.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '---\nversion: 1.5.0\n---\n# Skill',
      headers: new Headers(),
    } as Response);

    await runCli('check-update');
    const out = firstOutput() as { local: string; remote: string; updateAvailable: boolean };
    expect(out.local).toBe('1.4.2');
    expect(out.remote).toBe('1.5.0');
    expect(out.updateAvailable).toBe(true);
  });

  it('handles unreachable remote gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));
    await runCli('check-update');
    const out = firstOutput() as { local: string; remote: string; updateAvailable: boolean };
    expect(out.local).toBe('1.4.2');
    expect(out.remote).toBe('unknown');
    expect(out.updateAvailable).toBe(false);
  });
});

describe('CLI — prompt', () => {
  it('builds button payloads from --option flags', async () => {
    await runCli('prompt', '--option', 'Fold=fold', '--option', 'Call=call', '--option', 'Raise=raise');
    const out = firstOutput() as { buttons: { telegram: unknown[][]; discord: unknown; fallback: string } };
    expect(out.buttons.telegram).toHaveLength(3);
    expect(out.buttons.fallback).toContain('1. Fold');
    expect(out.buttons.fallback).toContain('2. Call');
    expect(out.buttons.fallback).toContain('3. Raise');
  });

  it('telegram buttons have correct structure', async () => {
    await runCli('prompt', '--option', 'Yes=yes', '--option', 'No=no');
    const out = firstOutput() as { buttons: { telegram: Array<Array<{ text: string; callback_data: string }>> } };
    expect(out.buttons.telegram[0][0].text).toBe('Yes');
    expect(out.buttons.telegram[0][0].callback_data).toBe('yes');
    expect(out.buttons.telegram[1][0].text).toBe('No');
    expect(out.buttons.telegram[1][0].callback_data).toBe('no');
  });

  it('discord components chunk into groups of 5', async () => {
    const options = Array.from({ length: 7 }, (_, i) => `--option`);
    const args: string[] = [];
    for (let i = 0; i < 7; i++) {
      args.push('--option', `Opt${i + 1}=val${i + 1}`);
    }
    await runCli('prompt', ...args);
    const out = firstOutput() as { buttons: { discord: { blocks: Array<{ type: string; buttons: unknown[] }> } } };
    expect(out.buttons.discord.blocks).toHaveLength(2); // 5 + 2
    expect(out.buttons.discord.blocks[0].buttons).toHaveLength(5);
    expect(out.buttons.discord.blocks[1].buttons).toHaveLength(2);
  });

  it('discord first button is primary, rest secondary', async () => {
    await runCli('prompt', '--option', 'A=a', '--option', 'B=b', '--option', 'C=c');
    const out = firstOutput() as { buttons: { discord: { blocks: Array<{ buttons: Array<{ label: string; style: string }> }> } } };
    const buttons = out.buttons.discord.blocks[0].buttons;
    expect(buttons[0].style).toBe('primary');
    expect(buttons[1].style).toBe('secondary');
    expect(buttons[2].style).toBe('secondary');
  });

  it('dies with fewer than 2 options', async () => {
    await runCli('prompt', '--option', 'Only=one');
    expect(exitCode).toBe(1);
    const out = firstOutput() as { error: string };
    expect(out.error).toContain('At least 2 --option flags required');
  });

  it('dies on invalid option format (no equals)', async () => {
    await runCli('prompt', '--option', 'noequalssign', '--option', 'OK=ok');
    expect(exitCode).toBe(1);
    const out = firstOutput() as { error: string };
    expect(out.error).toContain('Invalid --option format');
  });
});

describe('CLI — pause / resume', () => {
  it('pause writes config and outputs paused status', async () => {
    await runCli('pause');
    expect(mockWriteClawPlayConfig).toHaveBeenCalledWith({ paused: true });
    const out = firstOutput() as { status: string };
    expect(out.status).toBe('paused');
  });

  it('resume writes config and outputs resumed status', async () => {
    await runCli('resume');
    expect(mockWriteClawPlayConfig).toHaveBeenCalledWith({ paused: false });
    const out = firstOutput() as { status: string };
    expect(out.status).toBe('resumed');
  });
});

describe('CLI — discover', () => {
  it('outputs agents array with count', async () => {
    const agents = [{ username: 'bot1' }, { username: 'bot2' }];
    // discover uses raw fetch (public endpoint), not api()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify(agents),
      headers: new Headers(),
    } as Response);
    await runCli('discover');
    const out = firstOutput() as { agents: unknown[]; count: number };
    expect(out.agents).toHaveLength(2);
    expect(out.count).toBe(2);
  });
});

describe('CLI — social commands', () => {
  it('follow requires username argument', async () => {
    await runCli('follow');
    expect(exitCode).toBe(1);
    const out = firstOutput() as { error: string };
    expect(out.error).toContain('Usage: clawplay-cli follow');
  });

  it('follow posts to API', async () => {
    mockFetchResponse({ followed: true });
    await runCli('follow', 'otherbot');
    const out = firstOutput() as { followed: boolean };
    expect(out.followed).toBe(true);
  });

  it('unfollow requires username argument', async () => {
    await runCli('unfollow');
    expect(exitCode).toBe(1);
  });

  it('following lists followed agents', async () => {
    mockFetchResponse([{ username: 'friend1' }, { username: 'friend2' }]);
    await runCli('following');
    const out = firstOutput() as { following: unknown[]; count: number };
    expect(out.count).toBe(2);
  });

  it('followers lists followers', async () => {
    mockFetchResponse([{ username: 'fan1' }]);
    await runCli('followers');
    const out = firstOutput() as { followers: unknown[]; count: number };
    expect(out.count).toBe(1);
  });

  it('block requires username argument', async () => {
    await runCli('block');
    expect(exitCode).toBe(1);
  });

  it('invite requires username argument', async () => {
    await runCli('invite');
    expect(exitCode).toBe(1);
  });

  it('accept-invite requires inviteId argument', async () => {
    await runCli('accept-invite');
    expect(exitCode).toBe(1);
    const out = firstOutput() as { error: string };
    expect(out.error).toContain('Usage: clawplay-cli accept-invite');
  });

  it('decline-invite requires inviteId argument', async () => {
    await runCli('decline-invite');
    expect(exitCode).toBe(1);
  });

  it('invites lists pending invites', async () => {
    mockFetchResponse([{ id: 'inv-1', from: 'bot1' }]);
    await runCli('invites');
    const out = firstOutput() as { invites: unknown[]; count: number };
    expect(out.count).toBe(1);
  });
});

describe('CLI — leaderboard', () => {
  it('outputs leaderboard data', async () => {
    const lb = [
      { id: 'u1', username: 'top-player', rank: 1, totalXp: 5000 },
      { id: 'u2', username: 'runner-up', rank: 2, totalXp: 3000 },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify(lb),
      headers: new Headers(),
    } as Response);
    await runCli('leaderboard');
    const out = firstOutput() as unknown[];
    expect(out).toHaveLength(2);
  });
});

describe('CLI — player-stats', () => {
  it('uses provided userId', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify({ totalXp: 999 }),
      headers: new Headers(),
    } as Response);
    await runCli('player-stats', 'custom-user-id');
    const callUrl = fetchSpy.mock.calls[0][0] as string;
    expect(callUrl).toContain('/api/public/stats/custom-user-id');
  });

  it('falls back to accountId from config when no userId arg', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify({ totalXp: 500 }),
      headers: new Headers(),
    } as Response);
    await runCli('player-stats');
    const callUrl = fetchSpy.mock.calls[0][0] as string;
    expect(callUrl).toContain('/api/public/stats/test-account-123');
  });
});

describe('CLI — tables', () => {
  const tableSummary = {
    gameModes: [
      { id: 'm1', name: 'Micro', smallBlind: 1, bigBlind: 2, ante: 0, buyIn: 50, maxPlayers: 6, activeTables: 2, openSeats: 3, totalPlayers: 9 },
      { id: 'm2', name: 'Mid', smallBlind: 10, bigBlind: 20, ante: 0, buyIn: 500, maxPlayers: 6, activeTables: 1, openSeats: 0, totalPlayers: 6 },
    ],
  };

  it('lists tables without --pick', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify(tableSummary),
      headers: new Headers(),
    } as Response);
    await runCli('tables');
    const out = firstOutput() as { gameModes: unknown[] };
    expect(out.gameModes).toHaveLength(2);
  });

  it('filters joinable tables with --pick', async () => {
    // First call: public tables summary (no auth)
    // Second call: balance (with auth via api())
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify(tableSummary),
        headers: new Headers(),
      } as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify({ balance: 200 }),
        headers: new Headers(),
      } as Response);
    await runCli('tables', '--pick');
    const out = firstOutput() as { chips: number; joinable: Array<{ name: string }> };
    expect(out.chips).toBe(200);
    // Micro: buyIn 50 <= 200 AND openSeats 3 > 0 → joinable
    // Mid: buyIn 500 > 200 → not affordable
    expect(out.joinable).toHaveLength(1);
    expect(out.joinable[0].name).toBe('Micro');
  });

  it('reports no joinable tables when all seats full or too expensive', async () => {
    const fullTables = {
      gameModes: [
        { id: 'm1', name: 'Micro', smallBlind: 1, bigBlind: 2, ante: 0, buyIn: 50, maxPlayers: 6, activeTables: 1, openSeats: 0, totalPlayers: 6 },
      ],
    };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify(fullTables),
        headers: new Headers(),
      } as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify({ balance: 200 }),
        headers: new Headers(),
      } as Response);
    await runCli('tables', '--pick');
    const out = firstOutput() as { joinable: unknown[]; message: string };
    expect(out.joinable).toHaveLength(0);
    expect(out.message).toContain('No joinable tables');
  });
});

describe('CLI — heartbeat', () => {
  it('combines heartbeat API and update check', async () => {
    // heartbeat calls: api('GET', '/api/lobby/heartbeat') + getUpdateInfo() (fetch GitHub)
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify({ status: 'idle', balance: 500, dailyClaim: { available: true } }),
        headers: new Headers(),
      } as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => '---\nversion: 1.4.2\n---\n# Skill',
        headers: new Headers(),
      } as Response);
    await runCli('heartbeat');
    const out = firstOutput() as { status: string; balance: number; update: { local: string; remote: string; updateAvailable: boolean } };
    expect(out.status).toBe('idle');
    expect(out.balance).toBe(500);
    expect(out.update.local).toBe('1.4.2');
    expect(out.update.updateAvailable).toBe(false); // same version
  });
});

describe('CLI — rank', () => {
  it('composes rank from me + leaderboard + stats', async () => {
    // rank calls: api('GET', '/api/auth/me'), api('GET', '/api/public/leaderboard'), api('GET', '/api/public/stats/:id')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify({ userId: 'u-me', username: 'makuro-bot' }),
        headers: new Headers(),
      } as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify([
          { id: 'u-me', username: 'makuro-bot', rank: 3, totalXp: 2000, tier: 'silver_1', tierLabel: 'Silver I', rankDelta: 1, weeklyWinnings: 150 },
        ]),
        headers: new Headers(),
      } as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify({ totalXp: 2000, tier: 'silver_1', tierLabel: 'Silver I', xpToNextTier: 500, percentToNextTier: 60 }),
        headers: new Headers(),
      } as Response);
    await runCli('rank');
    const out = firstOutput() as { rank: number; username: string; tier: string; xpToNextTier: number };
    expect(out.rank).toBe(3);
    expect(out.username).toBe('makuro-bot');
    expect(out.tier).toBe('silver_1');
    expect(out.xpToNextTier).toBe(500);
  });
});

describe('CLI — rivals', () => {
  it('fetches rivals for current user', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify({ userId: 'u-me' }),
        headers: new Headers(),
      } as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify([{ opponent: 'rival-bot', wins: 5, losses: 3 }]),
        headers: new Headers(),
      } as Response);
    await runCli('rivals');
    const out = firstOutput() as unknown[];
    expect(out).toHaveLength(1);
  });
});

describe('CLI — API error propagation', () => {
  it('wraps network errors in die()', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await runCli('balance');
    expect(exitCode).toBe(1);
    const out = firstOutput() as { error: string };
    expect(out.error).toContain('ECONNREFUSED');
  });
});

describe('CLI — fetch sends correct headers', () => {
  it('authenticated endpoints include x-api-key header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify({ balance: 100 }),
      headers: new Headers(),
    } as Response);
    await runCli('balance');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-api-key-abc');
  });

  it('join sends POST with JSON body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify({ status: 'seated' }),
      headers: new Headers(),
    } as Response);
    await runCli('join', 'test-mode');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/lobby/join');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ gameModeId: 'test-mode' });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });
});
