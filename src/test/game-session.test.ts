import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { GameSession } from '../game-session.js';
import type { GameSessionConfig } from '../game-session.js';
import type { PlayerView, ListenerContext, ListenerOutput, GameTransition } from '../types.js';
import { SUPPRESSIBLE_SIGNALS } from '../review.js';
import {
  makeView, makeContext, makeMockGatewayClient,
  makeSession, makeRealNotifySession,
} from './helpers.js';
import type { MockGatewayClient } from './helpers.js';

// ── Mock child_process.execFile (prevents 60s timeout in notifyAgent tests) ──
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  return {
    ...orig,
    execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      // Immediately call back with error — openclaw isn't available in test
      cb(new Error('openclaw not found (mocked)'));
    },
  };
});

// ── Global fetch stub (prevents real HTTP calls + 3s retry delays) ──
const _originalFetch = globalThis.fetch;
globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => '' })) as unknown as typeof fetch;
afterAll(() => { globalThis.fetch = _originalFetch; });

// ── Tests ───────────────────────────────────────────────────────────

describe('GameSession — construction', () => {
  it('initializes with default state', () => {
    const { session } = makeSession();

    expect(session.gameId).toBe('unknown');
    expect(session.currentHandNumber).toBeNull();
    expect(session.decisionSeq).toBe(0);
    expect(session.consecutiveDecisionFailures).toBe(0);
    expect(session.reflectionsSent).toBe(0);
    expect(session.reflectionTimeouts).toBe(0);
    expect(session.handsSinceReflection).toBe(0);
    expect(session.reflectionInFlight).toBe(false);
    expect(session.gameStartedEmitted).toBe(false);
    expect(session.recentEvents).toEqual([]);
    expect(session.currentHandEvents).toEqual([]);
    expect(session.stackBeforeHand).toBeNull();
    expect(session.foldedInHand).toBeNull();
    expect(session.personalityContext).toBe('');
    expect(session.sseFirstConnect).toBe(true);
    expect(session.reconnectAttempts).toBe(0);
    expect(session.lastTransitions).toEqual([]);
  });

  it('stores config values', () => {
    const { session } = makeSession({ channel: 'discord', chatId: '999', agentId: 'jiro' });

    expect(session.channel).toBe('discord');
    expect(session.chatId).toBe('999');
    expect(session.agentId).toBe('jiro');
  });
});

describe('GameSession — handleStateEvent', () => {
  it('updates gameId from first view', () => {
    const { session } = makeSession();
    const context = makeContext();
    const view = makeView({ gameId: 'table-abc' });

    session.handleStateEvent(view, context, () => {});

    expect(session.gameId).toBe('table-abc');
  });

  it('tracks currentHandNumber', () => {
    const { session } = makeSession();
    const context = makeContext();

    session.handleStateEvent(makeView({ handNumber: 1 }), context, () => {});
    expect(session.currentHandNumber).toBe(1);

    session.handleStateEvent(makeView({ handNumber: 2 }), context, () => {});
    expect(session.currentHandNumber).toBe(2);
  });

  it('resets reconnectAttempts on state event', () => {
    const { session } = makeSession();
    const context = makeContext();
    session.reconnectAttempts = 3;

    session.handleStateEvent(makeView(), context, () => {});
    expect(session.reconnectAttempts).toBe(0);
  });

  it('calls gracefulExit on pending leave at SHOWDOWN', () => {
    const { session } = makeSession();
    const context = makeContext();
    let exitCalled = false;
    let exitReason = '';

    // Set up prevState so processStateEvent doesn't crash
    session.handleStateEvent(makeView({ phase: 'RIVER' }), context, () => {});

    session.handleStateEvent(
      makeView({ phase: 'SHOWDOWN', hasPendingLeave: true }),
      context,
      (reason, _code) => { exitCalled = true; exitReason = reason; },
    );

    expect(exitCalled).toBe(true);
    expect(exitReason).toBe('Left the table');
  });

  it('tracks stackBeforeHand on hand change', () => {
    const { session } = makeSession();
    const context = makeContext();

    session.handleStateEvent(makeView({ handNumber: 1, yourChips: 1000 }), context, () => {});
    expect(session.stackBeforeHand).toBe(1000);

    session.handleStateEvent(makeView({ handNumber: 2, yourChips: 1050 }), context, () => {});
    expect(session.stackBeforeHand).toBe(1050);
  });

  it('resets currentHandEvents on hand change', () => {
    const { session } = makeSession();
    const context = makeContext();

    session.handleStateEvent(makeView({ handNumber: 1 }), context, () => {});
    // Simulate events accumulating
    session.currentHandEvents.push('test event');
    expect(session.currentHandEvents.length > 0).toBe(true);

    session.handleStateEvent(makeView({ handNumber: 2 }), context, () => {});
    expect(session.currentHandEvents).not.toContain('test event');
  });

  it('increments handsSinceReflection on hand change', () => {
    const { session } = makeSession({ reflectEveryNHands: 100 }); // high threshold to prevent triggering
    const context = makeContext();

    session.handleStateEvent(makeView({ handNumber: 1 }), context, () => {});
    expect(session.handsSinceReflection).toBe(0); // first hand, no increment

    session.handleStateEvent(makeView({ handNumber: 2 }), context, () => {});
    expect(session.handsSinceReflection).toBe(1);

    session.handleStateEvent(makeView({ handNumber: 3 }), context, () => {});
    expect(session.handsSinceReflection).toBe(2);
  });
});

describe('GameSession — transition parsing', () => {
  it('stores transitions from SSE data', () => {
    const { session, debugLog } = makeSession();
    const context = makeContext();

    const transitions: GameTransition[] = [
      { type: 'player-action', seat: 1, playerName: 'Alice' },
      { type: 'deal-cards', seat: 0 },
    ];

    const data = { ...makeView(), transitions };
    session.handleStateEvent(data, context, () => {});

    expect(session.lastTransitions).toHaveLength(2);
    expect(session.lastTransitions[0].type).toBe('player-action');
    expect(session.lastTransitions[1].type).toBe('deal-cards');

    const transitionDebug = debugLog.find(d => d.label === 'TRANSITIONS');
    expect(transitionDebug).toBeTruthy();
    expect(transitionDebug!.data.count).toBe(2);
  });

  it('defaults to empty transitions when none present', () => {
    const { session } = makeSession();
    const context = makeContext();

    session.handleStateEvent(makeView(), context, () => {});
    expect(session.lastTransitions).toEqual([]);
  });
});

