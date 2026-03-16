import { describe, it, expect } from 'vitest';
import { diffStates } from '../state-differ.js';
import type { PlayerView, PlayerInfo } from '../types.js';

/**
 * State-differ needs 3-player views (Hero, Alice, Bob) for full coverage.
 * Uses its own factory instead of the shared 2-player one.
 */
function make3PlayerView(overrides: Partial<PlayerView> = {}): PlayerView {
  const base: PlayerView = {
    gameId: 'game-1',
    handNumber: 1,
    phase: 'PREFLOP',
    pot: 30,
    boardCards: [],
    yourSeat: 0,
    yourCards: ['As', 'Kh'],
    yourChips: 970,
    yourBet: 10,
    isYourTurn: false,
    availableActions: [],
    players: [
      {
        userId: 'user-hero', seat: 0, name: 'Hero', chips: 970, bet: 10,
        invested: 10, status: 'active', isDealer: true, isCurrentActor: false,
      },
      {
        userId: 'user-alice', seat: 1, name: 'Alice', chips: 980, bet: 20,
        invested: 20, status: 'active', isDealer: false, isCurrentActor: true,
      },
      {
        userId: 'user-bob', seat: 2, name: 'Bob', chips: 1000, bet: 0,
        invested: 0, status: 'active', isDealer: false, isCurrentActor: false,
      },
    ],
    dealerSeat: 0,
    numSeats: 6,
    forcedBets: { smallBlind: 10, bigBlind: 20, ante: 0 },
    sidePots: [],
    currentPlayerToAct: 1,
    timeoutAt: null,
  };

  const result = { ...base, ...overrides };
  if (overrides.players !== undefined) {
    result.players = overrides.players;
  }
  return result;
}

function withPlayerUpdate(view: PlayerView, seat: number, playerOverrides: Partial<PlayerInfo>): PlayerView {
  const cloned = { ...view, players: view.players.map((p) => ({ ...p })) };
  const player = cloned.players.find((p) => p.seat === seat);
  if (player) {
    Object.assign(player, playerOverrides);
  }
  return cloned;
}

// ─── 1. New hand started ─────────────────────────────────────────────

