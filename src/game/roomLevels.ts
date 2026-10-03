import { COLOR_MASK, levels, PLAYER_COLORS, type Color, type Level, type Source } from './levels.ts';

export type RoomPlayerColor = { color: Color; seat: number };

function genericRoomLevel(levelIndex: number, players: RoomPlayerColor[]): Level {
  const last = levelIndex === levels.length - 1;
  if (!last || !players.some(p => p.color === 'red') || !players.some(p => p.color === 'blue')) {
    const sources: Source[] = players.map(({ color, seat }) => ({ x: 0, y: seat + 1, direction: 0, color }));
    const mirrors = players.map(({ seat }) => ({ x: seat + 1, y: seat + 1, slash: false, ownerSeat: seat }));
    const lanterns = players.map(({ color, seat }) => ({ x: seat + 1, y: 0, target: COLOR_MASK[color], name: `${color[0].toUpperCase()}${color.slice(1)} light` }));
    return { name: levels[levelIndex].name, subtitle: levels[levelIndex].subtitle, width: 9, height: Math.max(8, ...players.map(p => p.seat + 2)), sources, mirrors, walls: [], splitters: [], lanterns, hint: 'Each color has its own mirror. Turn yours upward to bring your lantern home.' };
  }

  const lastExtraSeat = Math.max(2, ...players.filter(p => p.seat > 1).map(p => p.seat));
  const width = 12 + lastExtraSeat;
  const height = 9;
  const sources: Source[] = [];
  const mirrors: Level['mirrors'] = [];
  const lanterns: Level['lanterns'] = [];
  for (const player of players) {
    if (player.color === 'red') {
      sources.push({ x: 0, y: 2, direction: 0, color: 'red' });
      mirrors.push({ x: 2, y: 2, slash: true, ownerSeat: player.seat });
      mirrors.push({ x: 2, y: 4, slash: true, ownerSeat: player.seat });
    } else if (player.color === 'blue') {
      sources.push({ x: 6, y: 0, direction: 1, color: 'blue' });
      mirrors.push({ x: 6, y: 2, slash: false, ownerSeat: player.seat });
      mirrors.push({ x: 4, y: 2, slash: false, ownerSeat: player.seat });
    } else {
      const offset = player.seat - 2;
      sources.push({ x: 13 + offset, y: player.seat + 1, direction: 2, color: player.color });
      mirrors.push({ x: 12 + offset, y: player.seat + 1, slash: false, ownerSeat: player.seat });
      lanterns.push({ x: 12 + offset, y: height - 1, target: COLOR_MASK[player.color], name: `${player.color[0].toUpperCase()}${player.color.slice(1)} light` });
    }
  }
  lanterns.unshift({ x: 4, y: 4, target: COLOR_MASK.red | COLOR_MASK.blue, name: 'Heartlight' });
  return { name: levels[levelIndex].name, subtitle: levels[levelIndex].subtitle, width, height, sources, mirrors, walls: [{ x: 5, y: 4 }], splitters: [], lanterns, hint: 'Red comes in from the left. Blue comes down from above. Meet at Heartlight.' };
}

/** Builds a room-specific board while keeping the two-player rooms on the authored five-level set. */
export function buildRoomLevel(levelIndex: number, players: RoomPlayerColor[]): Level {
  if (players.length !== 2 || !players.some(p => p.color === 'red') || !players.some(p => p.color === 'blue') || players[0].seat !== 0 || players[1].seat !== 1) {
    return genericRoomLevel(levelIndex, players);
  }
  const base = levels[levelIndex];
  const level: Level = {
    ...base,
    sources: base.sources.map(s => ({ ...s })),
    mirrors: base.mirrors.map((m, i) => ({ ...m, ownerSeat: levelIndex === 4 ? (i < 2 ? 0 : 1) : i % 2 })),
    walls: base.walls.map(w => ({ ...w })),
    splitters: base.splitters.map(s => ({ ...s })),
    lanterns: base.lanterns.map(l => ({ ...l }))
  };
  if (!level.sources.some(s => s.color === 'blue')) {
    const x = level.width - 3, y = level.height - 2;
    level.sources.push({ x: level.width - 1, y, direction: 2, color: 'blue' });
    level.mirrors.push({ x, y, slash: false, ownerSeat: 1 });
    level.lanterns.push({ x, y: level.height - 1, target: COLOR_MASK.blue, name: 'Bluebell' });
  }
  if (!level.mirrors.some(m => m.ownerSeat === 0)) level.mirrors[0].ownerSeat = 0;
  if (!level.mirrors.some(m => m.ownerSeat === 1)) level.mirrors[level.mirrors.length - 1].ownerSeat = 1;
  return level;
}

export const colorForSeat = (seat: number): Color => PLAYER_COLORS[seat];
