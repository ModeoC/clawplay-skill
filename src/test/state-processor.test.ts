/**
 * Tests for processStateEvent — specifically DRAMA_MOMENT output detection.
 *
 * Drama triggers: significant all-in (≥50% pot), big-pot showdown, bust-out.
 */

import { describe, it, expect } from 'vitest';
import { processStateEvent } from '../state-processor.js';
import { makeView, makeContext } from './helpers.js';
import type { ListenerContext, GameTransition } from '../types.js';

// ── All-in drama detection ──────────────────────────────────────────

describe('processStateEvent — all-in DRAMA_MOMENT', () => {
  it('emits DRAMA_MOMENT for all-in ≥50% of pot', () => {
    const context = makeContext({
      prevState: makeView({ handNumber: 1, phase: 'FLOP' }),
      prevPhase: 'FLOP',
    });
    const view = makeView({ handNumber: 1, phase: 'FLOP', pot: 400, yourSeat: 0 });
    const transitions: GameTransition[] = [
      { type: 'player-action', seat: 1, action: 'all_in', amount: 300, playerName: 'Alice' },
    ];

    const outputs = processStateEvent(view, context, transitions);
    const drama = outputs.filter(o => o.type === 'DRAMA_MOMENT');

    expect(drama).toHaveLength(1);
    expect(drama[0].type === 'DRAMA_MOMENT' && drama[0].description).toContain('Alice goes all-in for 300');
    expect(drama[0].type === 'DRAMA_MOMENT' && drama[0].description).toContain('400 pot');
  });

  it('does NOT emit DRAMA_MOMENT for all-in <50% of pot (short-stack shove)', () => {
    const context = makeContext({
      prevState: makeView({ handNumber: 1, phase: 'FLOP' }),
      prevPhase: 'FLOP',
    });
    const view = makeView({ handNumber: 1, phase: 'FLOP', pot: 400, yourSeat: 0 });
    const transitions: GameTransition[] = [
      { type: 'player-action', seat: 1, action: 'all_in', amount: 100, playerName: 'Alice' },
    ];

    const outputs = processStateEvent(view, context, transitions);
    const drama = outputs.filter(o => o.type === 'DRAMA_MOMENT');

    expect(drama).toHaveLength(0);
  });

  it('does NOT emit DRAMA_MOMENT for own all-in', () => {
    const context = makeContext({
      prevState: makeView({ handNumber: 1, phase: 'FLOP' }),
      prevPhase: 'FLOP',
    });
    const view = makeView({ handNumber: 1, phase: 'FLOP', pot: 400, yourSeat: 0 });
    const transitions: GameTransition[] = [
      { type: 'player-action', seat: 0, action: 'all_in', amount: 500, playerName: 'Hero' },
    ];

    const outputs = processStateEvent(view, context, transitions);
    const drama = outputs.filter(o => o.type === 'DRAMA_MOMENT');

    expect(drama).toHaveLength(0);
  });

  it('does NOT emit for non-all-in actions', () => {
    const context = makeContext({
      prevState: makeView({ handNumber: 1, phase: 'FLOP' }),
      prevPhase: 'FLOP',
    });
    const view = makeView({ handNumber: 1, phase: 'FLOP', pot: 400, yourSeat: 0 });
    const transitions: GameTransition[] = [
      { type: 'player-action', seat: 1, action: 'raise', amount: 300, playerName: 'Alice' },
    ];

    const outputs = processStateEvent(view, context, transitions);
    const drama = outputs.filter(o => o.type === 'DRAMA_MOMENT');

    expect(drama).toHaveLength(0);
  });
});

// ── Showdown drama detection ────────────────────────────────────────

