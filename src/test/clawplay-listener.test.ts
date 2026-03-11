import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  processStateEvent,
  parseDirectArgs,
  acquirePidLock,
  releasePidLock,
  isBeingReplaced,
} from '../clawplay-listener.js';
import {
  buildDecisionPrompt,
  buildSummary,
  buildHandResultSummary,
} from '../prompts.js';
import { readPlaybook, readNotes } from '../review.js';
import type { PlayerView, ListenerContext } from '../types.js';
import { makeView, makeContext } from './helpers.js';

// ─── processStateEvent ───────────────────────────────────────────────

describe('processStateEvent — returns arrays', () => {
  it('returns an array of events when not your turn', () => {
    const ctx = makeContext();
    const view = makeView({ isYourTurn: false });
    const result = processStateEvent(view, ctx);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].type).toBe('EVENT');
    expect('message' in result[0] && result[0].message.includes('**[Hand #')).toBe(true);
    expect(ctx.prevState).toBe(view);
  });

  it('returns empty array on duplicate state (no diff)', () => {
    const view = makeView({ isYourTurn: false });
    const ctx = makeContext({ prevState: view, prevPhase: 'PREFLOP' });

    const result = processStateEvent(makeView({ isYourTurn: false }), ctx);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});

describe('processStateEvent — YOUR_TURN', () => {
  it('includes YOUR_TURN output when isYourTurn is true', () => {
    const ctx = makeContext();

    processStateEvent(makeView({ isYourTurn: false }), ctx);

    const view2 = makeView({
      isYourTurn: true,
      availableActions: [{ type: 'CALL', amount: 20 }],
      players: [
        { userId: 'user-hero', seat: 0, name: 'Hero', chips: 970, bet: 10, invested: 10, status: 'active', isDealer: true, isCurrentActor: true },
        { userId: 'user-alice', seat: 1, name: 'Alice', chips: 940, bet: 60, invested: 60, status: 'active', isDealer: false, isCurrentActor: false },
      ],
    });
    const result = processStateEvent(view2, ctx);

    expect(Array.isArray(result)).toBe(true);
    const yourTurn = result.find(o => o.type === 'YOUR_TURN');
    expect(yourTurn).toBeTruthy();
    expect('state' in yourTurn! && yourTurn.state === view2).toBe(true);
    expect('summary' in yourTurn! && typeof yourTurn.summary === 'string').toBe(true);
  });
});

describe('processStateEvent — YOUR_TURN dedup reset', () => {
  it('re-fires YOUR_TURN in the same phase after turn passes away and back', () => {
    const ctx = makeContext();

    processStateEvent(makeView({ handNumber: 2, phase: 'FLOP', isYourTurn: false, boardCards: ['As', '7c', '2d'] }), ctx);

    const turn1 = processStateEvent(makeView({ handNumber: 2, phase: 'FLOP', isYourTurn: true, boardCards: ['As', '7c', '2d'], availableActions: [{ type: 'check' }] }), ctx);
    expect(turn1.find(o => o.type === 'YOUR_TURN')).toBeTruthy();

    processStateEvent(makeView({ handNumber: 2, phase: 'FLOP', isYourTurn: false, boardCards: ['As', '7c', '2d'] }), ctx);
    expect(ctx.lastTurnKey).toBeNull();

    const turn2 = processStateEvent(makeView({ handNumber: 2, phase: 'FLOP', isYourTurn: true, boardCards: ['As', '7c', '2d'], availableActions: [{ type: 'call', amount: 20 }, { type: 'fold' }] }), ctx);
    expect(turn2.find(o => o.type === 'YOUR_TURN')).toBeTruthy();
  });

  it('still deduplicates rapid duplicate YOUR_TURN events in the same turn', () => {
    const ctx = makeContext();

    processStateEvent(makeView({ handNumber: 2, phase: 'FLOP', isYourTurn: false, boardCards: ['As', '7c', '2d'] }), ctx);

    const turn1 = processStateEvent(makeView({ handNumber: 2, phase: 'FLOP', isYourTurn: true, boardCards: ['As', '7c', '2d'], availableActions: [{ type: 'check' }] }), ctx);
    expect(turn1.find(o => o.type === 'YOUR_TURN')).toBeTruthy();

    const turn2 = processStateEvent(makeView({ handNumber: 2, phase: 'FLOP', isYourTurn: true, boardCards: ['As', '7c', '2d'], availableActions: [{ type: 'check' }] }), ctx);
    expect(turn2.find(o => o.type === 'YOUR_TURN')).toBeFalsy();
  });
});