describe('GameSession — handleOutputs', () => {
  it('tracks events in recentEvents and currentHandEvents', () => {
    const { session } = makeSession();
    const context = makeContext();
    const view = makeView();

    const outputs: ListenerOutput[] = [
      { type: 'EVENT', message: '**[Hand #1]** Alice raised to 40', handNumber: 1 },
      { type: 'EVENT', message: '**[Hand #1]** Bob called 40', handNumber: 1 },
    ];

    session.handleOutputs(outputs, view, [], context);

    expect(session.recentEvents).toHaveLength(2);
    expect(session.currentHandEvents).toHaveLength(2);
    expect(session.recentEvents[0]).toContain('Alice raised');
    expect(session.currentHandEvents[1]).toContain('Bob called');
  });

  it('emits GAME_STARTED on first hand event', () => {
    const { session, emitted } = makeSession();
    const context = makeContext();
    const view = makeView();

    const outputs: ListenerOutput[] = [
      { type: 'EVENT', message: '**[Hand #1]** New hand dealt', handNumber: 1 },
    ];

    session.handleOutputs(outputs, view, [], context);

    expect(session.gameStartedEmitted).toBe(true);
    const gameStarted = emitted.find(e => e.type === 'GAME_STARTED');
    expect(gameStarted).toBeTruthy();
  });

  it('only emits GAME_STARTED once', () => {
    const { session, emitted } = makeSession();
    const context = makeContext();
    const view = makeView();

    session.handleOutputs(
      [{ type: 'EVENT', message: '**[Hand #1]** dealt', handNumber: 1 }],
      view, [], context,
    );
    session.handleOutputs(
      [{ type: 'EVENT', message: '**[Hand #2]** dealt', handNumber: 2 }],
      view, [], context,
    );

    const gameStartedCount = emitted.filter(e => e.type === 'GAME_STARTED').length;
    expect(gameStartedCount).toBe(1);
  });

  it('suppresses post-fold events for the folded hand', () => {
    const { session } = makeSession();
    const context = makeContext();
    const view = makeView();
    session.foldedInHand = 1;

    const outputs: ListenerOutput[] = [
      { type: 'EVENT', message: 'something happened', handNumber: 1 },
    ];

    session.handleOutputs(outputs, view, [], context);

    // Should not track the event (it was suppressed)
    expect(session.recentEvents).toHaveLength(0);
    expect(session.currentHandEvents).toHaveLength(0);
  });

  it('does NOT suppress YOUR_TURN even when folded', () => {
    const { session } = makeSession();
    const context = makeContext();
    const view = makeView({ isYourTurn: true, availableActions: [{ type: 'check' }] });
    session.foldedInHand = 1;
    session.currentHandNumber = 1;

    const outputs: ListenerOutput[] = [
      { type: 'YOUR_TURN', state: view, summary: 'PREFLOP | As Kh' },
    ];

    session.handleOutputs(outputs, view, [], context);

    // The decision seq should have been incremented (meaning sendDecision was called)
    expect(session.decisionSeq).toBe(1);
  });

  it('caps recentEvents at 20', () => {
    const { session } = makeSession();
    const context = makeContext();
    const view = makeView();

    for (let i = 0; i < 25; i++) {
      session.handleOutputs(
        [{ type: 'EVENT', message: `**[Hand #${i}]** event ${i}`, handNumber: i }],
        view, [], context,
      );
    }

    expect(session.recentEvents).toHaveLength(20);
    expect(session.recentEvents[0]).toContain('event 5');
  });
});

describe('GameSession — getReflectionStats', () => {
  it('returns undefined when no reflections sent', () => {
    const { session } = makeSession();
    expect(session.getReflectionStats()).toBeUndefined();
  });

  it('returns stats string when reflections were sent', () => {
    const { session } = makeSession();
    session.reflectionsSent = 5;
    session.reflectionTimeouts = 1;

    const stats = session.getReflectionStats();
    expect(stats).toContain('1 reflection timeout');
    expect(stats).toContain('5 reflections');
  });

  it('pluralizes correctly for singular', () => {
    const { session } = makeSession();
    session.reflectionsSent = 1;
    session.reflectionTimeouts = 1;

    const stats = session.getReflectionStats();
    expect(stats).toContain('1 reflection timeout out of 1 reflection');
    expect(stats).not.toContain('timeouts');
    expect(stats).not.toContain('reflections');
  });
});

describe('GameSession — onSSEOpen', () => {
  it('resets connection state', () => {
    const { session } = makeSession();
    session.reconnectAttempts = 3;
    session.consecutiveDecisionFailures = 2;

    session.onSSEOpen();

    expect(session.reconnectAttempts).toBe(0);
    expect(session.consecutiveDecisionFailures).toBe(0);
    expect(session.sseFirstConnect).toBe(false);
  });

  it('emits SSE_RECONNECT on subsequent opens', () => {
    const { session, emitted } = makeSession();

    // First open
    session.onSSEOpen();
    expect(emitted.find(e => e.type === 'SSE_RECONNECT')).toBeFalsy();

    // Second open
    session.onSSEOpen();
    expect(emitted.find(e => e.type === 'SSE_RECONNECT')).toBeTruthy();
  });
});

describe('GameSession — static constants', () => {
  it('has correct MAX_CONSECUTIVE_FAILURES', () => {
    expect(GameSession.MAX_CONSECUTIVE_FAILURES).toBe(3);
  });

  it('has correct HAND_UPDATE_COOLDOWN_MS', () => {
    expect(GameSession.HAND_UPDATE_COOLDOWN_MS).toBe(30_000);
  });
});

// ── sendDecision ────────────────────────────────────────────────────

