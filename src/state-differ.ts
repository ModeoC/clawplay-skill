import { formatCard, formatCards } from './card-format.js';
import type { PlayerView, PlayerInfo } from './types.js';

/**
 * Compare two successive PlayerView states and return an array of
 * human-readable event strings describing what changed.
 */
export function diffStates(prev: PlayerView | null | undefined, next: PlayerView): string[] {
  const events: string[] = [];
  const hdr = `**[Hand #${next.handNumber}]**`;

  // ── 1. New hand (prev is null/undefined, or handNumber changed) ──
  if (!prev || prev.handNumber !== next.handNumber) {
    if (next.yourCards && next.yourCards.length > 0) {
      const cards = formatCards(next.yourCards);
      const me = next.players?.find((p: PlayerInfo) => p.seat === next.yourSeat);
      const stack = me?.chips ?? next.yourChips;
      events.push(`${hdr} Your cards: ${cards} · Stack: ${stack}`);
    }
    return events;
  }

  // ── Player action diffs (opponents only) ──
  const prevPlayerMap = new Map<number, PlayerInfo>(prev.players.map((p) => [p.seat, p]));

  for (const nextPlayer of next.players) {
    // Skip our own seat
    if (nextPlayer.seat === next.yourSeat) continue;

    const prevPlayer = prevPlayerMap.get(nextPlayer.seat);
    if (!prevPlayer) {
      // New player joined
      events.push(`${hdr} ${nextPlayer.name} joined the table (${nextPlayer.chips} chips)`);
      continue;
    }

    // 10. All-in (status changed to all_in) — takes priority over bet/raise/call
    if (prevPlayer.status !== 'all_in' && nextPlayer.status === 'all_in') {
      events.push(`${hdr} ${nextPlayer.name} went all-in (${nextPlayer.invested} invested · ${nextPlayer.chips} behind)`);
      continue;
    }

    // 5. Folded (status changed to folded)
    if (prevPlayer.status !== 'folded' && nextPlayer.status === 'folded') {
      events.push(`${hdr} ${nextPlayer.name} folded`);
      continue;
    }

    // Bet changed — classify using lastAction.type from backend
    if (nextPlayer.bet > prevPlayer.bet) {
      const betAmount = nextPlayer.bet;
      const chipInfo = ` (${nextPlayer.invested} invested · ${nextPlayer.chips} behind)`;
      const actionType = nextPlayer.lastAction?.type;

      if (actionType === 'raise') {
        events.push(`${hdr} ${nextPlayer.name} raised to ${betAmount}${chipInfo}`);
      } else if (actionType === 'bet') {
        events.push(`${hdr} ${nextPlayer.name} bet ${betAmount}${chipInfo}`);
      } else {
        events.push(`${hdr} ${nextPlayer.name} called ${betAmount}${chipInfo}`);
      }
      continue;
    }

    // 9. Checked (was current actor, no longer is, lastAction is check)
    if (
      prevPlayer.isCurrentActor &&
      !nextPlayer.isCurrentActor &&
      nextPlayer.lastAction?.type === 'check'
    ) {
      events.push(`${hdr} ${nextPlayer.name} checked`);
      continue;
    }
  }

  // ── Player left diffs ──
  const nextPlayerSeats = new Set(next.players.map((p) => p.seat));
  for (const prevPlayer of prev.players) {
    if (prevPlayer.seat === next.yourSeat) continue;
    if (!nextPlayerSeats.has(prevPlayer.seat)) {
      events.push(`${hdr} ${prevPlayer.name} left the table`);
    }
  }

  // ── Board card diffs ──
  const prevBoardLen = prev.boardCards.length;
  const nextBoardLen = next.boardCards.length;

  // 2. Flop dealt (0 -> 3)
  if (prevBoardLen === 0 && nextBoardLen >= 3) {
    const flopCards = formatCards(next.boardCards.slice(0, 3));
    events.push(`${hdr} Flop: ${flopCards} | Pot: ${next.pot}`);
  }

  // 3. Turn dealt (3 -> 4)
  if (prevBoardLen <= 3 && nextBoardLen >= 4 && prevBoardLen < nextBoardLen) {
    // Only report if we hadn't already reported it as part of flop
    if (prevBoardLen === 3) {
      const turnCard = formatCard(next.boardCards[3]);
      const board = formatCards(next.boardCards.slice(0, 4));
      events.push(`${hdr} Turn: ${turnCard} → ${board} | Pot: ${next.pot}`);
    }
  }

  // 4. River dealt (4 -> 5)
  if (prevBoardLen <= 4 && nextBoardLen >= 5 && prevBoardLen < nextBoardLen) {
    if (prevBoardLen === 4) {
      const riverCard = formatCard(next.boardCards[4]);
      const board = formatCards(next.boardCards);
      events.push(`${hdr} River: ${riverCard} → ${board} | Pot: ${next.pot}`);
    }
  }

  return events;
}