describe('processStateEvent — YOUR_TURN re-fires after ACTION_REJECTED reset', () => {
  it('re-fires YOUR_TURN when lastTurnKey is manually cleared (simulating ACTION_REJECTED)', () => {
    const ctx = makeContext();

    processStateEvent(makeView({ handNumber: 3, phase: 'PREFLOP', isYourTurn: false }), ctx);

    const turn1 = processStateEvent(makeView({ handNumber: 3, phase: 'PREFLOP', isYourTurn: true, availableActions: [{ type: 'call', amount: 20 }] }), ctx);
    expect(turn1.find(o => o.type === 'YOUR_TURN')).toBeTruthy();
    expect(ctx.lastTurnKey).toBe('3:PREFLOP');

    ctx.lastTurnKey = null;

    const turn2 = processStateEvent(makeView({ handNumber: 3, phase: 'PREFLOP', isYourTurn: true, availableActions: [{ type: 'call', amount: 20 }] }), ctx);
    expect(turn2.find(o => o.type === 'YOUR_TURN')).toBeTruthy();
  });
});

describe('processStateEvent — YOUR_TURN suppression during 429 backoff', () => {
  it('suppresses YOUR_TURN when lastTurnKey is set (429 backoff), then re-fires after manual reset', () => {
    const ctx = makeContext();

    processStateEvent(makeView({ handNumber: 5, phase: 'FLOP', isYourTurn: false, boardCards: ['As', '7c', '2d'] }), ctx);

    const turn1 = processStateEvent(makeView({ handNumber: 5, phase: 'FLOP', isYourTurn: true, boardCards: ['As', '7c', '2d'], availableActions: [{ type: 'raise', minAmount: 40, maxAmount: 500 }] }), ctx);
    expect(turn1.find(o => o.type === 'YOUR_TURN')).toBeTruthy();
    expect(ctx.lastTurnKey).toBe('5:FLOP');

    const during1 = processStateEvent(makeView({ handNumber: 5, phase: 'FLOP', isYourTurn: true, boardCards: ['As', '7c', '2d'], availableActions: [{ type: 'raise', minAmount: 40, maxAmount: 500 }] }), ctx);
    expect(during1.find(o => o.type === 'YOUR_TURN')).toBeFalsy();

    const during2 = processStateEvent(makeView({ handNumber: 5, phase: 'FLOP', isYourTurn: true, boardCards: ['As', '7c', '2d'], availableActions: [{ type: 'raise', minAmount: 40, maxAmount: 500 }] }), ctx);
    expect(during2.find(o => o.type === 'YOUR_TURN')).toBeFalsy();

    ctx.lastTurnKey = null;

    const turn2 = processStateEvent(makeView({ handNumber: 5, phase: 'FLOP', isYourTurn: true, boardCards: ['As', '7c', '2d'], availableActions: [{ type: 'raise', minAmount: 40, maxAmount: 500 }] }), ctx);
    expect(turn2.find(o => o.type === 'YOUR_TURN')).toBeTruthy();
  });

  it('still fires YOUR_TURN if hand advances during backoff (different turnKey)', () => {
    const ctx = makeContext();

    processStateEvent(makeView({ handNumber: 5, phase: 'FLOP', isYourTurn: false, boardCards: ['As', '7c', '2d'] }), ctx);
    processStateEvent(makeView({ handNumber: 5, phase: 'FLOP', isYourTurn: true, boardCards: ['As', '7c', '2d'], availableActions: [{ type: 'check' }] }), ctx);
    expect(ctx.lastTurnKey).toBe('5:FLOP');

    processStateEvent(makeView({ handNumber: 5, phase: 'TURN', isYourTurn: false, boardCards: ['As', '7c', '2d', 'Kh'] }), ctx);
    expect(ctx.lastTurnKey).toBeNull();

    const turn = processStateEvent(makeView({ handNumber: 5, phase: 'TURN', isYourTurn: true, boardCards: ['As', '7c', '2d', 'Kh'], availableActions: [{ type: 'check' }] }), ctx);
    expect(turn.find(o => o.type === 'YOUR_TURN')).toBeTruthy();
  });
});

