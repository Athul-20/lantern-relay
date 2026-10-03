export type Color = 'red' | 'blue' | 'yellow' | 'green' | 'white' | 'magenta';
export type Direction = 0 | 1 | 2 | 3;
export type Mirror = { x: number; y: number; slash: boolean; ownerSeat?: number };
export type Source = { x: number; y: number; direction: Direction; color: Color };
export type Lantern = { x: number; y: number; target: number; name: string };
export type Level = { name: string; subtitle: string; width: number; height: number; sources: Source[]; mirrors: Mirror[]; walls: { x: number; y: number }[]; splitters: { x: number; y: number }[]; lanterns: Lantern[]; hint: string; prompt?: string[] };

// Beam colors are bit flags, so crossings can carry a mixed color through the board.
export const PLAYER_COLORS: Color[] = ['red', 'blue', 'yellow', 'green', 'white', 'magenta'];
export const COLOR_MASK: Record<Color, number> = { red: 1, blue: 2, yellow: 4, green: 8, white: 16, magenta: 32 };
export const COLOR_HEX: Record<Color, string> = { red: '#ff536d', blue: '#68b8ff', yellow: '#ffd766', green: '#6be0aa', white: '#edf4ff', magenta: '#ff72d6' };
export const colorName = (mask: number) => mask === 3 ? 'VIOLET' : PLAYER_COLORS.find(c => COLOR_MASK[c] === mask)?.toUpperCase() ?? 'MIXED';
export const colorHex = (mask: number) => {
  if (mask === 3) return '#c17bff';
  const bits = PLAYER_COLORS.filter(c => (mask & COLOR_MASK[c]) !== 0);
  if (bits.length === 1) return COLOR_HEX[bits[0]];
  if (!bits.length) return '#9caac1';
  if (bits.includes('white')) return '#ffffff';
  const rgb = bits.reduce((sum, c) => {
    const value = COLOR_HEX[c].slice(1);
    return [0, 2, 4].map((i, index) => sum[index] + parseInt(value.slice(i, i + 2), 16));
  }, [0, 0, 0]).map(n => Math.min(255, n));
  return `#${rgb.map(n => n.toString(16).padStart(2, '0')).join('')}`;
};
export const levels: Level[] = [
  {
    name: 'First spark', subtitle: 'A little nudge in the right direction.', width: 7, height: 7,
    sources: [{ x: 0, y: 3, direction: 0, color: 'red' }], mirrors: [{ x: 3, y: 3, slash: false }], walls: [], splitters: [],
    lanterns: [{ x: 3, y: 0, target: 1, name: 'Hearth' }], hint: 'Tap the mirror once to turn its face. The red beam needs to go up.',
    prompt: ['Tap a mirror to turn it.', 'Guide red light into the lantern.', 'Lit every lantern to continue.']
  },
  {
    name: 'Two little suns', subtitle: 'Two colors, two paths to bring home.', width: 8, height: 7,
    sources: [{ x: 0, y: 2, direction: 0, color: 'red' }, { x: 7, y: 4, direction: 2, color: 'blue' }],
    mirrors: [{ x: 3, y: 2, slash: false }, { x: 4, y: 4, slash: false }], walls: [], splitters: [],
    lanterns: [{ x: 3, y: 0, target: 1, name: 'Ruby' }, { x: 4, y: 6, target: 2, name: 'Tide' }],
    hint: 'Turn the red path upward and the blue path downward.'
  },
  {
    name: 'A prism’s promise', subtitle: 'One beam can take the scenic route.', width: 8, height: 8,
    sources: [{ x: 0, y: 4, direction: 0, color: 'red' }], mirrors: [{ x: 3, y: 4, slash: false }],
    walls: [], splitters: [{ x: 3, y: 1 }],
    lanterns: [{ x: 1, y: 1, target: 1, name: 'North star' }, { x: 6, y: 1, target: 1, name: 'Wayfinder' }],
    hint: 'Turn the first mirror upward to send the red beam into the splitter. It branches left and right.',
    prompt: ['A splitter branches the beam.', 'One beam becomes two paths.']
  },
  {
    name: 'The long way home', subtitle: 'A wall is only a detour.', width: 9, height: 8,
    sources: [{ x: 0, y: 6, direction: 0, color: 'blue' }, { x: 8, y: 6, direction: 2, color: 'red' }],
    mirrors: [{ x: 3, y: 6, slash: true }, { x: 5, y: 6, slash: false }, { x: 5, y: 1, slash: true }],
    walls: [{ x: 4, y: 3 }, { x: 4, y: 4 }], splitters: [],
    lanterns: [{ x: 3, y: 1, target: 1, name: 'Afterglow' }, { x: 3, y: 7, target: 2, name: 'Bluebell' }],
    hint: 'Turn blue upward at the first mirror. Red needs two turns around the stone barrier.'
  },
  {
    name: 'Meet in the middle', subtitle: 'Some colors are made together.', width: 9, height: 8,
    sources: [{ x: 0, y: 3, direction: 0, color: 'red' }, { x: 8, y: 3, direction: 2, color: 'blue' }],
    mirrors: [{ x: 2, y: 3, slash: false }, { x: 2, y: 1, slash: false }, { x: 6, y: 3, slash: true }, { x: 6, y: 1, slash: true }],
    walls: [{ x: 4, y: 3 }], splitters: [],
    lanterns: [{ x: 4, y: 1, target: 3, name: 'Heartlight' }],
    hint: 'The center wall blocks direct shots. Red turns up then right; blue turns up then left. Meet at Heartlight.'
  }
];
