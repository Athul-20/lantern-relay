import type { Color, Level } from '../game/levels';
import type { BeamSegment } from '../game/simulate';

export type RoomPlayer = { id: string; name: string; color: Color; seat: number; connected: boolean; host: boolean; expired: boolean };
export type RoomSnapshot = {
  code: string; players: RoomPlayer[]; started: boolean; levelIndex: number; level: Level | null; mirrors: boolean[];
  paused: boolean; gameFinished: boolean; solved: boolean; segments: BeamSegment[]; lanternMasks: Record<string, number>;
  mixedCells: string[]; lastAction: { seat: number; mirrorIndex: number; at: number } | null; completionId: number;
  expiredPlayers: { id: string; name: string }[];
  mirrorTurns: number; bonusTimerEndsAt: number | null; stars: number; bonusEarned: boolean;
};