describe('processStateEvent — HAND_RESULT', () => {
  it('returns HAND_RESULT when active phase → SHOWDOWN', () => {
    const prevView = makeView({ phase: 'RIVER' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'RIVER' });

    const nextView = makeView({ phase: 'SHOWDOWN', isYourTurn: false, boardCards: ['As', '7c', '2d', 'Kh', '3s'] });
    const result = processStateEvent(nextView, ctx);

    expect(Array.isArray(result)).toBe(true);
    const handResult = result.find(o => o.type === 'HAND_RESULT');
    expect(handResult).toBeTruthy();
    expect('state' in handResult! && handResult.state === nextView).toBe(true);
    expect('handNumber' in handResult! && handResult.handNumber === 1).toBe(true);
  });

  it('returns HAND_RESULT when active phase → WAITING', () => {
    const prevView = makeView({ phase: 'FLOP' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'FLOP' });

    const nextView = makeView({ phase: 'WAITING', isYourTurn: false, boardCards: ['As', '7c', '2d'] });
    const result = processStateEvent(nextView, ctx);

    const handResult = result.find(o => o.type === 'HAND_RESULT');
    expect(handResult).toBeTruthy();
    expect('handNumber' in handResult! && handResult.handNumber === 1).toBe(true);
  });

  it('does NOT return HAND_RESULT for WAITING → WAITING', () => {
    const prevView = makeView({ phase: 'WAITING' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'WAITING' });

    const nextView = makeView({ phase: 'WAITING', isYourTurn: false });
    const result = processStateEvent(nextView, ctx);

    const handResult = result.find(o => o.type === 'HAND_RESULT');
    expect(handResult).toBeUndefined();
  });
});

describe('processStateEvent — REBUY_AVAILABLE', () => {
  it('returns REBUY_AVAILABLE when busted and can rebuy', () => {
    const prevView = makeView({ phase: 'RIVER' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'RIVER' });

    const nextView = makeView({ phase: 'WAITING', isYourTurn: false, yourChips: 0, canRebuy: true });
    const result = processStateEvent(nextView, ctx);

    const rebuy = result.find(o => o.type === 'REBUY_AVAILABLE');
    expect(rebuy).toBeTruthy();
    expect('state' in rebuy! && rebuy.state === nextView).toBe(true);
    expect('handNumber' in rebuy! && rebuy.handNumber === 1).toBe(true);
  });

  it('returns REBUY_AVAILABLE on fast hand transition when busted and can rebuy', () => {
    const prevView = makeView({ handNumber: 3, phase: 'PREFLOP' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'PREFLOP' });

    const nextView = makeView({ handNumber: 4, phase: 'PREFLOP', yourChips: 0, canRebuy: true });
    const result = processStateEvent(nextView, ctx);

    const rebuy = result.find(o => o.type === 'REBUY_AVAILABLE');
    expect(rebuy).toBeTruthy();
    expect('handNumber' in rebuy! && rebuy.handNumber === 3).toBe(true);

    const handResult = result.find(o => o.type === 'HAND_RESULT');
    expect(handResult).toBeUndefined();
  });
});

// ─── Hand transition detection ──────────────────────────────────────

describe('processStateEvent — hand transitions', () => {
  it('returns HAND_RESULT when hand number changes (fast transition)', () => {
    const prevView = makeView({ handNumber: 1, phase: 'PREFLOP' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'PREFLOP' });

    const nextView = makeView({ handNumber: 2, phase: 'PREFLOP' });
    const result = processStateEvent(nextView, ctx);

    const handResult = result.find(o => o.type === 'HAND_RESULT');
    expect(handResult).toBeTruthy();
    expect('handNumber' in handResult! && handResult.handNumber === 1).toBe(true);
  });

  it('does not duplicate HAND_RESULT when phase transition and hand change coincide', () => {
    const prevView = makeView({ handNumber: 1, phase: 'RIVER' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'RIVER' });

    const nextView = makeView({ handNumber: 2, phase: 'PREFLOP' });
    const result = processStateEvent(nextView, ctx);

    const handResults = result.filter(o => o.type === 'HAND_RESULT');
    expect(handResults).toHaveLength(1);
    expect('handNumber' in handResults[0] && handResults[0].handNumber === 1).toBe(true);
  });

  it('does not re-emit HAND_RESULT for already-reported hand', () => {
    const prevView = makeView({ handNumber: 1, phase: 'PREFLOP' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'PREFLOP', lastReportedHand: 1 });

    const nextView = makeView({ handNumber: 2, phase: 'PREFLOP' });
    const result = processStateEvent(nextView, ctx);

    const handResults = result.filter(o => o.type === 'HAND_RESULT');
    expect(handResults).toHaveLength(0);
  });
});