describe('GameSession — sendDecision', () => {
  it('increments decisionSeq and chains to lastDecision', async () => {
    const { session } = makeSession();
    const context = makeContext();

    session.sendDecision('test prompt', context);
    expect(session.decisionSeq).toBe(1);

    session.sendDecision('test prompt 2', context);
    expect(session.decisionSeq).toBe(2);

    // Wait for chain to settle
    await session.lastDecision;
  });

  it('increments decisionCount on each call', async () => {
    const { session } = makeSession();
    const context = makeContext();

    expect(session.decisionCount).toBe(0);
    session.sendDecision('prompt 1', context);
    expect(session.decisionCount).toBe(1);
    session.sendDecision('prompt 2', context);
    expect(session.decisionCount).toBe(2);

    await session.lastDecision;
  });

  it('emits DECISION_STALE when a newer decision supersedes', async () => {
    const mockGw = makeMockGatewayClient();
    let callCount = 0;
    let resolveFirst: (() => void) | null = null;
    mockGw.callAgent = () => {
      callCount++;
      if (callCount === 1) {
        return new Promise(resolve => {
          resolveFirst = () => resolve({ payloads: [{ text: '{"action":"call"}' }] });
        });
      }
      return Promise.resolve({ payloads: [{ text: '{"action":"fold"}' }] });
    };

    const { session, emitted } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    session.sendDecision('prompt 1', context);
    expect(session.decisionSeq).toBe(1);

    await new Promise(r => setTimeout(r, 10));

    session.sendDecision('prompt 2', context);
    expect(session.decisionSeq).toBe(2);

    expect(resolveFirst).toBeTruthy();
    resolveFirst!();
    await session.lastDecision;

    const stale = emitted.find(e => e.type === 'DECISION_STALE');
    expect(stale).toBeTruthy();
  });

  it('resets consecutiveDecisionFailures on successful action parse', async () => {
    const { session } = makeSession();
    const context = makeContext();
    session.consecutiveDecisionFailures = 2;
    session.currentHandNumber = 1;

    session.sendDecision('test prompt', context);
    await session.lastDecision;

    expect(session.consecutiveDecisionFailures).toBe(0);
  });

  it('sets foldedInHand when action is fold', async () => {
    const { session } = makeSession();
    const context = makeContext();
    session.currentHandNumber = 5;

    session.sendDecision('test prompt', context);
    await session.lastDecision;

    expect(session.foldedInHand).toBe(5);
  });

  it('increments consecutiveDecisionFailures on agent error', async () => {
    const mockGw = makeMockGatewayClient();
    mockGw.callAgent = async () => { throw new Error('agent timeout'); };

    const { session, emitted } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    session.sendDecision('test prompt', context);
    await session.lastDecision;

    expect(session.consecutiveDecisionFailures).toBe(1);
    const failure = emitted.find(e => e.type === 'DECISION_FAILURE');
    expect(failure).toBeTruthy();
  });

  it('logs DECISION_FAILURE to debug on agent error', async () => {
    const mockGw = makeMockGatewayClient();
    mockGw.callAgent = async () => { throw new Error('agent timeout'); };

    const { session, debugLog } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    session.sendDecision('test prompt', context);
    await session.lastDecision;

    const debugEntry = debugLog.find(e => e.label === 'DECISION_FAILURE');
    expect(debugEntry).toBeTruthy();
    expect(debugEntry!.data.error).toBe('agent timeout');
    expect(debugEntry!.data.gwConnected).toBe(true);
    expect(debugEntry!.data.hand).toBe(1);
  });

  it('logs DECISION_FAILURE to debug when no action parsed', async () => {
    const mockGw = makeMockGatewayClient();
    mockGw.callAgent = async () => ({ payloads: [{ text: 'no json here' }] });

    const { session, debugLog } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 2;

    session.sendDecision('test prompt', context);
    await session.lastDecision;

    const debugEntry = debugLog.find(e => e.label === 'DECISION_FAILURE');
    expect(debugEntry).toBeTruthy();
    expect(debugEntry!.data.reason).toBe('no_action');
    expect(debugEntry!.data.hand).toBe(2);
  });

  it('calls onFatalDecisionFailure after MAX_CONSECUTIVE_FAILURES', async () => {
    const mockGw = makeMockGatewayClient();
    mockGw.callAgent = async () => { throw new Error('agent timeout'); };

    const { session } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;
    session.consecutiveDecisionFailures = GameSession.MAX_CONSECUTIVE_FAILURES - 1;

    let fatalCalled = false;
    let fatalReason = '';
    session.onFatalDecisionFailure = (reason) => { fatalCalled = true; fatalReason = reason; };

    session.sendDecision('test prompt', context);
    await session.lastDecision;

    expect(fatalCalled).toBe(true);
    expect(fatalReason).toContain('consecutive decision failures');
  });

  it('emits DECISION_PARSE_ERROR when agent returns invalid JSON', async () => {
    const mockGw = makeMockGatewayClient();
    mockGw.callAgent = async () => ({ payloads: [{ text: 'not valid json at all' }] });

    const { session, emitted } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    session.sendDecision('test prompt', context);
    await session.lastDecision;

    const failure = emitted.find(e => e.type === 'DECISION_FAILURE' && e.reason === 'no_action');
    expect(failure).toBeTruthy();
    expect(session.consecutiveDecisionFailures).toBe(1);
  });

  it('emits DECISION_STALE_HAND when hand moved during decision', async () => {
    const mockGw = makeMockGatewayClient();
    let resolveCall: (() => void) | null = null;
    mockGw.callAgent = () => new Promise(resolve => {
      resolveCall = () => resolve({ payloads: [{ text: '{"action":"call"}' }] });
    });

    const { session, emitted } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 3;

    session.sendDecision('test prompt', context);

    await new Promise(r => setTimeout(r, 10));

    session.currentHandNumber = 4;
    expect(resolveCall).toBeTruthy();
    resolveCall!();
    await new Promise(r => setTimeout(r, 50));

    const stale = emitted.find(e => e.type === 'DECISION_STALE_HAND');
    expect(stale).toBeTruthy();
    expect((stale as Record<string, unknown>).decidedHand).toBe(3);
    expect((stale as Record<string, unknown>).currentHand).toBe(4);
  });
});

// ── sendDecision — action error paths ────────────────────────────────