describe('processStateEvent — showdown DRAMA_MOMENT', () => {
  it('emits DRAMA_MOMENT for big-pot showdown with multiple hands', () => {
    // bb=20, maxPlayers=6, threshold = 20*6*2 = 240
    const context = makeContext({
      prevState: makeView({ handNumber: 1, phase: 'RIVER' }),
      prevPhase: 'RIVER',
    });
    const view = makeView({
      handNumber: 1,
      phase: 'SHOWDOWN',
      pot: 500,
      yourSeat: 0,
      forcedBets: { smallBlind: 10, bigBlind: 20, ante: 0 },
      numSeats: 6,
      lastHandResult: {
        winners: [1],
        players: [
          { userId: 'user-hero', seat: 0, name: 'Hero', chips: 700 },
          { userId: 'user-alice', seat: 1, name: 'Alice', chips: 1300 },
        ],
        potResults: [{ winners: [1], amount: 500 }],
        showdownHands: [
          { seat: 0, holeCards: ['Ah', 'Kh'], handRanking: 'Pair' },
          { seat: 1, holeCards: ['Qc', 'Qd'], handRanking: 'Three of a Kind' },
        ],
      },
    });

    const outputs = processStateEvent(view, context);
    const drama = outputs.filter(o => o.type === 'DRAMA_MOMENT');

    expect(drama).toHaveLength(1);
    expect(drama[0].type === 'DRAMA_MOMENT' && drama[0].description).toContain('Showdown');
    expect(drama[0].type === 'DRAMA_MOMENT' && drama[0].description).toContain('500 chip pot');
  });

  it('does NOT emit for routine showdown (small pot)', () => {
    // pot=100 < threshold=240
    const context = makeContext({
      prevState: makeView({ handNumber: 1, phase: 'RIVER' }),
      prevPhase: 'RIVER',
    });
    const view = makeView({
      handNumber: 1,
      phase: 'SHOWDOWN',
      pot: 100,
      forcedBets: { smallBlind: 10, bigBlind: 20, ante: 0 },
      numSeats: 6,
      lastHandResult: {
        winners: [1],
        players: [
          { userId: 'user-hero', seat: 0, name: 'Hero', chips: 900 },
          { userId: 'user-alice', seat: 1, name: 'Alice', chips: 1100 },
        ],
        potResults: [{ winners: [1], amount: 100 }],
        showdownHands: [
          { seat: 0, holeCards: ['Ah', 'Kh'], handRanking: 'High Card' },
          { seat: 1, holeCards: ['Qc', 'Qd'], handRanking: 'Pair' },
        ],
      },
    });

    const outputs = processStateEvent(view, context);
    const drama = outputs.filter(o => o.type === 'DRAMA_MOMENT');

    expect(drama).toHaveLength(0);
  });

  it('does NOT emit for showdown with only one hand shown', () => {
    const context = makeContext({
      prevState: makeView({ handNumber: 1, phase: 'RIVER' }),
      prevPhase: 'RIVER',
      lastReportedHand: 0,
    });
    const view = makeView({
      handNumber: 1,
      phase: 'SHOWDOWN',
      pot: 500,
      forcedBets: { smallBlind: 10, bigBlind: 20, ante: 0 },
      numSeats: 6,
      lastHandResult: {
        winners: [1],
        players: [
          { userId: 'user-hero', seat: 0, name: 'Hero', chips: 700 },
          { userId: 'user-alice', seat: 1, name: 'Alice', chips: 1300 },
        ],
        potResults: [{ winners: [1], amount: 500 }],
        showdownHands: [
          { seat: 1, holeCards: ['Qc', 'Qd'], handRanking: 'Three of a Kind' },
        ],
      },
    });

    const outputs = processStateEvent(view, context);
    const drama = outputs.filter(o => o.type === 'DRAMA_MOMENT');

    expect(drama).toHaveLength(0);
  });
});

// ── Bust-out drama detection ────────────────────────────────────────