// ─── WAITING_FOR_PLAYERS ─────────────────────────────────────────────

describe('processStateEvent — WAITING_FOR_PLAYERS', () => {
  it('does NOT fire on first state when hero is alone (fresh table)', () => {
    const ctx = makeContext();
    const view = makeView({
      phase: 'WAITING',
      players: [
        { userId: 'user-hero', seat: 0, name: 'Hero', chips: 1000, bet: 0, invested: 0, status: 'active', isDealer: false, isCurrentActor: false },
      ],
    });
    const result = processStateEvent(view, ctx);
    const waiting = result.find(o => o.type === 'WAITING_FOR_PLAYERS');
    expect(waiting).toBeUndefined();
  });

  it('fires when opponents leave after being present', () => {
    const prevView = makeView({ phase: 'WAITING' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'WAITING' });

    const nextView = makeView({
      phase: 'WAITING',
      players: [
        { userId: 'user-hero', seat: 0, name: 'Hero', chips: 1000, bet: 0, invested: 0, status: 'active', isDealer: false, isCurrentActor: false },
      ],
    });
    const result = processStateEvent(nextView, ctx);
    const waiting = result.find(o => o.type === 'WAITING_FOR_PLAYERS');
    expect(waiting).toBeTruthy();
  });
});

// ─── buildHandResultSummary ─────────────────────────────────────────

describe('buildHandResultSummary', () => {
  it('includes bold hand prefix and reports hero stack (not first player)', () => {
    const state = makeView({
      yourSeat: 1,
      yourChips: 1020,
      lastHandResult: {
        winners: [1],
        players: [
          { userId: 'user-alice', seat: 0, name: 'Alice', chips: 980 },
          { userId: 'user-hero', seat: 1, name: 'Hero', chips: 1020 },
        ],
        potResults: [{ winners: [1], amount: 40 }],
      },
    });
    const result = buildHandResultSummary(state, 3);
    expect(result).toContain('**[Hand #3]**');
    expect(result).toContain('Hero won 40');
    expect(result).toContain('Stack: 1020');
    expect(result).not.toContain('Stack: 980');
  });

  it('returns null when no lastHandResult', () => {
    const state = makeView({ yourChips: 1000 });
    expect(buildHandResultSummary(state, 1)).toBeNull();
  });
});

// ─── parseDirectArgs ────────────────────────────────────────────────

describe('parseDirectArgs — canonical flags', () => {
  it('parses --channel and --chat-id', () => {
    const argv = ['node', 'clawplay-listener.js', 'url', 'key', 'table', '--channel', 'telegram', '--chat-id', '7014171428'];
    const result = parseDirectArgs(argv);

    expect(result.enabled).toBe(true);
    expect(result.channel).toBe('telegram');
    expect(result.chatId).toBe('7014171428');
  });

  it('accepts --target as alias for --chat-id', () => {
    const argv = ['node', 'clawplay-listener.js', 'url', 'key', 'table', '--channel', 'telegram', '--target', '12345'];
    const result = parseDirectArgs(argv);

    expect(result.enabled).toBe(true);
    expect(result.chatId).toBe('12345');
  });

  it('accepts --to as alias for --chat-id', () => {
    const argv = ['node', 'clawplay-listener.js', 'url', 'key', 'table', '--channel', 'telegram', '--to', '12345'];
    const result = parseDirectArgs(argv);

    expect(result.enabled).toBe(true);
    expect(result.chatId).toBe('12345');
  });

  it('returns enabled=false when --channel is missing', () => {
    const argv = ['node', 'clawplay-listener.js', 'url', 'key', 'table', '--chat-id', '12345'];
    const result = parseDirectArgs(argv);

    expect(result.enabled).toBe(false);
    expect(result.channel).toBeNull();
  });

  it('returns enabled=false when --chat-id is missing', () => {
    const argv = ['node', 'clawplay-listener.js', 'url', 'key', 'table', '--channel', 'telegram'];
    const result = parseDirectArgs(argv);

    expect(result.enabled).toBe(false);
    expect(result.chatId).toBeNull();
  });

  it('returns enabled=false when no flags', () => {
    const argv = ['node', 'clawplay-listener.js', 'url', 'key', 'table'];
    const result = parseDirectArgs(argv);

    expect(result.enabled).toBe(false);
  });
});

