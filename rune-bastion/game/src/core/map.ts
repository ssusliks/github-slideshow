import type { MapDef } from './types';

export interface Pt { x: number; y: number }
export interface PathLine { pts: Pt[]; cum: number[]; len: number }
export interface GameMap {
  cols: number;
  rows: number;
  /** cell chars after mirroring, [row][col]. */
  cells: string[][];
  spawns: Pt[];
  castle: Pt;
  slots: Pt[];
  /** one ground path per spawn. */
  paths: PathLine[];
  /** straight flying line per spawn. */
  flyPaths: PathLine[];
}

function line(pts: Pt[]): PathLine {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, cum, len: cum[cum.length - 1] };
}

/** Position at `dist` along the path (clamped). */
export function pathPoint(p: PathLine, dist: number, out: Pt): Pt {
  if (dist <= 0) { out.x = p.pts[0].x; out.y = p.pts[0].y; return out; }
  if (dist >= p.len) { const l = p.pts[p.pts.length - 1]; out.x = l.x; out.y = l.y; return out; }
  let i = 1;
  while (p.cum[i] < dist) i++;
  const a = p.pts[i - 1], b = p.pts[i];
  const t = (dist - p.cum[i - 1]) / (p.cum[i] - p.cum[i - 1]);
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  return out;
}

/** Parses the ASCII layout, derives road routes with BFS and validates the result. */
export function parseMap(def: MapDef, mirror = false): GameMap {
  const cells = def.rows.map((r) => (mirror ? r.split('').reverse() : r.split('')));
  const rows = cells.length, cols = cells[0].length;
  const spawns: Pt[] = [], slots: Pt[] = [];
  let castle: Pt | null = null;
  for (let y = 0; y < rows; y++) {
    if (cells[y].length !== cols) throw new Error(`map ${def.id}: ragged row ${y}`);
    for (let x = 0; x < cols; x++) {
      const c = cells[y][x];
      if (c === 'S' || c === 'T') spawns.push({ x, y });
      else if (c === 'C') castle = { x, y };
      else if (c === 'o') slots.push({ x, y });
    }
  }
  if (!castle) throw new Error(`map ${def.id}: no castle`);
  if (!spawns.length) throw new Error(`map ${def.id}: no spawn`);
  // Mirroring flips scan order; keep spawn order stable (left to right) so path indices are deterministic.
  spawns.sort((a, b) => a.x - b.x || a.y - b.y);
  const walk = (c: string) => c === '#' || c === 'S' || c === 'T' || c === 'C';
  const paths = spawns.map((s) => {
    const prev = new Map<number, number>();
    const key = (x: number, y: number) => y * cols + x;
    const queue: Pt[] = [s];
    prev.set(key(s.x, s.y), -1);
    let found = false;
    while (queue.length) {
      const c = queue.shift()!;
      if (c.x === castle!.x && c.y === castle!.y) { found = true; break; }
      for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]]) {
        const nx = c.x + dx, ny = c.y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || !walk(cells[ny][nx]) || prev.has(key(nx, ny))) continue;
        prev.set(key(nx, ny), key(c.x, c.y));
        queue.push({ x: nx, y: ny });
      }
    }
    if (!found) throw new Error(`map ${def.id}: spawn ${s.x},${s.y} cannot reach the castle`);
    const pts: Pt[] = [];
    let k = key(castle!.x, castle!.y);
    while (k !== -1) { pts.push({ x: k % cols, y: Math.floor(k / cols) }); k = prev.get(k)!; }
    pts.reverse();
    // Enemies enter from just outside the board.
    const d0 = { x: pts[0].x - (pts[1].x - pts[0].x) * 0.8, y: pts[0].y - (pts[1].y - pts[0].y) * 0.8 };
    return line([d0, ...pts]);
  });
  const flyPaths = spawns.map((s, i) => line([paths[i].pts[0], { x: s.x, y: s.y }, { x: castle!.x, y: castle!.y }]));
  return { cols, rows, cells, spawns, castle, slots, paths, flyPaths };
}