describe('GameSession — sendDecision action error paths', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // Helper: create a session whose gateway returns a valid decision,
  // then spy on fetch to control the action POST response.
  function makeActionErrorSession() {
    const mockGw = makeMockGatewayClient('{"action":"call","narration":"I call."}');
    const kit = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    kit.session.currentHandNumber = 1;
    // Spy on the global fetch stub (line 14) — mockRestore() restores back to the stub, not real fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    return { ...kit, fetchSpy };
  }

  // ── 429 retry-after backoff ──

  it('backs off on 429 with retry-after header and emits ACTION_THROTTLED', async () => {
    const { session, emitted, fetchSpy } = makeActionErrorSession();
    const context = makeContext({ lastTurnKey: 'hand-1-seat-0' });

    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '10' }),
      text: async () => 'Rate limited',
    } as Response);

    session.sendDecision('prompt', context);

    // Advance past the gateway call (microtask) then past the 10s backoff
    await vi.advanceTimersByTimeAsync(11_000);
    await session.lastDecision;

    const throttled = emitted.find(e => e.type === 'ACTION_THROTTLED');
    expect(throttled).toBeTruthy();
    expect(throttled!.backoffMs).toBe(10_000);

    // Should also emit ACTION_REJECTED before throttle
    expect(emitted.find(e => e.type === 'ACTION_REJECTED' && e.status === 429)).toBeTruthy();

    // lastTurnKey should be reset
    expect(context.lastTurnKey).toBeNull();

    fetchSpy.mockRestore();
  });

  it('uses 5000ms minimum backoff when retry-after is missing', async () => {
    const { session, emitted, fetchSpy } = makeActionErrorSession();
    const context = makeContext({ lastTurnKey: 'hand-1-seat-0' });

    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers(),
      text: async () => 'Rate limited',
    } as Response);

    session.sendDecision('prompt', context);

    await vi.advanceTimersByTimeAsync(6_000);
    await session.lastDecision;

    const throttled = emitted.find(e => e.type === 'ACTION_THROTTLED');
    expect(throttled).toBeTruthy();
    expect(throttled!.backoffMs).toBe(5_000);
    expect(context.lastTurnKey).toBeNull();

    fetchSpy.mockRestore();
  });

  // ── Network error retry ──

  it('retries once on network error and emits ACTION_RETRY_OK on success', async () => {
    const { session, emitted, fetchSpy } = makeActionErrorSession();
    const context = makeContext({ lastTurnKey: 'hand-1-seat-0' });

    fetchSpy
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' } as Response);

    session.sendDecision('prompt', context);

    // Advance past the 3s retry delay
    await vi.advanceTimersByTimeAsync(4_000);
    await session.lastDecision;

    expect(emitted.find(e => e.type === 'ACTION_SUBMIT_ERROR')).toBeTruthy();
    expect(emitted.find(e => e.type === 'ACTION_RETRY_OK')).toBeTruthy();
    expect(context.lastTurnKey).toBeNull();

    fetchSpy.mockRestore();
  });

  it('retries once on network error and emits ACTION_RETRY_REJECTED on server error', async () => {
    const { session, emitted, fetchSpy } = makeActionErrorSession();
    const context = makeContext({ lastTurnKey: 'hand-1-seat-0' });

    fetchSpy
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Bad request' } as Response);

    session.sendDecision('prompt', context);

    await vi.advanceTimersByTimeAsync(4_000);
    await session.lastDecision;

    expect(emitted.find(e => e.type === 'ACTION_SUBMIT_ERROR')).toBeTruthy();
    const retryRejected = emitted.find(e => e.type === 'ACTION_RETRY_REJECTED');
    expect(retryRejected).toBeTruthy();
    expect(retryRejected!.status).toBe(400);
    expect(context.lastTurnKey).toBeNull();

    fetchSpy.mockRestore();
  });

  it('retries once on network error and emits ACTION_RETRY_FAILED when retry also throws', async () => {
    const { session, emitted, fetchSpy } = makeActionErrorSession();
    const context = makeContext({ lastTurnKey: 'hand-1-seat-0' });

    fetchSpy
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('still broken'));

    session.sendDecision('prompt', context);

    await vi.advanceTimersByTimeAsync(4_000);
    await session.lastDecision;

    expect(emitted.find(e => e.type === 'ACTION_SUBMIT_ERROR')).toBeTruthy();
    const retryFailed = emitted.find(e => e.type === 'ACTION_RETRY_FAILED');
    expect(retryFailed).toBeTruthy();
    expect(retryFailed!.error).toContain('still broken');
    expect(context.lastTurnKey).toBeNull();

    fetchSpy.mockRestore();
  });

  // ── 400 rejection → active refetch ──

  it('re-fetches state after 400 rejection and calls onRefetchState', async () => {
    const { session, emitted, fetchSpy } = makeActionErrorSession();
    const context = makeContext({ lastTurnKey: 'hand-1-seat-0' });

    const freshView = makeView({ handNumber: 1, isYourTurn: true });
    let refetchedState: unknown = null;
    session.onRefetchState = (state) => { refetchedState = state; };

    fetchSpy
      // 1st call: action POST → 400
      .mockResolvedValueOnce({
        ok: false, status: 400, text: async () => 'Invalid action',
      } as Response)
      // 2nd call: GET /api/me/game → fresh state
      .mockResolvedValueOnce({
        ok: true, status: 200, json: async () => freshView,
      } as Response);

    session.sendDecision('prompt', context);
    await vi.advanceTimersByTimeAsync(100);
    await session.lastDecision;

    expect(emitted.find(e => e.type === 'ACTION_REJECTED')).toBeTruthy();
    expect(emitted.find(e => e.type === 'ACTION_REJECTED_REFETCH')).toBeTruthy();
    expect(refetchedState).toEqual(freshView);
    expect(context.lastTurnKey).toBeNull();

    fetchSpy.mockRestore();
  });

  it('skips refetch when onRefetchState is not wired', async () => {
    const { session, emitted, fetchSpy } = makeActionErrorSession();
    const context = makeContext({ lastTurnKey: 'hand-1-seat-0' });

    // onRefetchState is null by default
    fetchSpy.mockResolvedValueOnce({
      ok: false, status: 400, text: async () => 'Invalid action',
    } as Response);

    session.sendDecision('prompt', context);
    await vi.advanceTimersByTimeAsync(100);
    await session.lastDecision;

    expect(emitted.find(e => e.type === 'ACTION_REJECTED')).toBeTruthy();
    expect(emitted.find(e => e.type === 'ACTION_REJECTED_REFETCH')).toBeFalsy();
    // Only 1 fetch call (the action POST), no refetch
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });

  it('silently ignores refetch errors (best-effort)', async () => {
    const { session, emitted, fetchSpy } = makeActionErrorSession();
    const context = makeContext({ lastTurnKey: 'hand-1-seat-0' });

    session.onRefetchState = () => {};

    fetchSpy
      .mockResolvedValueOnce({
        ok: false, status: 400, text: async () => 'Invalid action',
      } as Response)
      // Refetch fails
      .mockRejectedValueOnce(new TypeError('network error'));

    session.sendDecision('prompt', context);
    await vi.advanceTimersByTimeAsync(100);
    await session.lastDecision;

    expect(emitted.find(e => e.type === 'ACTION_REJECTED')).toBeTruthy();
    expect(emitted.find(e => e.type === 'ACTION_REJECTED_REFETCH')).toBeFalsy();
    // Should not throw — best-effort

    fetchSpy.mockRestore();
  });
});

// ── processHandResult via handleOutputs ─────────────────────────────