// ─── buildDecisionPrompt ────────────────────────────────────────────

describe('buildDecisionPrompt', () => {
  it('includes summary and asks for structured JSON output', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh | Pot:30', '', [], [], [], '');

    expect(prompt).toContain('PREFLOP | As Kh | Pot:30');
    expect(prompt).toContain('Respond with ONLY a JSON object');
    expect(prompt).toContain('"action"');
    expect(prompt).toContain('"narration"');
    expect(prompt).not.toContain('curl');
  });

  it('includes playbook section when present', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', 'You are a loose-aggressive maniac', [], [], [], '');

    expect(prompt).toContain('You are a loose-aggressive maniac');
    expect(prompt).not.toContain('skilled poker player');
  });

  it('uses default playbook when empty', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', '', [], [], [], '');

    expect(prompt).toContain('skilled poker player');
  });

  it('does not include mechanical strategy chart', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', '', [], [], [], '');

    expect(prompt).not.toContain('AA/KK/QQ');
    expect(prompt).not.toContain('3x BB');
    expect(prompt).not.toContain('pot odds > 4:1');
  });

  it('includes current hand events when provided', () => {
    const handEvents = ['**[Hand #5]** Alice raised to 40', '**[Hand #5]** Bob called 40'];
    const prompt = buildDecisionPrompt('FLOP | Board: As 7c 2d', '', handEvents, [], [], '');

    expect(prompt).toContain('THIS HAND');
    expect(prompt).toContain('Alice raised to 40');
    expect(prompt).toContain('Bob called 40');
  });

  it('includes recent hand results when provided', () => {
    const results = ['#3: You won 80 uncontested.'];
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', '', [], results, [], '');

    expect(prompt).toContain('RECENT HANDS');
    expect(prompt).toContain('You won 80');
  });

  it('includes opponent profile when provided', () => {
    const opponentStats = ['Jiro (42 hands): VPIP 38% · PFR 22% · 3-bet 6% · AF 1.5 · Fold-to-raise 48%\n→ Loose-aggressive'];
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', '', [], [], opponentStats, '');

    expect(prompt).toContain('OPPONENT PROFILE');
    expect(prompt).toContain('Jiro (42 hands)');
    expect(prompt).toContain('Loose-aggressive');
  });

  it('includes session insights when provided', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', '', [], [], [], 'Jiro folds to flop re-raises.');

    expect(prompt).toContain('SESSION INSIGHTS');
    expect(prompt).toContain('Jiro folds to flop re-raises.');
  });

  it('omits hand events section when empty', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', '', [], [], [], '');
    expect(prompt).not.toContain('THIS HAND');
  });

  it('omits recent results section when empty', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', '', [], [], [], '');
    expect(prompt).not.toContain('RECENT HANDS');
  });

  it('omits opponent profile section when empty', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', '', [], [], [], '');
    expect(prompt).not.toContain('OPPONENT PROFILE');
  });

  it('omits session insights section when empty', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', '', [], [], [], '');
    expect(prompt).not.toContain('SESSION INSIGHTS');
  });

  it('includes session notes when provided', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', '', [], [], [], '', 'play aggressively');

    expect(prompt).toContain('Tactical notes from your human partner:');
    expect(prompt).toContain('Session notes:');
    expect(prompt).toContain('play aggressively');
  });

  it('includes hand notes when provided', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', '', [], [], [], '', '', 'go all-in this hand');

    expect(prompt).toContain('Tactical notes from your human partner:');
    expect(prompt).toContain('THIS HAND ONLY:');
    expect(prompt).toContain('go all-in this hand');
  });

  it('includes both session and hand notes when both provided', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', '', [], [], [], '', 'play tight', 'fold this one');

    expect(prompt).toContain('Session notes:');
    expect(prompt).toContain('play tight');
    expect(prompt).toContain('THIS HAND ONLY:');
    expect(prompt).toContain('fold this one');
  });

  it('omits notes section when both empty', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', '', [], [], [], '', '', '');
    expect(prompt).not.toContain('Tactical notes');
  });

  it('omits notes section when not provided', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', '', [], [], [], '');
    expect(prompt).not.toContain('Tactical notes');
  });
});

// ─── buildSummary — board cards ─────────────────────────────────────

