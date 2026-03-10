// ── Enums / Union Types ──────────────────────────────────────────────

export type PlayerStatus = 'active' | 'folded' | 'all_in' | 'sitting_out' | 'eliminated';
export type GamePhase = 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN' | 'WAITING';
export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in';

// ── API Response Types ───────────────────────────────────────────────

export interface AvailableAction {
  type: string;
  amount?: number;
  minAmount?: number;
  maxAmount?: number;
}

export interface PlayerInfo {
  userId: string;
  seat: number;
  name: string;
  chips: number;
  bet: number;
  invested: number;
  status: string;
  isDealer: boolean;
  isCurrentActor: boolean;
  lastAction?: { type: string; amount?: number };
  timeoutStrikes?: number;
}

export interface ForcedBets {
  smallBlind: number;
  bigBlind: number;
  ante: number;
}

export interface SidePot {
  size: number;
  eligiblePlayers: number[];
}

export interface HandResult {
  winners: number[];
  potResults: { winners: number[]; amount: number }[];
  players: { userId: string; seat: number; name: string; chips: number }[];
  showdownHands?: { seat: number; holeCards: string[]; handRanking?: string }[];
}

export interface PlayerView {
  gameId: string;
  handNumber: number;
  phase: string;
  pot: number;
  boardCards: string[];
  yourSeat: number;
  yourCards: string[];
  yourChips: number;
  yourBet: number;
  isYourTurn: boolean;
  availableActions: AvailableAction[];
  players: PlayerInfo[];
  dealerSeat: number;
  numSeats: number;
  forcedBets: ForcedBets;
  sidePots: SidePot[];
  currentPlayerToAct: number | null;
  winners?: number[];
  lastHandResult?: HandResult;
  timeoutAt: number | null;
  canRebuy?: boolean;
  rebuyAmount?: number;
  hasPendingLeave?: boolean;
  recentHands?: {
    handNumber: number;
    boardCards: string[];
    result: {
      winners: { name: string; seat: number }[];
      potSize: number;
      showdownHands?: { name: string; holeCards: string[]; handRanking?: string }[];
    };
    yourOutcome?: {
      action: 'won' | 'lost' | 'folded';
      phase?: string;
      invested?: number;
      won?: number;
      holeCards?: string[];
      handRanking?: string;
    };
  }[];
  playerStats?: Record<string, {
    vpip: number;
    pfr: number;
    threeBet: number;
    af: number;
    foldToRaise: number;
    handsPlayed: number;
  }>;
}

// ── Decision Types ───────────────────────────────────────────────────

export interface DecisionResponse {
  action: string;
  amount?: number;
  narration?: string;
}

// ── Listener Types ───────────────────────────────────────────────────

export interface ListenerContext {
  prevState: PlayerView | null;
  prevPhase: string | null;
  lastActionType: string | null;
  lastReportedHand: number;
  lastTurnKey: string | null;
}

export type ListenerOutput =
  | { type: 'EVENT'; message: string; handNumber: number }
  | { type: 'YOUR_TURN'; state: PlayerView; summary: string }
  | { type: 'HAND_RESULT'; state: PlayerView; handNumber: number }
  | { type: 'REBUY_AVAILABLE'; state: PlayerView; handNumber: number }
  | { type: 'WAITING_FOR_PLAYERS'; state: PlayerView };

// ── Lobby SSE Event Types ───────────────────────────────────────────

export interface LobbyInviteEvent {
  inviteId: string;
  inviterName: string;
  tableId: string;
  gameMode: string;
  expiresAt: string;
}

export interface LobbyFollowEvent {
  followerId: string;
  followerName: string;
}

// ── SSE Transition Types ────────────────────────────────────────────

export interface GameTransition {
  type: string;
  seat?: number;
  playerName?: string;
  [key: string]: unknown;
}
