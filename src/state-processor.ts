/**
 * Pure state processing — analyzes PlayerView changes and emits ListenerOutputs.
 *
 * Extracted to its own module to avoid circular imports between
 * game-session.ts and clawplay-listener.ts.
 */

import { diffStates } from './state-differ.js';
import { buildSummary } from './prompts.js';
import type {
  PlayerView,
  ListenerContext,
  ListenerOutput,
  GameTransition,
} from './types.js';

const ACTIVE_PHASES = new Set(['PREFLOP', 'FLOP', 'TURN', 'RIVER']);

export function processStateEvent(
  view: PlayerView,
  context: ListenerContext,
  transitions: GameTransition[] = [],
): ListenerOutput[] {
  const outputs: ListenerOutput[] = [];

  // ── Detect fast hand transition (hand N → N+1 without SHOWDOWN) ──
  const handChanged = context.prevState != null
    && context.prevState.handNumber !== view.handNumber;

  if (handChanged) {
    const prevHandNum = context.prevState!.handNumber;
    if (prevHandNum > (context.lastReportedHand || 0)) {
      // ── Detect folds from atomic hand transition ──
      const prevPhase = context.prevState!.phase;
      if (ACTIVE_PHASES.has(prevPhase)) {
        const prevHdr = `**[Hand #${prevHandNum}]**`;
        const winners = new Set(view.lastHandResult?.winners || []);
        for (const p of context.prevState!.players || []) {
          if (p.seat === context.prevState!.yourSeat) continue;
          if (p.status === 'active' && !winners.has(p.seat)) {
            outputs.push({ type: 'EVENT', message: `${prevHdr} ${p.name} folded`, handNumber: prevHandNum });
          }
        }
      }

      // If we busted and can rebuy, emit REBUY_AVAILABLE instead of HAND_RESULT
      if (view.yourChips === 0 && view.canRebuy) {
        outputs.push({ type: 'REBUY_AVAILABLE', state: view, handNumber: prevHandNum });
      } else {
        outputs.push({ type: 'HAND_RESULT', state: view, handNumber: prevHandNum });
      }
      context.lastReportedHand = prevHandNum;
    }
  }

  const prevPlayerCount = context.prevState?.players?.length ?? 0;
  const prevPlayers = context.prevState?.players ?? [];

  const newEvents = diffStates(context.prevState, view);
  for (const message of newEvents) {
    outputs.push({ type: 'EVENT', message, handNumber: view.handNumber });
  }

  const prevPhase = context.prevPhase;

  context.prevState = view;
  context.prevPhase = view.phase;

  if (view.phase !== prevPhase) {
    context.lastActionType = null;
    context.lastTurnKey = null;
  }

  if (view.isYourTurn) {
    const turnKey = `${view.handNumber}:${view.phase}`;
    if (turnKey !== context.lastTurnKey) {
      context.lastTurnKey = turnKey;
      outputs.push({ type: 'YOUR_TURN', state: view, summary: buildSummary(view) });
      context.lastActionType = 'YOUR_TURN';
    }
    return outputs;
  }

  // Reset turnKey when it's not our turn, so re-entry in the same phase
  // (e.g., check → opponent bets → back to us) triggers a fresh decision.
  context.lastTurnKey = null;

  // Phase-based hand end — only if hand did NOT change (avoid double)
  if (!handChanged) {
    const handJustEnded =
      ACTIVE_PHASES.has(prevPhase!) &&
      (view.phase === 'SHOWDOWN' || view.phase === 'WAITING');

    if (handJustEnded) {
      const handNum = view.handNumber;
      if (handNum > (context.lastReportedHand || 0)) {
        // Showdown drama detection (before HAND_RESULT, since this block returns early)
        if (view.phase === 'SHOWDOWN') {
          const bb = view.forcedBets?.bigBlind || 20;
          const maxPlayers = view.numSeats || 6;
          const bigPotThreshold = bb * maxPlayers * 2;
          if (view.pot >= bigPotThreshold && view.lastHandResult?.showdownHands && view.lastHandResult.showdownHands.length >= 2) {
            const result = view.lastHandResult;
            const winnerSeats = new Set(result.winners || []);
            const winnerNames = result.players?.filter(p => winnerSeats.has(p.seat)).map(p => p.name).join(', ') || 'Unknown';
            const winnerHand = result.showdownHands?.find(h => winnerSeats.has(h.seat));
            const loserHand = result.showdownHands?.find(h => !winnerSeats.has(h.seat));
            let desc = `Showdown: ${winnerNames} wins ${view.pot} chip pot`;
            if (winnerHand?.handRanking) desc += ` with ${winnerHand.handRanking}`;
            if (loserHand) desc += ` over ${result.players?.find(p => p.seat === loserHand.seat)?.name}'s ${loserHand.handRanking || 'hand'}`;
            outputs.push({ type: 'DRAMA_MOMENT', state: view, description: desc, handNumber: handNum });
          }
        }

        // Bust-out drama detection (before HAND_RESULT)
        if (prevPlayers.length > 0) {
          for (const p of view.players || []) {
            if (p.seat === view.yourSeat) continue;
            if (p.chips !== 0) continue;
            const prev = prevPlayers.find(pp => pp.seat === p.seat);
            if (prev && (prev.chips ?? 0) > 0) {
              outputs.push({
                type: 'DRAMA_MOMENT',
                state: view,
                description: `${p.name} busted out!`,
                handNumber: handNum,
              });
            }
          }
        }

        if (view.yourChips === 0 && view.canRebuy) {
          outputs.push({ type: 'REBUY_AVAILABLE', state: view, handNumber: handNum });
          context.lastActionType = 'REBUY_AVAILABLE';
        } else {
          outputs.push({ type: 'HAND_RESULT', state: view, handNumber: handNum });
          context.lastActionType = 'HAND_RESULT';
        }
        context.lastReportedHand = handNum;
      }
      return outputs;
    }
  }

  if (view.phase === 'WAITING' && view.players && view.players.length < 2 && prevPlayerCount >= 2) {
    if (context.lastActionType !== 'WAITING_FOR_PLAYERS') {
      outputs.push({ type: 'WAITING_FOR_PLAYERS', state: view });
      context.lastActionType = 'WAITING_FOR_PLAYERS';
    }
    return outputs;
  }

  // ── Drama detection (for reactive chat) — mid-hand triggers ──
  const bb = view.forcedBets?.bigBlind || 20;
  const maxPlayers = view.numSeats || 6;

  // 1. Significant all-in by another player (≥50% of pot)
  for (const t of transitions) {
    if (t.type !== 'player-action') continue;
    const action = t as { type: 'player-action'; seat?: number; action?: string; amount?: number; playerName?: string };
    if (action.action !== 'all_in') continue;
    if (action.seat === view.yourSeat) continue; // don't react to own plays
    const amount = action.amount ?? 0;
    if (view.pot > 0 && amount >= view.pot * 0.5) {
      outputs.push({
        type: 'DRAMA_MOMENT',
        state: view,
        description: `${action.playerName} goes all-in for ${amount} into a ${view.pot} pot`,
        handNumber: view.handNumber,
      });
    }
  }

  // 2. Bust-out — another player's chips drop to 0 (mid-hand, not at hand end)
  if (prevPlayers.length > 0) {
    for (const p of view.players || []) {
      if (p.seat === view.yourSeat) continue;
      if (p.chips !== 0) continue;
      const prev = prevPlayers.find(pp => pp.seat === p.seat);
      if (prev && (prev.chips ?? 0) > 0) {
        outputs.push({
          type: 'DRAMA_MOMENT',
          state: view,
          description: `${p.name} busted out!`,
          handNumber: view.handNumber,
        });
      }
    }
  }

  return outputs;
}