describe('buildSummary — board cards', () => {
  it('includes board cards on flop', () => {
    const view = makeView({
      phase: 'FLOP',
      boardCards: ['6d', 'Ad', 'Js'],
      yourCards: ['6c', '6h'],
      pot: 40,
      yourChips: 940,
      availableActions: [{ type: 'check' }],
    });
    const result = buildSummary(view);
    expect(result).toContain('Board: 6♦ A♦ J♠');
    expect(result).toContain('6♣ 6♥');
    expect(result.startsWith('FLOP |')).toBe(true);
  });

  it('includes board cards on turn', () => {
    const view = makeView({
      phase: 'TURN',
      boardCards: ['6d', 'Ad', 'Js', '3c'],
      yourCards: ['6c', '6h'],
      pot: 80,
      yourChips: 900,
      availableActions: [{ type: 'check' }, { type: 'raise', minAmount: 20, maxAmount: 900 }],
    });
    const result = buildSummary(view);
    expect(result).toContain('Board: 6♦ A♦ J♠ 3♣');
  });

  it('includes board cards on river', () => {
    const view = makeView({
      phase: 'RIVER',
      boardCards: ['6d', 'Ad', 'Js', '3c', '9h'],
      yourCards: ['6c', '6h'],
      pot: 160,
      yourChips: 820,
      availableActions: [{ type: 'check' }],
    });
    const result = buildSummary(view);
    expect(result).toContain('Board: 6♦ A♦ J♠ 3♣ 9♥');
  });

  it('omits board section preflop (no board cards)', () => {
    const view = makeView({
      phase: 'PREFLOP',
      boardCards: [],
      yourCards: ['As', 'Kh'],
      pot: 30,
      yourChips: 970,
      availableActions: [{ type: 'call', amount: 20 }, { type: 'fold' }],
    });
    const result = buildSummary(view);
    expect(result).not.toContain('Board:');
    expect(result.startsWith('PREFLOP | A♠ K♥')).toBe(true);
  });

  it('omits board section when boardCards is undefined', () => {
    const view = makeView({
      phase: 'PREFLOP',
      yourCards: ['As', 'Kh'],
      pot: 30,
      yourChips: 970,
      availableActions: [{ type: 'fold' }],
    });
    (view as { boardCards?: string[] }).boardCards = undefined as unknown as string[];
    const result = buildSummary(view);
    expect(result).not.toContain('Board:');
  });
});

// ─── readPlaybook / readNotes ───────────────────────────────────────

describe('readPlaybook', () => {
  it('returns empty string when file is missing', () => {
    const result = readPlaybook();
    expect(result).toBe('');
  });
});

describe('readNotes', () => {
  it('returns empty string when file is missing', () => {
    const result = readNotes();
    expect(result).toBe('');
  });
});

// ─── PID lock ────────────────────────────────────────────────────────

describe('acquirePidLock', () => {
  let tempDir: string;
  let lockFile: string;

  afterEach(() => {
    try { unlinkSync(lockFile); } catch {}
    try { rmSync(tempDir, { recursive: true }); } catch {}
  });

  function setup(): void {
    tempDir = mkdtempSync(join(tmpdir(), 'listener-lock-'));
    lockFile = join(tempDir, '.clawplay-listener-main.pid');
  }

  it('writes PID to lock file', async () => {
    setup();
    const emitted: Record<string, unknown>[] = [];
    await acquirePidLock(lockFile, (obj) => emitted.push(obj));

    expect(existsSync(lockFile)).toBe(true);
    expect(readFileSync(lockFile, 'utf8').trim()).toBe(String(process.pid));
  });

  it('handles missing lock file gracefully', async () => {
    setup();
    const emitted: Record<string, unknown>[] = [];
    // No pre-existing lock file
    await acquirePidLock(lockFile, (obj) => emitted.push(obj));

    expect(readFileSync(lockFile, 'utf8').trim()).toBe(String(process.pid));
    expect(emitted.find(e => e.type === 'KILLING_STALE_LISTENER')).toBeUndefined();
  });

  it('handles stale lock file (dead PID) gracefully', async () => {
    setup();
    writeFileSync(lockFile, '999999999'); // Non-existent PID
    const emitted: Record<string, unknown>[] = [];

    await acquirePidLock(lockFile, (obj) => emitted.push(obj));

    // Should overwrite with our PID
    expect(readFileSync(lockFile, 'utf8').trim()).toBe(String(process.pid));
    // Dead process → no KILLING_STALE_LISTENER (kill(pid, 0) throws ESRCH)
    expect(emitted.find(e => e.type === 'KILLING_STALE_LISTENER')).toBeUndefined();
  });

  it('does not kill self when lock file contains own PID', async () => {
    setup();
    writeFileSync(lockFile, String(process.pid));
    const emitted: Record<string, unknown>[] = [];

    await acquirePidLock(lockFile, (obj) => emitted.push(obj));

    expect(emitted.find(e => e.type === 'KILLING_STALE_LISTENER')).toBeUndefined();
  });
});