describe('GameSession — processHandResult (via handleOutputs)', () => {
  it('tracks hand result in recentEvents', () => {
    const { session } = makeSession();
    const context = makeContext();
    const view = makeView({
      yourChips: 1020,
      yourSeat: 0,
      lastHandResult: {
        winners: [0],
        players: [
          { userId: 'user-hero', seat: 0, name: 'Hero', chips: 1020 },
          { userId: 'user-alice', seat: 1, name: 'Alice', chips: 980 },
        ],
        potResults: [{ winners: [0], amount: 40 }],
      },
      forcedBets: { smallBlind: 10, bigBlind: 20, ante: 0 },
    });

    session.stackBeforeHand = 1000;
    session.currentHandNumber = 3;

    const outputs: ListenerOutput[] = [
      { type: 'HAND_RESULT', state: view, handNumber: 3 },
    ];

    session.handleOutputs(outputs, view, [], context);

    expect(session.recentEvents.length).toBeGreaterThan(0);
    expect(session.recentEvents.some(e => e.includes('Hero won'))).toBe(true);
  });

  it('detects doubled up and updates lastHandUpdateTime', () => {
    const { session, emitted } = makeSession();
    const context = makeContext();
    const view = makeView({
      yourChips: 2000,
      yourSeat: 0,
      lastHandResult: {
        winners: [0],
        players: [
          { userId: 'user-hero', seat: 0, name: 'Hero', chips: 2000 },
          { userId: 'user-alice', seat: 1, name: 'Alice', chips: 0 },
        ],
        potResults: [{ winners: [0], amount: 1000 }],
      },
      forcedBets: { smallBlind: 10, bigBlind: 20, ante: 0 },
    });

    session.stackBeforeHand = 1000;
    session.currentHandNumber = 5;

    session.handleOutputs(
      [{ type: 'HAND_RESULT', state: view, handNumber: 5 }],
      view, [], context,
    );

    expect(session.lastHandUpdateTime).toBeGreaterThan(0);
  });

  it('respects HAND_UPDATE_COOLDOWN_MS for low-priority updates', () => {
    const { session } = makeSession();
    const context = makeContext();
    const bb = 20;
    const view = makeView({
      yourChips: 1100,
      yourSeat: 0,
      lastHandResult: {
        winners: [0],
        players: [
          { userId: 'user-hero', seat: 0, name: 'Hero', chips: 1100 },
          { userId: 'user-alice', seat: 1, name: 'Alice', chips: 900 },
        ],
        potResults: [{ winners: [0], amount: 100 }],
      },
      forcedBets: { smallBlind: 10, bigBlind: bb, ante: 0 },
    });

    session.stackBeforeHand = 1000;
    session.currentHandNumber = 5;

    // First update — should go through
    session.handleOutputs(
      [{ type: 'HAND_RESULT', state: view, handNumber: 5 }],
      view, [], context,
    );
    const firstUpdateTime = session.lastHandUpdateTime;
    expect(firstUpdateTime).toBeGreaterThan(0);

    // Second update immediately — should be suppressed by cooldown
    session.handleOutputs(
      [{ type: 'HAND_RESULT', state: view, handNumber: 6 }],
      view, [], context,
    );
    expect(session.lastHandUpdateTime).toBe(firstUpdateTime);
  });

  it('detects short-stacked status', () => {
    const { session } = makeSession();
    const context = makeContext();
    const bb = 20;
    const view = makeView({
      yourChips: 200,
      yourSeat: 0,
      lastHandResult: {
        winners: [1],
        players: [
          { userId: 'user-hero', seat: 0, name: 'Hero', chips: 200 },
          { userId: 'user-alice', seat: 1, name: 'Alice', chips: 1800 },
        ],
        potResults: [{ winners: [1], amount: 800 }],
      },
      forcedBets: { smallBlind: 10, bigBlind: bb, ante: 0 },
    });

    session.stackBeforeHand = 600;
    session.currentHandNumber = 5;

    session.handleOutputs(
      [{ type: 'HAND_RESULT', state: view, handNumber: 5 }],
      view, [], context,
    );

    expect(session.lastHandUpdateTime).toBeGreaterThan(0);
  });

  it('detects opponent bust', () => {
    const { session } = makeSession();
    const context = makeContext();
    const view = makeView({
      yourChips: 1010,
      yourSeat: 0,
      players: [
        { userId: 'user-hero', seat: 0, name: 'Hero', chips: 1010, bet: 0, invested: 0, status: 'active', isDealer: true, isCurrentActor: false },
        { userId: 'user-alice', seat: 1, name: 'Alice', chips: 0, bet: 0, invested: 0, status: 'eliminated', isDealer: false, isCurrentActor: false },
      ],
      lastHandResult: {
        winners: [0],
        players: [
          { userId: 'user-hero', seat: 0, name: 'Hero', chips: 1010 },
          { userId: 'user-alice', seat: 1, name: 'Alice', chips: 0 },
        ],
        potResults: [{ winners: [0], amount: 20 }],
      },
      forcedBets: { smallBlind: 10, bigBlind: 20, ante: 0 },
    });

    session.stackBeforeHand = 1000;
    session.currentHandNumber = 5;

    const prevPlayers = [
      { userId: 'user-hero', seat: 0, name: 'Hero', chips: 1000, bet: 0, invested: 0, status: 'active' as const, isDealer: true, isCurrentActor: false },
      { userId: 'user-alice', seat: 1, name: 'Alice', chips: 10, bet: 0, invested: 0, status: 'active' as const, isDealer: false, isCurrentActor: false },
    ];

    session.handleOutputs(
      [{ type: 'HAND_RESULT', state: view, handNumber: 5 }],
      view, prevPlayers, context,
    );

    expect(session.lastHandUpdateTime).toBeGreaterThan(0);
  });
});

// ── Signal suppression ──────────────────────────────────────────────

describe('GameSession — signal suppression', () => {
  it('suppresses a configured signal via notifyAgent', async () => {
    const { session, emitted } = makeRealNotifySession(['HAND_UPDATE']);

    await session.notifyAgent('[POKER CONTROL SIGNAL: HAND_UPDATE] Doubled up! 500 → 1000');

    const suppressed = emitted.find(e => e.type === 'SIGNAL_SUPPRESSED');
    expect(suppressed).toBeTruthy();
    expect(suppressed!.signal).toBe('HAND_UPDATE');
    expect(emitted.find(e => e.type === 'NOTIFY_AGENT_ERROR')).toBeFalsy();
  });

  it('suppresses a configured signal via notifyAgentSilent', async () => {
    const { session, emitted } = makeRealNotifySession(['WAITING_FOR_PLAYERS']);

    await session.notifyAgentSilent('[POKER CONTROL SIGNAL: WAITING_FOR_PLAYERS] All opponents left');

    const suppressed = emitted.find(e => e.type === 'SIGNAL_SUPPRESSED');
    expect(suppressed).toBeTruthy();
    expect(suppressed!.signal).toBe('WAITING_FOR_PLAYERS');
  });

  it('delivers non-suppressed signals normally', async () => {
    const { session, emitted } = makeRealNotifySession(['HAND_UPDATE']);

    await session.notifyAgent('[POKER CONTROL SIGNAL: DECISION_STATUS] Timed out');

    expect(emitted.find(e => e.type === 'SIGNAL_SUPPRESSED')).toBeFalsy();
    expect(emitted.find(e => e.type === 'NOTIFY_AGENT_ERROR')).toBeTruthy();
  });

  it('never suppresses GAME_OVER even if listed', async () => {
    const { session, emitted } = makeRealNotifySession(['GAME_OVER', 'HAND_UPDATE']);

    await session.notifyAgent('[POKER CONTROL SIGNAL: GAME_OVER] Game ended');

    expect(emitted.find(e => e.type === 'SIGNAL_SUPPRESSED')).toBeFalsy();
    expect(emitted.find(e => e.type === 'NOTIFY_AGENT_ERROR')).toBeTruthy();
  });

  it('never suppresses CONNECTION_ERROR even if listed', async () => {
    const { session, emitted } = makeRealNotifySession(['CONNECTION_ERROR']);

    await session.notifyAgent('[POKER CONTROL SIGNAL: CONNECTION_ERROR] Lost connection');

    expect(emitted.find(e => e.type === 'SIGNAL_SUPPRESSED')).toBeFalsy();
    expect(emitted.find(e => e.type === 'NOTIFY_AGENT_ERROR')).toBeTruthy();
  });

  it('passes through non-signal messages without suppression', async () => {
    const { session, emitted } = makeRealNotifySession(['HAND_UPDATE']);

    await session.notifyAgent('Just a regular message with no signal prefix');

    expect(emitted.find(e => e.type === 'SIGNAL_SUPPRESSED')).toBeFalsy();
    expect(emitted.find(e => e.type === 'NOTIFY_AGENT_ERROR')).toBeTruthy();
  });

  it('handles empty suppressedSignals (no suppression)', async () => {
    const { session, emitted } = makeRealNotifySession([]);

    await session.notifyAgent('[POKER CONTROL SIGNAL: HAND_UPDATE] Some update');

    expect(emitted.find(e => e.type === 'SIGNAL_SUPPRESSED')).toBeFalsy();
  });

  it('SUPPRESSIBLE_SIGNALS excludes GAME_OVER and CONNECTION_ERROR', () => {
    expect(SUPPRESSIBLE_SIGNALS.has('GAME_OVER')).toBe(false);
    expect(SUPPRESSIBLE_SIGNALS.has('CONNECTION_ERROR')).toBe(false);
  });

  it('SUPPRESSIBLE_SIGNALS includes all optional signals', () => {
    for (const sig of ['DECISION_STATUS', 'HAND_UPDATE', 'INVITE_RECEIVED', 'WAITING_FOR_PLAYERS', 'REBUY_AVAILABLE', 'NEW_FOLLOWER', 'INVITE_RESPONSE']) {
      expect(SUPPRESSIBLE_SIGNALS.has(sig)).toBe(true);
    }
  });
});

