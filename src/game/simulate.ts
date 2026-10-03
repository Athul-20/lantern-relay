import { COLOR_MASK, type Level } from './levels.ts';

export type BeamSegment = { x1: number; y1: number; x2: number; y2: number; mask: number };
export type Simulation = { segments: BeamSegment[]; lanternMasks: Map<string, number>; mixedCells: string[]; solved: boolean };
type Cell = { x: number; y: number };
type BeamPath = { color: number; cells: Cell[] };
const key = (x: number, y: number) => `${x},${y}`;
const mod4 = (n: number) => ((n % 4 + 4) % 4);

/** Pure beam rules shared by solo practice and the future room server. */
export function simulate(level: Level, slashByIndex: boolean[]): Simulation {
  const paths: BeamPath[] = [];
  const cellColors = new Map<string, number>();
  const lanternMasks = new Map<string, number>();
  const mirrorAt = new Map(level.mirrors.map((m, i) => [key(m.x, m.y), { ...m, slash: slashByIndex[i] ?? m.slash }]));
  const wallSet = new Set(level.walls.map(w => key(w.x, w.y)));
  const splitterSet = new Set(level.splitters.map(w => key(w.x, w.y)));
  const dx = [1, 0, -1, 0], dy = [0, 1, 0, -1];
  const maxSteps = level.width * level.height * 4;

  const trace = (x: number, y: number, direction: number, color: number, visited: Set<string>, cells: Cell[]) => {
    let d = direction, cx = x, cy = y, route = cells;
    for (let step = 0; step < maxSteps; step++) {
      cx += dx[d]; cy += dy[d];
      const cell = key(cx, cy), state = `${cell}|${d}`;
      if (cx < 0 || cy < 0 || cx >= level.width || cy >= level.height || wallSet.has(cell) || visited.has(state)) break;
      visited.add(state);
      route = [...route, { x: cx, y: cy }];
      cellColors.set(cell, (cellColors.get(cell) ?? 0) | color);
      const mirror = mirrorAt.get(cell);
      if (mirror) {
        d = mirror.slash ? mod4(3 - d) : mod4(1 - d);
        continue;
      }
      if (splitterSet.has(cell)) {
        paths.push({ color, cells: route });
        trace(cx, cy, mod4(d + 1), color, new Set(visited), [{ x: cx, y: cy }]);
        trace(cx, cy, mod4(d + 3), color, new Set(visited), [{ x: cx, y: cy }]);
        return;
      }
    }
    if (route.length > 1) paths.push({ color, cells: route });
  };

  for (const source of level.sources) {
    const color = COLOR_MASK[source.color];
    cellColors.set(key(source.x, source.y), (cellColors.get(key(source.x, source.y)) ?? 0) | color);
    trace(source.x, source.y, source.direction, color, new Set(), [{ x: source.x, y: source.y }]);
  }

  const segments: BeamSegment[] = [];
  for (const path of paths) {
    let carriedColor = path.color;
    for (let i = 0; i < path.cells.length; i++) {
      const cell = path.cells[i], cellKey = key(cell.x, cell.y);
      carriedColor |= cellColors.get(cellKey) ?? 0;
      const lantern = level.lanterns.find(l => l.x === cell.x && l.y === cell.y);
      if (lantern) lanternMasks.set(cellKey, (lanternMasks.get(cellKey) ?? 0) | carriedColor);
      if (i === path.cells.length - 1) continue;
      const next = path.cells[i + 1];
      segments.push({ x1: cell.x, y1: cell.y, x2: next.x, y2: next.y, mask: carriedColor });
    }
  }
  return {
    segments, lanternMasks, mixedCells: [...cellColors].filter(([, mask]) => mask === 3).map(([cell]) => cell),
    solved: level.lanterns.every(l => (lanternMasks.get(key(l.x, l.y)) ?? 0) === l.target)
  };
}