describe('releasePidLock', () => {
  it('removes lock file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'listener-lock-'));
    const lockFile = join(tempDir, '.clawplay-listener-main.pid');
    writeFileSync(lockFile, String(process.pid));

    releasePidLock(lockFile);

    expect(existsSync(lockFile)).toBe(false);
    rmSync(tempDir, { recursive: true });
  });

  it('handles non-existent lock file gracefully', () => {
    // Should not throw
    releasePidLock('/tmp/nonexistent-lock-file-12345.pid');
  });
});

// ─── isBeingReplaced ──────────────────────────────────────────────

describe('isBeingReplaced', () => {
  let tempDir: string;
  let lockFile: string;

  afterEach(() => {
    try { unlinkSync(lockFile); } catch {}
    try { rmSync(tempDir, { recursive: true }); } catch {}
  });

  function setup(): void {
    tempDir = mkdtempSync(join(tmpdir(), 'listener-replace-'));
    lockFile = join(tempDir, '.clawplay-listener-main.pid');
  }

  it('returns false when lock file is null', () => {
    expect(isBeingReplaced(null)).toBe(false);
  });

  it('returns false when lock file does not exist', () => {
    expect(isBeingReplaced('/tmp/nonexistent-lock-12345.pid')).toBe(false);
  });

  it('returns false when lock file contains own PID', () => {
    setup();
    writeFileSync(lockFile, String(process.pid));
    expect(isBeingReplaced(lockFile)).toBe(false);
  });

  it('returns true when lock file contains a different PID', () => {
    setup();
    writeFileSync(lockFile, '99999');
    expect(isBeingReplaced(lockFile)).toBe(true);
  });

  it('returns false when lock file contains corrupted data', () => {
    setup();
    writeFileSync(lockFile, 'not-a-pid');
    expect(isBeingReplaced(lockFile)).toBe(false);
  });
});

// ─── acquirePidLock — PID write ordering ──────────────────────────

describe('acquirePidLock — replacement ordering', () => {
  let tempDir: string;
  let lockFile: string;

  afterEach(() => {
    try { unlinkSync(lockFile); } catch {}
    try { rmSync(tempDir, { recursive: true }); } catch {}
  });

  it('acquires lock from dead process and ends with caller PID', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'listener-order-'));
    lockFile = join(tempDir, '.clawplay-listener-main.pid');
    writeFileSync(lockFile, '999999999');

    const emitted: Record<string, unknown>[] = [];
    await acquirePidLock(lockFile, (obj) => emitted.push(obj));

    expect(readFileSync(lockFile, 'utf8').trim()).toBe(String(process.pid));
  });

  it('writes new PID to lock file before sending SIGTERM to live process', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'listener-order-'));
    lockFile = join(tempDir, '.clawplay-listener-main.pid');
    const fakePid = process.pid + 1;
    writeFileSync(lockFile, String(fakePid));

    // Spy on process.kill to intercept signals and check lock file state
    let lockContentAtSigterm: string | null = null;
    let aliveChecks = 0;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === 'SIGTERM') {
        // At SIGTERM time, read the lock file to verify our PID is already there
        lockContentAtSigterm = readFileSync(lockFile, 'utf8').trim();
      }
      if (sig === 0 || sig === undefined) {
        aliveChecks++;
        // First alive check: pretend alive. Subsequent: pretend dead.
        if (aliveChecks === 1) return true;
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return true;
    }) as typeof process.kill);

    const emitted: Record<string, unknown>[] = [];
    await acquirePidLock(lockFile, (obj) => emitted.push(obj));

    // The key assertion: at the moment SIGTERM was sent, the lock file
    // already contained our PID (not the old one)
    expect(lockContentAtSigterm).toBe(String(process.pid));
    expect(emitted.find(e => e.type === 'KILLING_STALE_LISTENER')).toBeTruthy();

    killSpy.mockRestore();
  });
});