// ── Fake timer tests (Phase 2 — Step 4) ─────────────────────────────

describe('GameSession — HAND_UPDATE_COOLDOWN_MS rate limiting (fake timers)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('allows low-priority update after cooldown expires', () => {
    const { session, notifyCalls } = makeSession();
    const context = makeContext();
    const bb = 20;
    const view = makeView({
      yourChips: 1100,
      yourSeat: 0,
      lastHandResult: {
        winners: [0],
        players: [
          { userId: 'user-hero', seat: 0, name: 'Hero', chips: 1100 },
          { userId: 'user-alice', seat: 1, name: 'Alice', chips: 900 },
        ],
        potResults: [{ winners: [0], amount: 100 }],
      },
      forcedBets: { smallBlind: 10, bigBlind: bb, ante: 0 },
    });
    session.stackBeforeHand = 1000;
    session.currentHandNumber = 5;

    // First update fires
    session.handleOutputs(
      [{ type: 'HAND_RESULT', state: view, handNumber: 5 }],
      view, [], context,
    );
    const firstUpdateTime = session.lastHandUpdateTime;
    expect(firstUpdateTime).toBeGreaterThan(0);
    const firstNotifyCount = notifyCalls.length;

    // Advance past cooldown
    vi.advanceTimersByTime(GameSession.HAND_UPDATE_COOLDOWN_MS + 1);

    // Second update should fire now
    session.handleOutputs(
      [{ type: 'HAND_RESULT', state: view, handNumber: 6 }],
      view, [], context,
    );
    expect(session.lastHandUpdateTime).toBeGreaterThan(firstUpdateTime);
    expect(notifyCalls.length).toBeGreaterThan(firstNotifyCount);
  });
});

describe('GameSession — reflection concurrent guard', () => {
  it('does not trigger concurrent reflections when reflectionInFlight is true', () => {
    const mockGw = makeMockGatewayClient();
    let callCount = 0;
    mockGw.callAgent = async (..._args: unknown[]) => {
      callCount++;
      // Never resolve — simulate in-flight
      return new Promise(() => {});
    };

    const { session } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
      reflectEveryNHands: 1,
    });
    const context = makeContext();

    // Hand 1 — first hand, no reflection triggered (prevHandNumber is null)
    session.handleStateEvent(makeView({ handNumber: 1, recentHands: [] }), context, () => {});

    // Hand 2 — triggers reflection, sets reflectionInFlight=true
    session.handleStateEvent(makeView({ handNumber: 2, recentHands: [] }), context, () => {});
    expect(session.reflectionInFlight).toBe(true);
    const callsAfterFirst = callCount;

    // Hand 3 — would trigger reflection but guard prevents it
    session.handleStateEvent(makeView({ handNumber: 3, recentHands: [] }), context, () => {});
    // The warmup call fires on first connect, then reflection on hand 2 — but NOT on hand 3
    expect(callCount).toBe(callsAfterFirst);
  });
});

// ── Error injection tests (Phase 2 — Step 5) ────────────────────────

describe('GameSession — error injection', () => {
  it('calls onFatalDecisionFailure at exactly MAX_CONSECUTIVE_FAILURES', async () => {
    const mockGw = makeMockGatewayClient();
    mockGw.callAgent = async () => { throw new Error('timeout'); };

    const { session, notifyCalls } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    let fatalReason = '';
    session.onFatalDecisionFailure = (reason) => { fatalReason = reason; };

    // Fail 3 times sequentially
    for (let i = 0; i < GameSession.MAX_CONSECUTIVE_FAILURES; i++) {
      session.sendDecision('prompt', context);
      await session.lastDecision;
    }

    expect(session.consecutiveDecisionFailures).toBe(GameSession.MAX_CONSECUTIVE_FAILURES);
    expect(fatalReason).toContain('consecutive decision failures');
    // Should have notified about the fatal exit
    expect(notifyCalls.some(c => c.includes('DECISION_STATUS'))).toBe(true);
  });

  it('handles gateway returning malformed JSON in payload', async () => {
    const mockGw = makeMockGatewayClient();
    mockGw.callAgent = async () => ({ payloads: [{ text: '{"action": broken}' }] });

    const { session, emitted } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    session.sendDecision('prompt', context);
    await session.lastDecision;

    // Should emit DECISION_PARSE_ERROR for malformed JSON
    const parseError = emitted.find(e => e.type === 'DECISION_PARSE_ERROR');
    expect(parseError).toBeTruthy();
  });

  it('handles gateway returning empty payloads', async () => {
    const mockGw = makeMockGatewayClient();
    mockGw.callAgent = async () => ({ payloads: [] });

    const { session, emitted } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    session.sendDecision('prompt', context);
    await session.lastDecision;

    const failure = emitted.find(e => e.type === 'DECISION_FAILURE' && e.reason === 'no_action');
    expect(failure).toBeTruthy();
  });
});

describe('GameSession — resetForNewGame', () => {
  it('resets all per-game mutable state', () => {
    const { session } = makeSession();

    // Mutate state
    session.gameId = 'table-xyz';
    session.currentHandNumber = 5;
    session.decisionSeq = 10;
    session.consecutiveDecisionFailures = 2;
    session.reflectionsSent = 3;
    session.handsSinceReflection = 2;
    session.reflectionInFlight = true;
    session.gameStartedEmitted = true;
    session.recentEvents.push('event1');
    session.currentHandEvents.push('event2');
    session.stackBeforeHand = 500;
    session.foldedInHand = 3;

    session.resetForNewGame();

    expect(session.gameId).toBe('unknown');
    expect(session.currentHandNumber).toBeNull();
    expect(session.decisionSeq).toBe(0);
    expect(session.consecutiveDecisionFailures).toBe(0);
    expect(session.reflectionsSent).toBe(0);
    expect(session.handsSinceReflection).toBe(0);
    expect(session.reflectionInFlight).toBe(false);
    expect(session.gameStartedEmitted).toBe(false);
    expect(session.recentEvents).toEqual([]);
    expect(session.currentHandEvents).toEqual([]);
    expect(session.stackBeforeHand).toBeNull();
    expect(session.foldedInHand).toBeNull();
    expect(session.lastTransitions).toEqual([]);
  });

  it('preserves decisionCount across resets (lifetime counter)', () => {
    const { session } = makeSession();
    const context = makeContext();

    session.sendDecision('prompt 1', context);
    session.sendDecision('prompt 2', context);
    expect(session.decisionCount).toBe(2);

    session.resetForNewGame();

    expect(session.decisionCount).toBe(2); // Not reset — it's a lifetime counter
    session.sendDecision('prompt 3', context);
    expect(session.decisionCount).toBe(3);
  });
});