describe('processStateEvent — bust-out DRAMA_MOMENT', () => {
  it('emits DRAMA_MOMENT when opponent busts out', () => {
    const prevView = makeView({
      handNumber: 1,
      phase: 'FLOP',
      players: [
        { userId: 'user-hero', seat: 0, name: 'Hero', chips: 1500, bet: 0, invested: 0, status: 'active', isDealer: true, isCurrentActor: false },
        { userId: 'user-alice', seat: 1, name: 'Alice', chips: 200, bet: 0, invested: 0, status: 'active', isDealer: false, isCurrentActor: false },
      ],
    });
    const context = makeContext({
      prevState: prevView,
      prevPhase: 'FLOP',
    });
    const view = makeView({
      handNumber: 1,
      phase: 'FLOP',
      yourSeat: 0,
      players: [
        { userId: 'user-hero', seat: 0, name: 'Hero', chips: 1700, bet: 0, invested: 0, status: 'active', isDealer: true, isCurrentActor: false },
        { userId: 'user-alice', seat: 1, name: 'Alice', chips: 0, bet: 0, invested: 0, status: 'eliminated', isDealer: false, isCurrentActor: false },
      ],
    });

    const outputs = processStateEvent(view, context);
    const drama = outputs.filter(o => o.type === 'DRAMA_MOMENT');

    expect(drama).toHaveLength(1);
    expect(drama[0].type === 'DRAMA_MOMENT' && drama[0].description).toContain('Alice busted out!');
  });

  it('does NOT emit bust-out for own seat', () => {
    const prevView = makeView({
      handNumber: 1,
      phase: 'FLOP',
      yourSeat: 0,
      players: [
        { userId: 'user-hero', seat: 0, name: 'Hero', chips: 200, bet: 0, invested: 0, status: 'active', isDealer: true, isCurrentActor: false },
        { userId: 'user-alice', seat: 1, name: 'Alice', chips: 1800, bet: 0, invested: 0, status: 'active', isDealer: false, isCurrentActor: false },
      ],
    });
    const context = makeContext({
      prevState: prevView,
      prevPhase: 'FLOP',
    });
    const view = makeView({
      handNumber: 1,
      phase: 'FLOP',
      yourSeat: 0,
      players: [
        { userId: 'user-hero', seat: 0, name: 'Hero', chips: 0, bet: 0, invested: 0, status: 'eliminated', isDealer: true, isCurrentActor: false },
        { userId: 'user-alice', seat: 1, name: 'Alice', chips: 2000, bet: 0, invested: 0, status: 'active', isDealer: false, isCurrentActor: false },
      ],
    });

    const outputs = processStateEvent(view, context);
    const drama = outputs.filter(o => o.type === 'DRAMA_MOMENT');

    expect(drama).toHaveLength(0);
  });

  it('does NOT emit bust-out when player was already at 0 chips', () => {
    const prevView = makeView({
      handNumber: 1,
      phase: 'FLOP',
      players: [
        { userId: 'user-hero', seat: 0, name: 'Hero', chips: 1000, bet: 0, invested: 0, status: 'active', isDealer: true, isCurrentActor: false },
        { userId: 'user-alice', seat: 1, name: 'Alice', chips: 0, bet: 0, invested: 0, status: 'eliminated', isDealer: false, isCurrentActor: false },
      ],
    });
    const context = makeContext({
      prevState: prevView,
      prevPhase: 'FLOP',
    });
    const view = makeView({
      handNumber: 1,
      phase: 'FLOP',
      yourSeat: 0,
      players: [
        { userId: 'user-hero', seat: 0, name: 'Hero', chips: 1000, bet: 0, invested: 0, status: 'active', isDealer: true, isCurrentActor: false },
        { userId: 'user-alice', seat: 1, name: 'Alice', chips: 0, bet: 0, invested: 0, status: 'eliminated', isDealer: false, isCurrentActor: false },
      ],
    });

    const outputs = processStateEvent(view, context);
    const drama = outputs.filter(o => o.type === 'DRAMA_MOMENT');

    expect(drama).toHaveLength(0);
  });
});
