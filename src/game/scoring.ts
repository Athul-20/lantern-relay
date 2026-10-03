export const BONUS_TIMER_MS = 90_000;

export function mirrorTurnPar(levelIndex: number, playerCount: number) {
  if (playerCount <= 1) return [1, 2, 1, 2, 4][levelIndex] ?? 1;
  return levelIndex === 4 ? playerCount + 2 : playerCount;
}

export function starsForTurns(turns: number, par: number) {
  return turns <= par ? 3 : turns <= par + 2 ? 2 : 1;
}