describe('GameSession — resetDecisionFailures', () => {
  it('resets consecutiveDecisionFailures to 0', () => {
    const { session } = makeSession();
    session.consecutiveDecisionFailures = 2;

    session.resetDecisionFailures();

    expect(session.consecutiveDecisionFailures).toBe(0);
  });

  it('is safe to call when already at 0', () => {
    const { session } = makeSession();
    session.resetDecisionFailures();
    expect(session.consecutiveDecisionFailures).toBe(0);
  });
});

describe('GameSession — YOUR_TURN guard (spurious state)', () => {
  it('skips YOUR_TURN with no handNumber', () => {
    const mockGw = makeMockGatewayClient();
    let callAgentCalled = false;
    mockGw.callAgent = async () => { callAgentCalled = true; return { payloads: [{ text: '{"action":"fold"}' }] }; };

    const { session, debugLog } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    // Simulate a YOUR_TURN output with missing handNumber
    const output: ListenerOutput = {
      type: 'YOUR_TURN',
      summary: 'PREFLOP | As Kh',
      state: makeView({ handNumber: 0, gameId: 'game-1' }),
    };
    session.handleOutputs([output], makeView(), [], context);

    expect(callAgentCalled).toBe(false);
    expect(debugLog.some(d => d.label === 'YOUR_TURN_SKIPPED')).toBe(true);
  });

  it('skips YOUR_TURN with no gameId', () => {
    const mockGw = makeMockGatewayClient();
    let callAgentCalled = false;
    mockGw.callAgent = async () => { callAgentCalled = true; return { payloads: [{ text: '{"action":"fold"}' }] }; };

    const { session, debugLog } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    const output: ListenerOutput = {
      type: 'YOUR_TURN',
      summary: 'PREFLOP | As Kh',
      state: makeView({ handNumber: 1, gameId: '' }),
    };
    session.handleOutputs([output], makeView(), [], context);

    expect(callAgentCalled).toBe(false);
    expect(debugLog.some(d => d.label === 'YOUR_TURN_SKIPPED')).toBe(true);
  });

  it('processes YOUR_TURN normally with valid game state', () => {
    const mockGw = makeMockGatewayClient();
    let callAgentCalled = false;
    mockGw.callAgent = async () => { callAgentCalled = true; return { payloads: [{ text: '{"action":"fold"}' }] }; };

    const { session } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    const output: ListenerOutput = {
      type: 'YOUR_TURN',
      summary: 'PREFLOP | As Kh',
      state: makeView({ handNumber: 1, gameId: 'game-1' }),
    };
    session.handleOutputs([output], makeView(), [], context);

    // sendDecision is async — it chains onto lastDecision
    expect(session.decisionSeq).toBe(1);
  });
});

// ── Table chat extraction ────────────────────────────────────────────

describe('GameSession — table chat extraction from transitions', () => {
  it('extracts table-chat transitions from other players into handEvents and recentEvents', () => {
    const { session } = makeSession();
    // Set up so hand doesn't change (avoids onHandChanged clearing currentHandEvents)
    const prevView = makeView({ handNumber: 1, phase: 'FLOP' });
    const context = makeContext({ prevState: prevView, prevPhase: 'FLOP' });
    session.currentHandNumber = 1;

    const transitions: GameTransition[] = [
      { type: 'table-chat', seat: 1, playerName: 'Alice', userId: 'user-alice', message: 'Nice hand!' },
    ];
    const view = makeView({ handNumber: 1, phase: 'FLOP' });

    session.handleStateEvent({ ...view, transitions }, context, () => {});

    expect(session.currentHandEvents).toContain('💬 Alice: Nice hand!');
    expect(session.recentEvents).toContain('💬 Alice: Nice hand!');
  });

  it('skips table-chat transitions from own seat', () => {
    const { session } = makeSession();
    const prevView = makeView({ handNumber: 1, phase: 'FLOP', yourSeat: 0 });
    const context = makeContext({ prevState: prevView, prevPhase: 'FLOP' });
    session.currentHandNumber = 1;

    const transitions: GameTransition[] = [
      { type: 'table-chat', seat: 0, playerName: 'Hero', userId: 'user-hero', message: 'GG' },
    ];
    const view = makeView({ handNumber: 1, phase: 'FLOP', yourSeat: 0 });

    session.handleStateEvent({ ...view, transitions }, context, () => {});

    expect(session.currentHandEvents).toEqual([]);
  });

  it('handles multiple chat transitions in one event', () => {
    const { session } = makeSession();
    const prevView = makeView({ handNumber: 1, phase: 'FLOP' });
    const context = makeContext({ prevState: prevView, prevPhase: 'FLOP' });
    session.currentHandNumber = 1;

    const transitions: GameTransition[] = [
      { type: 'table-chat', seat: 1, playerName: 'Alice', userId: 'user-alice', message: 'Wow' },
      { type: 'table-chat', seat: 2, playerName: 'Bob', userId: 'user-bob', message: 'GG' },
      { type: 'player-action', seat: 1, action: 'call', amount: 20 },
    ];
    const view = makeView({ handNumber: 1, phase: 'FLOP' });

    session.handleStateEvent({ ...view, transitions }, context, () => {});

    expect(session.currentHandEvents.filter(e => e.startsWith('💬'))).toHaveLength(2);
    expect(session.currentHandEvents.some(e => e.includes('Alice'))).toBe(true);
    expect(session.currentHandEvents.some(e => e.includes('Bob'))).toBe(true);
  });
});

// ── Chat field in decisions ──────────────────────────────────────────

describe('GameSession — chat field in action body', () => {
  it('includes chat field from decision response in action submission', async () => {
    const mockGw = makeMockGatewayClient('{"action":"call","amount":20,"narration":"I call.","chat":"Let\'s go!"}');
    const { session } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"success":true}',
    } as Response);

    session.sendDecision('prompt', context);
    await session.lastDecision;

    // Find the action POST call
    const actionCall = fetchSpy.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('/api/me/game/action'));
    expect(actionCall).toBeTruthy();
    const body = JSON.parse((actionCall![1] as RequestInit).body as string);
    expect(body.chat).toBe("Let's go!");

    fetchSpy.mockRestore();
  });

  it('omits chat field when not present in decision', async () => {
    const mockGw = makeMockGatewayClient('{"action":"fold","narration":"I fold."}');
    const { session } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"success":true}',
    } as Response);

    session.sendDecision('prompt', context);
    await session.lastDecision;

    const actionCall = fetchSpy.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('/api/me/game/action'));
    expect(actionCall).toBeTruthy();
    const body = JSON.parse((actionCall![1] as RequestInit).body as string);
    expect(body.chat).toBeUndefined();

    fetchSpy.mockRestore();
  });
});

