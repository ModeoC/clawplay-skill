/**
 * Integration test for the poker listener's full lifecycle.
 *
 * Tests the GameSession + processStateEvent + mock SSE server + mock gateway WS
 * working together end-to-end. No real backend, no real OpenClaw — everything
 * is controlled via scripted SSE events and mock gateway responses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockSSEServer } from './harness/mock-sse-server.js';
import { GameSession } from '../game-session.js';
import type { GameSessionConfig } from '../game-session.js';
import { processStateEvent } from '../state-processor.js';
import type { PlayerView, ListenerContext } from '../types.js';
import { makeView, makeMockGatewayClient } from './helpers.js';
import type { MockGatewayClient } from './helpers.js';

// ── Test session factory (integration) ──────────────────────────────

function makeIntegrationSession(opts: {
  backendUrl: string;
  gatewayClient: MockGatewayClient;
  reflectEveryNHands?: number;
}) {
  const emitted: Array<Record<string, unknown>> = [];
  const notifyCalls: string[] = [];
  const debugLog: Array<{ label: string; data: Record<string, unknown> }> = [];

  const config: GameSessionConfig = {
    channel: 'test',
    chatId: 'test-chat',
    agentId: 'main',
    backendUrl: opts.backendUrl,
    apiKey: 'test-api-key',
    deliveryAccount: null,
    reflectEveryNHands: opts.reflectEveryNHands ?? 100,
    gatewayClient: opts.gatewayClient as unknown as GameSessionConfig['gatewayClient'],
    debugFn: (label, data) => { debugLog.push({ label, data }); },
    emitFn: (obj) => { emitted.push(obj as Record<string, unknown>); },
  };

  const session = new GameSession(config);

  // Stub notifyAgent to prevent execFile
  session.notifyAgent = async (msg: string) => { notifyCalls.push(msg); };
  session.notifyAgentSilent = async (msg: string) => { notifyCalls.push(msg); };

  return { session, emitted, notifyCalls, debugLog };
}

// ── Full hand cycle helper ──────────────────────────────────────────

function fullHandViews(handNumber: number): {
  preflop: PlayerView;
  flopYourTurn: PlayerView;
  showdown: PlayerView;
  waiting: PlayerView;
} {
  return {
    preflop: makeView({
      gameId: 'game-integration',
      handNumber,
      phase: 'PREFLOP',
      isYourTurn: false,
      yourCards: ['As', 'Kh'],
      yourChips: 990,
      pot: 30,
    }),
    flopYourTurn: makeView({
      gameId: 'game-integration',
      handNumber,
      phase: 'FLOP',
      isYourTurn: true,
      yourCards: ['As', 'Kh'],
      yourChips: 970,
      yourBet: 20,
      pot: 60,
      boardCards: ['Ah', '7c', '2d'],
      availableActions: [{ type: 'check' }, { type: 'raise', minAmount: 20, maxAmount: 970 }],
      players: [
        { userId: 'user-hero', seat: 0, name: 'Hero', chips: 970, bet: 20, invested: 40, status: 'active', isDealer: true, isCurrentActor: true },
        { userId: 'user-alice', seat: 1, name: 'Alice', chips: 960, bet: 20, invested: 40, status: 'active', isDealer: false, isCurrentActor: false },
      ],
    }),
    showdown: makeView({
      gameId: 'game-integration',
      handNumber,
      phase: 'SHOWDOWN',
      isYourTurn: false,
      yourCards: ['As', 'Kh'],
      yourChips: 1040,
      pot: 0,
      boardCards: ['Ah', '7c', '2d', 'Kd', '3s'],
      lastHandResult: {
        winners: [0],
        players: [
          { userId: 'user-hero', seat: 0, name: 'Hero', chips: 1040 },
          { userId: 'user-alice', seat: 1, name: 'Alice', chips: 960 },
        ],
        potResults: [{ winners: [0], amount: 80 }],
      },
    }),
    waiting: makeView({
      gameId: 'game-integration',
      handNumber: handNumber + 1,
      phase: 'PREFLOP',
      isYourTurn: false,
      yourCards: ['Tc', '9d'],
      yourChips: 1040,
      pot: 30,
    }),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Integration: full hand lifecycle', () => {
  let sseServer: MockSSEServer;

  beforeEach(async () => {
    sseServer = new MockSSEServer();
    await sseServer.start();
  });

  afterEach(async () => {
    await sseServer.stop();
  });

  it('processes a complete hand: preflop → flop (your turn) → showdown → next hand', async () => {
    const mockGw = makeMockGatewayClient('{"action":"check","narration":"I check."}');
    const { session, emitted } = makeIntegrationSession({
      backendUrl: sseServer.url,
      gatewayClient: mockGw,
    });

    const context: ListenerContext = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };
    const views = fullHandViews(1);

    // 1. Preflop (not our turn)
    const outputs1 = processStateEvent(views.preflop, context);
    session.handleOutputs(outputs1, views.preflop, [], context);
    expect(session.gameId).toBe('unknown'); // gameId set via handleStateEvent, not handleOutputs

    // Use handleStateEvent for proper gameId tracking
    session.handleStateEvent(views.preflop, context, () => {});
    expect(session.gameId).toBe('game-integration');

    // 2. Flop — our turn
    const outputs2 = processStateEvent(views.flopYourTurn, context);
    const yourTurn = outputs2.find(o => o.type === 'YOUR_TURN');
    expect(yourTurn).toBeTruthy();

    session.handleOutputs(outputs2, views.flopYourTurn, views.preflop.players, context);
    expect(session.decisionSeq).toBe(1);

    // Wait for decision to complete
    await session.lastDecision;

    // 3. Showdown
    session.stackBeforeHand = 990;
    session.currentHandNumber = 1;
    session.handleStateEvent(views.showdown, context, () => {});

    // Should have a hand result in recentEvents
    expect(session.recentEvents.some(e => e.includes('Hero won'))).toBe(true);

    // 4. Next hand starts
    session.handleStateEvent(views.waiting, context, () => {});
    expect(session.currentHandNumber).toBe(2);
  });

  it('triggers graceful exit on pending leave during SHOWDOWN', () => {
    const mockGw = makeMockGatewayClient();
    const { session } = makeIntegrationSession({
      backendUrl: sseServer.url,
      gatewayClient: mockGw,
    });

    const context: ListenerContext = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };
    let exitReason = '';

    // Set up state
    session.handleStateEvent(makeView({ phase: 'RIVER' }), context, () => {});

    // Pending leave at SHOWDOWN
    session.handleStateEvent(
      makeView({ phase: 'SHOWDOWN', hasPendingLeave: true }),
      context,
      (reason) => { exitReason = reason; },
    );

    expect(exitReason).toBe('Left the table');
  });

  it('handles consecutive decision failures leading to fatal exit', async () => {
    const mockGw = makeMockGatewayClient();
    mockGw.callAgent = async () => { throw new Error('gateway timeout'); };

    const { session, notifyCalls } = makeIntegrationSession({
      backendUrl: sseServer.url,
      gatewayClient: mockGw,
    });

    const context: ListenerContext = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };
    let fatalReason = '';
    session.onFatalDecisionFailure = (reason) => { fatalReason = reason; };
    session.currentHandNumber = 1;

    // Fire 3 decisions that all fail
    for (let i = 0; i < GameSession.MAX_CONSECUTIVE_FAILURES; i++) {
      session.sendDecision('prompt', context);
      await session.lastDecision;
    }

    expect(fatalReason).toContain('consecutive decision failures');
    expect(notifyCalls.some(c => c.includes('consecutive decisions failed'))).toBe(true);
  });

  it('resets decision failure count on successful action', async () => {
    const mockGw = makeMockGatewayClient('{"action":"call","narration":"I call."}');
    const { session } = makeIntegrationSession({
      backendUrl: sseServer.url,
      gatewayClient: mockGw,
    });

    const context: ListenerContext = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };
    session.currentHandNumber = 1;
    session.consecutiveDecisionFailures = 2;

    session.sendDecision('prompt', context);
    await session.lastDecision;

    expect(session.consecutiveDecisionFailures).toBe(0);
  });
});

describe('Integration: SSE server action capture', () => {
  let sseServer: MockSSEServer;

  beforeEach(async () => {
    sseServer = new MockSSEServer();
    await sseServer.start();
  });

  afterEach(async () => {
    await sseServer.stop();
  });

  it('submits action to backend when decision succeeds', async () => {
    const mockGw = makeMockGatewayClient('{"action":"raise","amount":100,"narration":"Big raise."}');
    const { session } = makeIntegrationSession({
      backendUrl: sseServer.url,
      gatewayClient: mockGw,
    });

    const context: ListenerContext = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };
    session.currentHandNumber = 1;

    session.sendDecision('prompt', context);
    await session.lastDecision;

    // Poll until the HTTP request completes (no fragile setTimeout)
    await vi.waitFor(() => expect(sseServer.getActions()).toHaveLength(1));

    const actions = sseServer.getActions();
    expect(actions[0].action).toBe('raise');
    expect(actions[0].amount).toBe(100);
    expect(actions[0].reasoning).toBe('Big raise.');
  });

  it('captures multiple sequential actions', async () => {
    const mockGw = makeMockGatewayClient();
    let callCount = 0;
    mockGw.callAgent = async () => {
      callCount++;
      const action = callCount === 1 ? 'call' : 'fold';
      return { payloads: [{ text: `{"action":"${action}","narration":"${action}"}` }] };
    };

    const { session } = makeIntegrationSession({
      backendUrl: sseServer.url,
      gatewayClient: mockGw,
    });

    const context: ListenerContext = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };
    session.currentHandNumber = 1;

    session.sendDecision('prompt 1', context);
    await session.lastDecision;
    session.currentHandNumber = 2;

    session.sendDecision('prompt 2', context);
    await session.lastDecision;

    // Poll until both HTTP requests complete (no fragile setTimeout)
    await vi.waitFor(() => expect(sseServer.getActions()).toHaveLength(2));

    const actions = sseServer.getActions();
    expect(actions[0].action).toBe('call');
    expect(actions[1].action).toBe('fold');
  });
});

describe('Integration: reflection triggering', () => {
  it('triggers reflection after N hands', async () => {
    const mockGw = makeMockGatewayClient();
    const reflectionCalls: unknown[] = [];
    mockGw.callAgent = async (...args: unknown[]) => {
      const params = args[0] as Record<string, unknown>;
      const sessionKey = params.sessionKey as string || '';
      if (sessionKey.includes('reflect')) {
        reflectionCalls.push(params);
      }
      return { payloads: [{ text: '{"action":"fold","narration":"fold"}' }] };
    };

    const sseServer = new MockSSEServer();
    await sseServer.start();

    try {
      const { session } = makeIntegrationSession({
        backendUrl: sseServer.url,
        gatewayClient: mockGw,
        reflectEveryNHands: 2,
      });

      const context: ListenerContext = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };

      // Hand 1 — first hand, no reflection
      session.handleStateEvent(makeView({ gameId: 'g1', handNumber: 1 }), context, () => {});
      expect(reflectionCalls).toHaveLength(0);

      // Hand 2 — handsSinceReflection=1, not enough
      session.handleStateEvent(makeView({ gameId: 'g1', handNumber: 2 }), context, () => {});
      expect(reflectionCalls).toHaveLength(0);

      // Hand 3 — handsSinceReflection=2 >= reflectEveryNHands(2), triggers!
      session.handleStateEvent(makeView({ gameId: 'g1', handNumber: 3, recentHands: [] }), context, () => {});
      expect(reflectionCalls).toHaveLength(1);
      expect(session.reflectionsSent).toBe(1);
    } finally {
      await sseServer.stop();
    }
  });
});

describe('Integration: signal delivery during game events', () => {
  it('sends HAND_UPDATE for doubled up (atomic hand transition)', async () => {
    const mockGw = makeMockGatewayClient();
    const sseServer = new MockSSEServer();
    await sseServer.start();

    try {
      const { session, notifyCalls } = makeIntegrationSession({
        backendUrl: sseServer.url,
        gatewayClient: mockGw,
      });

      const context: ListenerContext = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };

      // Hand 1: PREFLOP (sets stackBeforeHand = 1000)
      session.handleStateEvent(makeView({ handNumber: 1, yourChips: 1000, phase: 'PREFLOP' }), context, () => {});

      // Hand 2 arrives directly (atomic transition — skipped SHOWDOWN for hand 1)
      // This previously failed because onHandChanged() overwrote stackBeforeHand
      // before processHandResult() could compare against the old value.
      session.handleStateEvent(makeView({
        handNumber: 2,
        yourChips: 2000,
        lastHandResult: {
          winners: [0],
          players: [
            { userId: 'user-hero', seat: 0, name: 'Hero', chips: 2000 },
            { userId: 'user-alice', seat: 1, name: 'Alice', chips: 0 },
          ],
          potResults: [{ winners: [0], amount: 1000 }],
        },
        forcedBets: { smallBlind: 10, bigBlind: 20, ante: 0 },
      }), context, () => {});

      // Should have sent HAND_UPDATE about doubling up
      expect(notifyCalls.some(c => c.includes('HAND_UPDATE') && c.includes('Doubled up'))).toBe(true);
    } finally {
      await sseServer.stop();
    }
  });

  it('sends WAITING_FOR_PLAYERS when opponents leave', () => {
    const mockGw = makeMockGatewayClient();
    const { session, notifyCalls } = makeIntegrationSession({
      backendUrl: 'http://127.0.0.1:1',
      gatewayClient: mockGw,
    });

    const context: ListenerContext = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };

    // State with 2 players
    session.handleStateEvent(makeView({ phase: 'WAITING' }), context, () => {});

    // Now only hero remains
    session.handleStateEvent(makeView({
      phase: 'WAITING',
      players: [
        { userId: 'user-hero', seat: 0, name: 'Hero', chips: 1000, bet: 0, invested: 0, status: 'active', isDealer: false, isCurrentActor: false },
      ],
    }), context, () => {});

    expect(notifyCalls.some(c => c.includes('WAITING_FOR_PLAYERS'))).toBe(true);
  });

  it('sends REBUY_AVAILABLE when busted', () => {
    const mockGw = makeMockGatewayClient();
    const { session, notifyCalls } = makeIntegrationSession({
      backendUrl: 'http://127.0.0.1:1',
      gatewayClient: mockGw,
    });

    const context: ListenerContext = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };

    // Active phase
    session.handleStateEvent(makeView({ handNumber: 1, phase: 'RIVER' }), context, () => {});

    // Transition to WAITING while busted
    session.handleStateEvent(makeView({
      handNumber: 1,
      phase: 'WAITING',
      yourChips: 0,
      canRebuy: true,
      rebuyAmount: 1000,
    }), context, () => {});

    expect(notifyCalls.some(c => c.includes('REBUY_AVAILABLE'))).toBe(true);
  });
});

describe('Integration: session reset between games', () => {
  it('resets all state cleanly for a new game', () => {
    const mockGw = makeMockGatewayClient();
    const { session } = makeIntegrationSession({
      backendUrl: 'http://127.0.0.1:1',
      gatewayClient: mockGw,
    });

    const context: ListenerContext = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };

    // Play some hands
    session.handleStateEvent(makeView({ gameId: 'game-1', handNumber: 1, yourChips: 1000 }), context, () => {});
    session.handleStateEvent(makeView({ gameId: 'game-1', handNumber: 2, yourChips: 1050 }), context, () => {});
    session.handleStateEvent(makeView({ gameId: 'game-1', handNumber: 3, yourChips: 900 }), context, () => {});

    expect(session.gameId).toBe('game-1');
    expect(session.currentHandNumber).toBe(3);
    expect(session.recentEvents.length).toBeGreaterThan(0);

    // Reset for new game
    session.resetForNewGame();

    expect(session.gameId).toBe('unknown');
    expect(session.currentHandNumber).toBeNull();
    expect(session.recentEvents).toEqual([]);
    expect(session.currentHandEvents).toEqual([]);
    expect(session.stackBeforeHand).toBeNull();
    expect(session.foldedInHand).toBeNull();
    expect(session.decisionSeq).toBe(0);
    expect(session.consecutiveDecisionFailures).toBe(0);
    expect(session.gameStartedEmitted).toBe(false);
  });
});

describe('Integration: decision stale hand detection', () => {
  it('detects when hand moves on during slow decision', async () => {
    const mockGw = makeMockGatewayClient();
    let resolveCall: (() => void) | null = null;
    mockGw.callAgent = () => new Promise(resolve => {
      resolveCall = () => resolve({ payloads: [{ text: '{"action":"call"}' }] });
    });

    const { session, emitted, notifyCalls } = makeIntegrationSession({
      backendUrl: 'http://127.0.0.1:1',
      gatewayClient: mockGw,
    });

    const context: ListenerContext = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };
    session.currentHandNumber = 5;

    // Start a decision for hand 5
    session.sendDecision('prompt', context);

    // Wait until the gateway call is pending (resolveCall gets assigned)
    await vi.waitFor(() => expect(resolveCall).toBeTruthy());

    // Hand moves to 6 while deciding
    session.currentHandNumber = 6;

    // Resolve the gateway call
    resolveCall!();

    // Poll until stale hand is detected (no fragile setTimeout)
    await vi.waitFor(() => expect(emitted.some(e => e.type === 'DECISION_STALE_HAND')).toBe(true));
    expect(notifyCalls.some(c => c.includes('Hand moved on'))).toBe(true);
  });
});