describe('diffStates — new hand started', () => {
  it('returns hand start event when prev is null', () => {
    const next = make3PlayerView({ handNumber: 1, yourCards: ['As', 'Kh'] });
    const events = diffStates(null, next);
    expect(events).toEqual(['**[Hand #1]** Your cards: A\u2660 K\u2665 \u00b7 Stack: 970']);
  });

  it('returns hand start event when handNumber changed', () => {
    const prev = make3PlayerView({ handNumber: 1 });
    const next = make3PlayerView({ handNumber: 2, yourCards: ['Tc', '9d'] });
    const events = diffStates(prev, next);
    expect(events).toEqual(['**[Hand #2]** Your cards: T\u2663 9\u2666 \u00b7 Stack: 970']);
  });

  it('does not produce other events when hand just started', () => {
    const prev = make3PlayerView({ handNumber: 1, boardCards: [] });
    const next = make3PlayerView({
      handNumber: 2,
      boardCards: ['As', '7c', '2d'],
      yourCards: ['Qh', 'Js'],
    });
    // Only the hand-start event, nothing about the flop
    const events = diffStates(prev, next);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/^\*\*\[Hand #2\]\*\*/);
  });
});

// ─── 2. Flop dealt ───────────────────────────────────────────────────

describe('diffStates — flop dealt', () => {
  it('reports flop with cards and pot', () => {
    const prev = make3PlayerView({ boardCards: [], pot: 30 });
    const next = make3PlayerView({
      boardCards: ['As', '7c', '2d'],
      pot: 42,
      phase: 'FLOP',
    });
    const events = diffStates(prev, next);
    expect(events).toContain('**[Hand #1]** Flop: A\u2660 7\u2663 2\u2666 | Pot: 42');
  });
});

// ─── 3. Turn dealt ───────────────────────────────────────────────────

describe('diffStates — turn dealt', () => {
  it('reports turn card with full board and pot', () => {
    const prev = make3PlayerView({
      boardCards: ['As', '7c', '2d'],
      pot: 42,
      phase: 'FLOP',
    });
    const next = make3PlayerView({
      boardCards: ['As', '7c', '2d', 'Kh'],
      pot: 80,
      phase: 'TURN',
    });
    const events = diffStates(prev, next);
    expect(events).toContain('**[Hand #1]** Turn: K\u2665 \u2192 A\u2660 7\u2663 2\u2666 K\u2665 | Pot: 80');
  });
});

// ─── 4. River dealt ──────────────────────────────────────────────────

describe('diffStates — river dealt', () => {
  it('reports river card with full board and pot', () => {
    const prev = make3PlayerView({
      boardCards: ['As', '7c', '2d', 'Kh'],
      pot: 80,
      phase: 'TURN',
    });
    const next = make3PlayerView({
      boardCards: ['As', '7c', '2d', 'Kh', '3s'],
      pot: 120,
      phase: 'RIVER',
    });
    const events = diffStates(prev, next);
    expect(events).toContain('**[Hand #1]** River: 3\u2660 \u2192 A\u2660 7\u2663 2\u2666 K\u2665 3\u2660 | Pot: 120');
  });
});

// ─── 5. Opponent folded ──────────────────────────────────────────────

describe('diffStates — opponent folded', () => {
  it('reports when an opponent folds', () => {
    const prev = make3PlayerView();
    const next = withPlayerUpdate({ ...make3PlayerView() }, 1, {
      status: 'folded',
      isCurrentActor: false,
    });
    const events = diffStates(prev, next);
    expect(events).toContain('**[Hand #1]** Alice folded');
  });

  it('does NOT report when our own seat folds', () => {
    const prev = make3PlayerView();
    const next = withPlayerUpdate({ ...make3PlayerView() }, 0, { status: 'folded' });
    const events = diffStates(prev, next);
    expect(events.some((e) => e.includes('Hero folded'))).toBe(false);
  });
});

// ─── 6. Opponent bet ─────────────────────────────────────────────────

describe('diffStates — opponent bet', () => {
  it('reports when opponent makes first bet with chip context', () => {
    const prev = make3PlayerView({
      phase: 'FLOP',
      players: [
        {
          userId: 'user-hero', seat: 0, name: 'Hero', chips: 970, bet: 0,
          invested: 20, status: 'active', isDealer: true, isCurrentActor: false,
        },
        {
          userId: 'user-alice', seat: 1, name: 'Alice', chips: 980, bet: 0,
          invested: 20, status: 'active', isDealer: false, isCurrentActor: true,
        },
        {
          userId: 'user-bob', seat: 2, name: 'Bob', chips: 1000, bet: 0,
          invested: 0, status: 'active', isDealer: false, isCurrentActor: false,
        },
      ],
    });
    const next: PlayerView = {
      ...prev,
      pot: 65,
      players: prev.players.map((p) => ({ ...p })),
    };
    next.players[1] = {
      ...next.players[1],
      chips: 955,
      bet: 25,
      invested: 45,
      isCurrentActor: false,
      lastAction: { type: 'bet', amount: 25 },
    };
    next.currentPlayerToAct = 2;
    const events = diffStates(prev, next);
    expect(events).toContain('**[Hand #1]** Alice bet 25 (45 invested \u00b7 955 behind)');
  });
});

// ─── 7. Opponent raised ──────────────────────────────────────────────

describe('diffStates — opponent raised', () => {
  it('reports when opponent raises above existing bet with chip context', () => {
    const prev = make3PlayerView();
    const next: PlayerView = {
      ...make3PlayerView(),
      pot: 80,
      players: make3PlayerView().players.map((p) => ({ ...p })),
    };
    next.players[2] = {
      ...next.players[2],
      name: 'Bob',
      chips: 950,
      bet: 50,
      invested: 50,
      isCurrentActor: false,
      lastAction: { type: 'raise', amount: 50 },
    };
    next.currentPlayerToAct = 0;
    const events = diffStates(prev, next);
    expect(events).toContain('**[Hand #1]** Bob raised to 50 (50 invested \u00b7 950 behind)');
  });
});

// ─── 8. Opponent called ──────────────────────────────────────────────

describe('diffStates — opponent called', () => {
  it('reports when opponent calls existing bet with chip context', () => {
    const prev = make3PlayerView();
    const next: PlayerView = {
      ...make3PlayerView(),
      pot: 50,
      players: make3PlayerView().players.map((p) => ({ ...p })),
    };
    next.players[2] = {
      ...next.players[2],
      name: 'Bob',
      chips: 980,
      bet: 20,
      invested: 20,
      isCurrentActor: false,
      lastAction: { type: 'call', amount: 20 },
    };
    next.currentPlayerToAct = 0;
    const events = diffStates(prev, next);
    expect(events).toContain('**[Hand #1]** Bob called 20 (20 invested \u00b7 980 behind)');
  });
});

// ─── 9. Opponent checked ─────────────────────────────────────────────

describe('diffStates — opponent checked', () => {
  it('reports when opponent checks (was actor, bet unchanged, still active)', () => {
    const prev = make3PlayerView({
      phase: 'FLOP',
      players: [
        {
          userId: 'user-hero', seat: 0, name: 'Hero', chips: 970, bet: 0,
          invested: 20, status: 'active', isDealer: true, isCurrentActor: false,
        },
        {
          userId: 'user-alice', seat: 1, name: 'Alice', chips: 980, bet: 0,
          invested: 20, status: 'active', isDealer: false, isCurrentActor: true,
        },
        {
          userId: 'user-bob', seat: 2, name: 'Bob', chips: 1000, bet: 0,
          invested: 0, status: 'active', isDealer: false, isCurrentActor: false,
        },
      ],
    });
    const next: PlayerView = {
      ...prev,
      players: prev.players.map((p) => ({ ...p })),
    };
    next.players[1] = {
      ...next.players[1],
      isCurrentActor: false,
      lastAction: { type: 'check' },
    };
    next.currentPlayerToAct = 2;
    const events = diffStates(prev, next);
    expect(events).toContain('**[Hand #1]** Alice checked');
  });

  it('does NOT report check for our own seat', () => {
    const prev = make3PlayerView({
      phase: 'FLOP',
      players: [
        {
          userId: 'user-hero', seat: 0, name: 'Hero', chips: 970, bet: 0,
          invested: 20, status: 'active', isDealer: true, isCurrentActor: true,
        },
        {
          userId: 'user-alice', seat: 1, name: 'Alice', chips: 980, bet: 0,
          invested: 20, status: 'active', isDealer: false, isCurrentActor: false,
        },
      ],
    });
    const next: PlayerView = {
      ...prev,
      players: prev.players.map((p) => ({ ...p })),
    };
    next.players[0] = { ...next.players[0], isCurrentActor: false };
    next.currentPlayerToAct = 1;
    const events = diffStates(prev, next);
    expect(events.some((e) => e.includes('Hero checked'))).toBe(false);
  });
});

// ─── 10. Opponent went all-in ────────────────────────────────────────

describe('diffStates — opponent went all-in', () => {
  it('reports when opponent goes all-in with invested and behind', () => {
    const prev = make3PlayerView();
    const next: PlayerView = {
      ...make3PlayerView(),
      pot: 1010,
      players: make3PlayerView().players.map((p) => ({ ...p })),
    };
    next.players[1] = {
      ...next.players[1],
      chips: 0,
      bet: 1000,
      invested: 1000,
      status: 'all_in',
      isCurrentActor: false,
    };
    const events = diffStates(prev, next);
    expect(events).toContain('**[Hand #1]** Alice went all-in (1000 invested \u00b7 0 behind)');
  });

  it('does NOT report all-in for our own seat', () => {
    const prev = make3PlayerView();
    const next: PlayerView = {
      ...make3PlayerView(),
      players: make3PlayerView().players.map((p) => ({ ...p })),
    };
    next.players[0] = {
      ...next.players[0],
      chips: 0,
      bet: 970,
      status: 'all_in',
    };
    const events = diffStates(prev, next);
    expect(events.some((e) => e.includes('Hero went all-in'))).toBe(false);
  });
});

// ─── 11. Player joined ──────────────────────────────────────────────

describe('diffStates — player joined', () => {
  it('reports when a new player appears in the players array', () => {
    const prev = make3PlayerView({
      players: [
        {
          userId: 'user-hero', seat: 0, name: 'Hero', chips: 970, bet: 10,
          invested: 10, status: 'active', isDealer: true, isCurrentActor: false,
        },
        {
          userId: 'user-alice', seat: 1, name: 'Alice', chips: 980, bet: 20,
          invested: 20, status: 'active', isDealer: false, isCurrentActor: true,
        },
      ],
    });
    const next = make3PlayerView({
      players: [
        ...prev.players.map((p) => ({ ...p })),
        {
          userId: 'user-charlie', seat: 3, name: 'Charlie', chips: 1000,
          bet: 0, invested: 0, status: 'active', isDealer: false, isCurrentActor: false,
        },
      ],
    });
    const events = diffStates(prev, next);
    expect(events).toContain('**[Hand #1]** Charlie joined the table (1000 chips)');
  });

  it('does NOT report our own seat as joining', () => {
    const prev = make3PlayerView({ players: [] });
    const next = make3PlayerView();
    const events = diffStates(prev, next);
    expect(events.some((e) => e.includes('Hero joined'))).toBe(false);
  });
});

// ─── 12. Player left ───────────────────────────────────────────────

describe('diffStates — player left', () => {
  it('reports when a player disappears from the players array', () => {
    const prev = make3PlayerView();
    const next = make3PlayerView({
      players: prev.players.filter((p) => p.seat !== 2).map((p) => ({ ...p })),
    });
    const events = diffStates(prev, next);
    expect(events).toContain('**[Hand #1]** Bob left the table');
  });

  it('does NOT report our own seat as leaving', () => {
    const prev = make3PlayerView();
    const next = make3PlayerView({
      players: prev.players.filter((p) => p.seat !== 0).map((p) => ({ ...p })),
      yourSeat: 0,
    });
    const events = diffStates(prev, next);
    expect(events.some((e) => e.includes('Hero left'))).toBe(false);
  });
});

// ─── 13. No changes ──────────────────────────────────────────────────

describe('diffStates — no changes', () => {
  it('returns empty array for identical states', () => {
    const view = make3PlayerView();
    const events = diffStates(view, view);
    expect(events).toEqual([]);
  });

  it('returns empty array when states are structurally identical copies', () => {
    const prev = make3PlayerView();
    const next = make3PlayerView();
    const events = diffStates(prev, next);
    expect(events).toEqual([]);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────

describe('diffStates — edge cases', () => {
  it('handles multiple events in one diff (e.g. fold + board card)', () => {
    const prev = make3PlayerView({
      boardCards: [],
      pot: 40,
      players: [
        {
          userId: 'user-hero', seat: 0, name: 'Hero', chips: 970, bet: 20,
          invested: 20, status: 'active', isDealer: true, isCurrentActor: false,
        },
        {
          userId: 'user-alice', seat: 1, name: 'Alice', chips: 980, bet: 20,
          invested: 20, status: 'active', isDealer: false, isCurrentActor: false,
        },
        {
          userId: 'user-bob', seat: 2, name: 'Bob', chips: 980, bet: 20,
          invested: 20, status: 'active', isDealer: false, isCurrentActor: false,
        },
      ],
    });
    const next: PlayerView = {
      ...prev,
      boardCards: ['As', '7c', '2d'],
      phase: 'FLOP',
      pot: 60,
      players: prev.players.map((p) => ({ ...p })),
    };
    // Bob folded between prev and next
    next.players[2] = { ...next.players[2], status: 'folded' };
    const events = diffStates(prev, next);
    expect(events).toContain('**[Hand #1]** Bob folded');
    expect(events).toContain('**[Hand #1]** Flop: A\u2660 7\u2663 2\u2666 | Pot: 60');
  });

  it('handles prev with undefined prev (first state)', () => {
    const next = make3PlayerView({ handNumber: 1, yourCards: ['Ac', 'Kc'] });
    const events = diffStates(undefined, next);
    expect(events).toEqual(['**[Hand #1]** Your cards: A\u2663 K\u2663 \u00b7 Stack: 970']);
  });

  it('all-in takes priority over bet/raise/call reporting', () => {
    const prev = make3PlayerView();
    const next: PlayerView = {
      ...make3PlayerView(),
      players: make3PlayerView().players.map((p) => ({ ...p })),
    };
    next.players[2] = {
      ...next.players[2],
      name: 'Bob',
      chips: 0,
      bet: 1000,
      invested: 1000,
      status: 'all_in',
      isCurrentActor: false,
    };
    const events = diffStates(prev, next);
    const allInEvents = events.filter((e) => e.includes('all-in'));
    const betEvents = events.filter(
      (e) => e.includes(' bet ') || e.includes('raised') || e.includes('called'),
    );
    expect(allInEvents).toHaveLength(1);
    expect(betEvents).toHaveLength(0);
  });

  it('all-in with lastAction still reports all-in (status takes priority)', () => {
    const prev = make3PlayerView();
    const next: PlayerView = {
      ...make3PlayerView(),
      players: make3PlayerView().players.map((p) => ({ ...p })),
    };
    next.players[2] = {
      ...next.players[2],
      name: 'Bob',
      chips: 0,
      bet: 20,
      invested: 20,
      status: 'all_in',
      isCurrentActor: false,
      lastAction: { type: 'call', amount: 20 },
    };
    const events = diffStates(prev, next);
    const allInEvents = events.filter((e) => e.includes('all-in'));
    const callEvents = events.filter((e) => e.includes('called'));
    expect(allInEvents).toHaveLength(1);
    expect(callEvents).toHaveLength(0);
  });

  it('falls back to "called" when lastAction is undefined and bet increased', () => {
    const prev = make3PlayerView();
    const next: PlayerView = {
      ...make3PlayerView(),
      pot: 50,
      players: make3PlayerView().players.map((p) => ({ ...p })),
    };
    next.players[2] = {
      ...next.players[2],
      name: 'Bob',
      chips: 980,
      bet: 20,
      invested: 20,
      isCurrentActor: false,
    };
    next.currentPlayerToAct = 0;
    const events = diffStates(prev, next);
    expect(events.some((e) => e.includes('Bob called 20'))).toBe(true);
  });
});