// ── DRAMA_MOMENT handling in handleOutputs ───────────────────────────

describe('GameSession — DRAMA_MOMENT reactive chat', () => {
  it('skips DRAMA_MOMENT when tableChatReactive is false', () => {
    const mockGw = makeMockGatewayClient();
    let callAgentCalled = false;
    mockGw.callAgent = async () => { callAgentCalled = true; return { payloads: [{ text: '{"chat":"wow"}' }] }; };

    const { session } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
      tableChatReactive: false,
    });
    const context = makeContext();

    const output: ListenerOutput = {
      type: 'DRAMA_MOMENT',
      state: makeView(),
      description: 'Alice goes all-in',
      handNumber: 1,
    };
    session.handleOutputs([output], makeView(), [], context);

    expect(callAgentCalled).toBe(false);
  });

  it('skips DRAMA_MOMENT when isYourTurn is true', () => {
    const mockGw = makeMockGatewayClient();
    let callAgentCalled = false;
    mockGw.callAgent = async () => { callAgentCalled = true; return { payloads: [{ text: '{"chat":"wow"}' }] }; };

    const { session } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();

    const output: ListenerOutput = {
      type: 'DRAMA_MOMENT',
      state: makeView({ isYourTurn: true }),
      description: 'Big showdown',
      handNumber: 1,
    };
    session.handleOutputs([output], makeView(), [], context);

    expect(callAgentCalled).toBe(false);
  });

  it('skips DRAMA_MOMENT when decisionInFlight is true', () => {
    const mockGw = makeMockGatewayClient();
    let callAgentCalled = false;
    mockGw.callAgent = async () => { callAgentCalled = true; return { payloads: [{ text: '{"chat":"wow"}' }] }; };

    const { session } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.decisionInFlight = true;

    const output: ListenerOutput = {
      type: 'DRAMA_MOMENT',
      state: makeView(),
      description: 'Alice busted out!',
      handNumber: 1,
    };
    session.handleOutputs([output], makeView(), [], context);

    expect(callAgentCalled).toBe(false);
  });

  it('skips DRAMA_MOMENT when reactionInFlight is true', () => {
    const mockGw = makeMockGatewayClient();
    let callAgentCalled = false;
    mockGw.callAgent = async () => { callAgentCalled = true; return { payloads: [{ text: '{"chat":"wow"}' }] }; };

    const { session } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.reactionInFlight = true;

    const output: ListenerOutput = {
      type: 'DRAMA_MOMENT',
      state: makeView(),
      description: 'Showdown!',
      handNumber: 1,
    };
    session.handleOutputs([output], makeView(), [], context);

    expect(callAgentCalled).toBe(false);
  });

  it('fires sendReaction when all guards pass', async () => {
    const mockGw = makeMockGatewayClient();
    let callAgentCalled = false;
    mockGw.callAgent = async () => {
      callAgentCalled = true;
      return { payloads: [{ text: '{"chat":"Wow, big play!"}' }] };
    };

    const { session, debugLog } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    const output: ListenerOutput = {
      type: 'DRAMA_MOMENT',
      state: makeView(),
      description: 'Alice goes all-in for 500',
      handNumber: 1,
    };
    session.handleOutputs([output], makeView(), [], context);

    // Wait for the fire-and-forget promise to settle
    await new Promise(r => setTimeout(r, 50));

    expect(callAgentCalled).toBe(true);
  });

  it('discards reaction if decision starts during subagent call', async () => {
    const mockGw = makeMockGatewayClient();
    let resolveCallAgent: (v: { payloads: Array<{ text: string }> }) => void;
    mockGw.callAgent = () => new Promise((resolve) => { resolveCallAgent = resolve; });

    const { session, debugLog } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    const output: ListenerOutput = {
      type: 'DRAMA_MOMENT',
      state: makeView(),
      description: 'Alice goes all-in',
      handNumber: 1,
    };
    session.handleOutputs([output], makeView(), [], context);

    // Simulate a decision starting while reaction is in-flight
    session.decisionInFlight = true;

    // Resolve the callAgent
    resolveCallAgent!({ payloads: [{ text: '{"chat":"wow"}' }] });
    await new Promise(r => setTimeout(r, 50));

    // Reaction should have been discarded
    expect(debugLog.some(d => d.label === 'REACTION_DISCARDED')).toBe(true);
    expect(session.reactionInFlight).toBe(false);
  });

  it('reactionInFlight is false after sendReaction completes', async () => {
    const mockGw = makeMockGatewayClient();
    mockGw.callAgent = async () => ({ payloads: [{ text: '{"chat":""}' }] });

    const { session } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    const output: ListenerOutput = {
      type: 'DRAMA_MOMENT',
      state: makeView(),
      description: 'Bust-out',
      handNumber: 1,
    };
    session.handleOutputs([output], makeView(), [], context);

    await new Promise(r => setTimeout(r, 50));

    expect(session.reactionInFlight).toBe(false);
  });

  it('does not block decision-making (independent async path)', async () => {
    const mockGw = makeMockGatewayClient();
    let reactionStarted = false;
    let decisionCompleted = false;

    // Reaction takes a long time
    const origCallAgent = mockGw.callAgent;
    let callCount = 0;
    mockGw.callAgent = async (...args: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        // First call is the reaction — simulate slow response
        reactionStarted = true;
        await new Promise(r => setTimeout(r, 200));
        return { payloads: [{ text: '{"chat":"wow"}' }] };
      }
      // Second call is the decision
      return { payloads: [{ text: '{"action":"fold","narration":"fold"}' }] };
    };

    const { session } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    // Trigger DRAMA_MOMENT (fire-and-forget)
    const dramaOutput: ListenerOutput = {
      type: 'DRAMA_MOMENT',
      state: makeView(),
      description: 'Big pot',
      handNumber: 1,
    };
    session.handleOutputs([dramaOutput], makeView(), [], context);

    // Now immediately trigger a decision — it should proceed independently
    session.sendDecision('prompt', context);

    // Decision should have started (decisionSeq incremented)
    expect(session.decisionSeq).toBe(1);
  });

  it('decisionInFlight is set correctly during sendDecision lifecycle', async () => {
    const mockGw = makeMockGatewayClient('{"action":"fold","narration":"fold"}');
    const { session } = makeSession({
      gatewayClient: mockGw as unknown as GameSessionConfig['gatewayClient'],
    });
    const context = makeContext();
    session.currentHandNumber = 1;

    expect(session.decisionInFlight).toBe(false);

    session.sendDecision('prompt', context);
    expect(session.decisionInFlight).toBe(true);

    await session.lastDecision;
    expect(session.decisionInFlight).toBe(false);
  });
});
