import * as THREE from 'three';
import type { EnemyDef, TowerDef, WorldDef } from '../core/types';

/**
 * Procedural low-poly models. Everything is built from a handful of shared primitive
 * geometries and cached flat-shaded materials, so the whole game ships without art assets
 * and stays cheap for mobile GPUs (few draw calls, no textures).
 */

const geoCache = new Map<string, THREE.BufferGeometry>();
const matCache = new Map<string, THREE.Material>();

function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) { g = make(); geoCache.set(key, g); }
  return g;
}

export function mat(color: number, opts: { emissive?: number; opacity?: number; basic?: boolean } = {}): THREE.Material {
  const key = `${color}:${opts.emissive ?? 0}:${opts.opacity ?? 1}:${opts.basic ? 1 : 0}`;
  let m = matCache.get(key);
  if (!m) {
    m = opts.basic
      ? new THREE.MeshBasicMaterial({ color, transparent: (opts.opacity ?? 1) < 1, opacity: opts.opacity ?? 1, depthWrite: (opts.opacity ?? 1) >= 1 })
      : new THREE.MeshLambertMaterial({ color, flatShading: true, emissive: opts.emissive ?? 0, emissiveIntensity: opts.emissive ? 0.75 : 0, transparent: (opts.opacity ?? 1) < 1, opacity: opts.opacity ?? 1 });
    matCache.set(key, m);
  }
  return m;
}

type M = THREE.Material;
const mesh = (g: THREE.BufferGeometry, m: M) => new THREE.Mesh(g, m);

export function cyl(rTop: number, rBot: number, h: number, m: M, y = 0, seg = 8): THREE.Mesh {
  const o = mesh(geo(`cyl${seg}`, () => new THREE.CylinderGeometry(1, 1, 1, seg)), m);
  // Unit cylinder scaled; a taper is baked by a dedicated geometry when radii differ.
  if (Math.abs(rTop - rBot) > 1e-3) {
    const k = `cyl${seg}:${(rTop / rBot).toFixed(2)}`;
    o.geometry = geo(k, () => new THREE.CylinderGeometry(rTop / rBot, 1, 1, seg));
  }
  o.scale.set(rBot, h, rBot);
  o.position.y = y + h / 2;
  return o;
}
export function box(w: number, h: number, d: number, m: M, y = 0): THREE.Mesh {
  const o = mesh(geo('box', () => new THREE.BoxGeometry(1, 1, 1)), m);
  o.scale.set(w, h, d);
  o.position.y = y + h / 2;
  return o;
}
export function cone(r: number, h: number, m: M, y = 0, seg = 8): THREE.Mesh {
  const o = mesh(geo(`cone${seg}`, () => new THREE.ConeGeometry(1, 1, seg)), m);
  o.scale.set(r, h, r);
  o.position.y = y + h / 2;
  return o;
}
export function sph(r: number, m: M, y = 0): THREE.Mesh {
  const o = mesh(geo('sph', () => new THREE.IcosahedronGeometry(1, 1)), m);
  o.scale.setScalar(r);
  o.position.y = y;
  return o;
}
export function octa(r: number, h: number, m: M, y = 0): THREE.Mesh {
  const o = mesh(geo('octa', () => new THREE.OctahedronGeometry(1, 0)), m);
  o.scale.set(r, h, r);
  o.position.y = y;
  return o;
}
export function torus(R: number, r: number, m: M, y = 0): THREE.Mesh {
  const o = mesh(geo(`tor${(r / R).toFixed(2)}`, () => new THREE.TorusGeometry(1, r / R, 6, 16)), m);
  o.scale.setScalar(R);
  o.rotation.x = Math.PI / 2;
  o.position.y = y;
  return o;
}
function at<T extends THREE.Object3D>(o: T, x: number, y: number | null, z: number): T {
  o.position.x = x; o.position.z = z;
  if (y !== null) o.position.y = y;
  return o;
}

const STONE = 0xb9b4a8, STONE_D = 0x8d8a82, WOOD = 0x8d6e4b, WOOD_D = 0x6b5038, GOLD = 0xf2c94c, DARK = 0x2f3136;

export interface TowerModel {
  group: THREE.Group;
  /** parts animated every frame. */
  spin: THREE.Object3D[];
  bob: THREE.Object3D[];
  flicker: THREE.Object3D[];
  /** part that recoils / aims when the tower fires. */
  head: THREE.Object3D | null;
  muzzleY: number;
}

/** Builds the model of a tower for a given tier/branch. Higher tiers grow, gain trims, glow and a halo. */
export function buildTower(def: TowerDef, tier: number, branch: string | null): TowerModel {
  const g = new THREE.Group();
  const m: TowerModel = { group: g, spin: [], bob: [], flicker: [], head: null, muzzleY: 0.9 };
  const c = def.look.color, a = def.look.accent;
  const C = mat(c), A = mat(a), AG = mat(a, { emissive: a });
  const kind = def.look.kind;
  const evolved = tier >= 3;
  const br = evolved ? branch : null;

  // Shared pedestal; its trim tells the tier at a glance.
  g.add(cyl(0.38, 0.42, 0.14, mat(STONE_D)));
  g.add(cyl(0.34, 0.36, 0.08, mat(tier >= 4 ? GOLD : tier >= 2 ? 0xd9d2c0 : STONE), 0.14));
  const y0 = 0.22;

  const addFlame = (y: number, r: number, col: number, col2: number) => {
    const f1 = octa(r, r * 1.7, mat(col, { emissive: col }), y + r * 1.2);
    const f2 = octa(r * 0.55, r * 1.1, mat(col2, { emissive: col2 }), y + r * 1.1);
    g.add(f1, f2);
    m.flicker.push(f1, f2);
  };
  const addCrystal = (x: number, y: number, z: number, r: number, h: number, col: number, tilt = 0) => {
    const o = at(octa(r, h, mat(col, { emissive: col, opacity: 0.92 }), y), x, null, z);
    o.rotation.z = tilt;
    g.add(o);
    return o;
  };
  const addBow = (y: number, w: number, col: number, rotY = 0) => {
    const h = new THREE.Group();
    const stock = box(0.07, 0.06, 0.5, mat(WOOD_D));
    const arc = box(w, 0.05, 0.06, mat(col));
    arc.position.z = 0.18;
    const tip = at(cone(0.05, 0.16, mat(0xdfe6ee)), 0, 0.03, 0.3);
    tip.rotation.x = Math.PI / 2;
    h.add(stock, arc, tip);
    h.position.y = y;
    h.rotation.y = rotY;
    g.add(h);
    return h;
  };
  const addBarrel = (y: number, r: number, len: number, col: number, pitch = -0.25) => {
    const h = new THREE.Group();
    const b = cyl(r * 0.85, r, len, mat(col), 0, 10);
    b.rotation.x = Math.PI / 2;
    b.position.set(0, 0, len / 2 - 0.08);
    const ring = torus(r * 1.02, 0.03, mat(GOLD));
    ring.rotation.x = 0;
    ring.position.set(0, 0, len - 0.1);
    h.add(b, ring);
    h.position.y = y;
    h.rotation.x = pitch;
    g.add(h);
    return h;
  };
  const addCoil = (y: number, h: number) => {
    g.add(cyl(0.07, 0.1, h, mat(0x8a8fa3), y));
    for (let i = 0; i < 3; i++) g.add(torus(0.17 - i * 0.03, 0.03, mat(0xc98a4b), y + 0.12 + i * (h - 0.2) / 2.2));
  };

  switch (kind) {
    case 'archer': case 'venom': {
      const wood = kind === 'venom' ? mat(0x4f5d3a) : mat(WOOD);
      const hgt = br === 'marksman' ? 0.75 : 0.55;
      g.add(cyl(0.2, 0.27, hgt, wood, y0, 6));
      g.add(cyl(0.3, 0.3, 0.07, mat(WOOD_D), y0 + hgt, 6));
      for (let i = 0; i < 4; i++) {
        const p = box(0.05, 0.16, 0.05, mat(WOOD_D), y0 + hgt + 0.07);
        const an = (i / 4) * Math.PI * 2 + Math.PI / 4;
        g.add(at(p, Math.cos(an) * 0.25, null, Math.sin(an) * 0.25));
      }
      g.add(at(cone(0.34, 0.26, A, y0 + hgt + 0.23, 6), 0, null, 0));
      const by = y0 + hgt + 0.14;
      if (br === 'volley') { addBow(by, 0.36, a, -0.5); addBow(by, 0.36, a, 0.5); m.head = addBow(by, 0.4, a); }
      else m.head = addBow(by, br === 'marksman' ? 0.56 : 0.42, kind === 'venom' ? 0xc9ff6b : a);
      if (br === 'marksman') g.add(at(box(0.02, 0.3, 0.02, mat(DARK), y0 + hgt + 0.45), 0, null, 0), at(box(0.16, 0.1, 0.02, mat(0xd9412f), y0 + hgt + 0.64), 0.08, null, 0));
      if (kind === 'venom') { const v = sph(0.09, mat(a, { emissive: a }), by + 0.02); v.position.z = -0.2; g.add(v); m.bob.push(v); }
      m.muzzleY = by;
      break;
    }
    case 'cannon': case 'meteor': case 'frostcannon': {
      const body = kind === 'meteor' ? mat(0x7a3b2e) : kind === 'frostcannon' ? mat(0x54708f) : C;
      g.add(cyl(0.28, 0.33, 0.3, body, y0, 8));
      g.add(cyl(0.31, 0.31, 0.06, mat(STONE_D), y0 + 0.3, 8));
      const by = y0 + 0.5;
      const bc = kind === 'meteor' ? 0x3a2420 : kind === 'frostcannon' ? 0x9fd8f5 : a;
      if (br === 'mortar') m.head = addBarrel(by - 0.04, 0.2, 0.34, bc, -0.95);
      else if (br === 'shrapnel') { const h1 = addBarrel(by, 0.09, 0.46, bc); h1.position.x = -0.13; const h2 = addBarrel(by, 0.09, 0.46, bc); h2.position.x = 0.13; m.head = addBarrel(by + 0.1, 0.09, 0.5, bc); }
      else m.head = addBarrel(by, 0.15, 0.5, bc);
      g.add(at(sph(0.17, body, by), 0, null, -0.02));
      if (kind === 'meteor') addFlame(by + 0.12, 0.1, 0xff7b2e, 0xffd23e);
      if (kind === 'frostcannon') { addCrystal(0.24, y0 + 0.42, -0.1, 0.07, 0.2, 0xbfeaff, 0.3); addCrystal(-0.24, y0 + 0.4, -0.1, 0.06, 0.17, 0xbfeaff, -0.3); }
      m.muzzleY = by + 0.1;
      break;
    }
    case 'fire': case 'frostfire': case 'plaguefire': {
      const stone = kind === 'plaguefire' ? mat(0x5d6b3a) : mat(0x6f5a52);
      g.add(cyl(0.16, 0.24, 0.42, stone, y0, 6));
      g.add(cyl(0.3, 0.18, 0.16, C, y0 + 0.42, 8));
      const fy = y0 + 0.52;
      const s = br === 'inferno' ? 0.24 : 0.18;
      if (kind === 'frostfire') { addFlame(fy, 0.17, 0xff7b2e, 0x7de3ff); addCrystal(0.2, fy + 0.1, 0, 0.06, 0.2, 0x7de3ff, -0.4); addCrystal(-0.2, fy + 0.1, 0, 0.06, 0.2, 0x7de3ff, 0.4); }
      else if (kind === 'plaguefire') { addFlame(fy, 0.17, 0x9be03c, 0xff8a3c); }
      else addFlame(fy, s, 0xff6a1f, 0xffd23e);
      if (br === 'inferno') g.add(torus(0.33, 0.04, mat(0xff6a1f, { emissive: 0xff6a1f }), y0 + 0.5));
      if (br === 'phoenix') for (const sx of [-1, 1]) { const w = at(box(0.3, 0.03, 0.2, mat(0xffb23e, { emissive: 0xff8a1f })), sx * 0.3, fy + 0.2, 0); w.rotation.z = sx * 0.6; g.add(w); m.bob.push(w); }
      m.muzzleY = fy + 0.25;
      break;
    }
    case 'ice': case 'stormglacier': {
      g.add(cyl(0.2, 0.28, 0.2, mat(0x9fb7c6), y0, 6));
      const main = addCrystal(0, y0 + 0.62, 0, br === 'glacier' ? 0.24 : 0.17, br === 'glacier' ? 0.55 : 0.46, c);
      m.bob.push(main);
      addCrystal(0.2, y0 + 0.35, 0.05, 0.08, 0.24, a, -0.35);
      addCrystal(-0.18, y0 + 0.33, -0.08, 0.07, 0.2, a, 0.4);
      if (br === 'blizzard' || kind === 'stormglacier') {
        const ring = new THREE.Group();
        for (let i = 0; i < 5; i++) { const an = (i / 5) * Math.PI * 2; ring.add(at(octa(0.05, 0.12, mat(kind === 'stormglacier' ? 0xf7e94a : a, { emissive: kind === 'stormglacier' ? 0xf7e94a : a }), 0), Math.cos(an) * 0.36, 0, Math.sin(an) * 0.36)); }
        ring.position.y = y0 + 0.7;
        g.add(ring);
        m.spin.push(ring);
      }
      m.muzzleY = y0 + 0.75;
      break;
    }
    case 'poison': {
      g.add(cyl(0.14, 0.2, 0.16, mat(0x4a4038), y0, 6));
      const pot = sph(0.27, mat(0x3a3d42), y0 + 0.36);
      pot.scale.y = 0.22;
      g.add(pot);
      g.add(cyl(0.25, 0.25, 0.04, AG, y0 + 0.46, 10));
      g.add(torus(0.26, 0.035, mat(0x55585e), y0 + 0.48));
      for (let i = 0; i < 3; i++) { const b = at(sph(0.05 + i * 0.012, AG, y0 + 0.56 + i * 0.08), (i - 1) * 0.1, null, (i % 2) * 0.08 - 0.04); g.add(b); m.bob.push(b); }
      if (br === 'plague') { const sk = sph(0.12, mat(0xe6e0cf), y0 + 0.8); g.add(sk); g.add(at(sph(0.03, mat(DARK), y0 + 0.82), -0.05, null, 0.1), at(sph(0.03, mat(DARK), y0 + 0.82), 0.05, null, 0.1)); m.bob.push(sk); }
      if (br === 'acid') for (const sx of [-1, 1]) g.add(at(cyl(0.05, 0.07, 0.2, mat(0xd6ff5c, { emissive: 0xb6f25c, opacity: 0.9 }), y0 + 0.2), sx * 0.3, null, 0.12));
      m.muzzleY = y0 + 0.6;
      break;
    }
    case 'storm': case 'runestorm': {
      addCoil(y0, 0.55);
      const top = sph(br === 'thunder' ? 0.19 : 0.14, mat(a, { emissive: a }), y0 + 0.68);
      g.add(top);
      m.flicker.push(top);
      if (br === 'tempest') for (let i = 0; i < 3; i++) { const an = (i / 3) * Math.PI * 2; const sp = at(sph(0.07, mat(a, { emissive: a }), y0 + 0.5), Math.cos(an) * 0.26, null, Math.sin(an) * 0.26); g.add(sp); m.flicker.push(sp); }
      if (br === 'thunder') for (let i = 0; i < 4; i++) { const an = (i / 4) * Math.PI * 2; const sp = at(cone(0.04, 0.2, mat(0xdfe6ee), y0 + 0.6), Math.cos(an) * 0.2, null, Math.sin(an) * 0.2); sp.rotation.z = -Math.cos(an) * 1.2; sp.rotation.x = Math.sin(an) * 1.2; g.add(sp); }
      if (kind === 'runestorm') { const r = torus(0.3, 0.025, mat(0xff7df2, { emissive: 0xff7df2 }), y0 + 0.68); g.add(r); m.spin.push(r); }
      m.muzzleY = y0 + 0.7;
      break;
    }
    case 'arcane': case 'solarprism': {
      const ob = cyl(0.1, 0.2, 0.5, kind === 'solarprism' ? mat(0xe9d9a0) : mat(0x5a3f8a), y0, 4);
      g.add(ob);
      const gem = br === 'void' ? sph(0.15, mat(0x1a1030, { emissive: 0x6a2fd0 }), y0 + 0.78) : octa(br === 'prism' ? 0.2 : 0.14, br === 'prism' ? 0.16 : 0.22, mat(a, { emissive: a, opacity: 0.95 }), y0 + 0.78);
      g.add(gem);
      m.bob.push(gem);
      m.spin.push(gem);
      const ring = torus(0.25, 0.02, mat(kind === 'solarprism' ? GOLD : c, { emissive: kind === 'solarprism' ? GOLD : c }), y0 + 0.78);
      g.add(ring);
      m.spin.push(ring);
      if (kind === 'solarprism') { const disc = cyl(0.2, 0.2, 0.03, mat(GOLD, { emissive: 0xffe08a }), y0 + 0.5, 12); disc.rotation.x = Math.PI / 2; disc.position.z = -0.12; g.add(disc); }
      m.muzzleY = y0 + 0.78;
      break;
    }
    case 'sun': {
      g.add(cyl(0.12, 0.2, 0.5, mat(0xd9c89a), y0, 6));
      const head = new THREE.Group();
      const disc = cyl(0.2, 0.2, 0.05, mat(c, { emissive: br === 'radiance' ? 0xffe08a : c }), -0.025, 12);
      head.add(disc);
      const rays = br === 'radiance' ? 12 : 8;
      for (let i = 0; i < rays; i++) { const an = (i / rays) * Math.PI * 2; const r = at(cone(0.04, 0.16, mat(a, { emissive: a }), -0.08), Math.cos(an) * 0.28, null, Math.sin(an) * 0.28); r.rotation.z = -Math.cos(an) * Math.PI / 2; r.rotation.x = Math.sin(an) * Math.PI / 2; head.add(r); }
      head.position.y = y0 + 0.75;
      head.rotation.x = Math.PI / 2.6;
      g.add(head);
      m.spin.push(disc);
      m.bob.push(head);
      if (br === 'dawn') { const halo = torus(0.42, 0.02, mat(0xfff6c2, { emissive: 0xfff6c2 }), y0 + 0.3); g.add(halo); m.spin.push(halo); }
      m.muzzleY = y0 + 0.75;
      break;
    }
    case 'steam': {
      g.add(cyl(0.26, 0.3, 0.42, mat(0x8a6a4a), y0, 8));
      g.add(torus(0.29, 0.03, mat(0xc98a4b), y0 + 0.14), torus(0.28, 0.03, mat(0xc98a4b), y0 + 0.32));
      g.add(cyl(0.2, 0.27, 0.12, mat(0xa7b7c4), y0 + 0.42, 8));
      for (const sx of [-1, 1]) g.add(at(cyl(0.05, 0.05, 0.3, mat(0xc98a4b), y0 + 0.4), sx * 0.2, null, 0.1));
      const puff = sph(0.12, mat(0xffffff, { opacity: 0.8 }), y0 + 0.72);
      g.add(puff);
      m.bob.push(puff);
      m.flicker.push(puff);
      m.muzzleY = y0 + 0.6;
      break;
    }
    default: {
      g.add(cyl(0.2, 0.26, 0.5, C, y0));
      g.add(sph(0.16, AG, y0 + 0.66));
    }
  }

  // Tier dressing: banner at 3+, glowing floor ring at 4+, spinning halo at 5.
  if (tier >= 3) {
    g.add(at(box(0.02, 0.5, 0.02, mat(DARK), 0.2), -0.33, null, -0.2));
    g.add(at(box(0.14, 0.1, 0.02, mat(a), 0.58), -0.25, null, -0.2));
  }
  if (tier >= 4) {
    const ring = torus(0.46, 0.025, mat(a, { emissive: a, basic: true }), 0.03);
    g.add(ring);
  }
  if (tier >= 5) {
    const halo = torus(0.3, 0.025, mat(GOLD, { emissive: GOLD, basic: true }), m.muzzleY + 0.36);
    g.add(halo);
    m.spin.push(halo);
    m.bob.push(halo);
  }
  // Tier pips on the pedestal rim.
  for (let i = 0; i < tier; i++) {
    const an = Math.PI * 0.5 + (i - (tier - 1) / 2) * 0.36;
    g.add(at(sph(0.04, mat(tier >= 4 ? 0xfff2a8 : 0xffffff, { basic: true }), 0.12), Math.cos(an) * 0.41, null, Math.sin(an) * 0.41));
  }
  g.scale.setScalar(1 + 0.07 * (tier - 1));
  return m;
}

export interface EnemyModel {
  group: THREE.Group;
  body: THREE.Object3D;
  legs: THREE.Object3D[];
  wings: THREE.Object3D[];
  height: number;
  shape: string;
}

function eyes(parent: THREE.Object3D, y: number, z: number, gap: number, r: number, glow?: number): void {
  for (const sx of [-1, 1]) {
    const e = sph(r, glow ? mat(glow, { basic: true }) : mat(0xffffff, { basic: true }), y);
    e.position.x = sx * gap; e.position.z = z;
    parent.add(e);
    if (!glow) { const p = sph(r * 0.55, mat(0x15151c, { basic: true }), y); p.position.x = sx * gap; p.position.z = z + r * 0.7; parent.add(p); }
  }
}

/** Builds an enemy from its look spec. Models face +Z; the view rotates them along the path. */
export function buildEnemy(def: EnemyDef): EnemyModel {
  const L = def.look, s = L.size, ex = L.extras ?? [];
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const C = mat(L.color), A = mat(L.accent);
  const em: EnemyModel = { group: g, body, legs: [], wings: [], height: s * 2.2, shape: L.shape };
  const has = (k: string) => ex.includes(k);
  switch (L.shape) {
    case 'biped': {
      for (const sx of [-1, 1]) { const leg = box(s * 0.32, s * 0.6, s * 0.36, A); leg.position.x = sx * s * 0.3; body.add(leg); em.legs.push(leg); }
      const torso = sph(s * 0.72, has('armor') ? mat(0x8a8f99) : C, s * 1.15);
      torso.scale.y = s * 0.8;
      body.add(torso);
      if (has('armor')) body.add(at(box(s * 1.2, s * 0.25, s * 1.0, mat(0x5d6068), s * 0.75), 0, null, 0));
      const head = sph(s * 0.56, has('skull') ? mat(0xf2ecdc) : C, s * 2.0);
      body.add(head);
      eyes(body, s * 2.05, s * 0.45, s * 0.22, s * 0.13, has('skull') ? 0xff4a3c : undefined);
      for (const sx of [-1, 1]) { const arm = box(s * 0.26, s * 0.7, s * 0.26, C, s * 0.8); arm.position.x = sx * s * 0.82; body.add(arm); em.legs.push(arm); }
      if (has('ears')) for (const sx of [-1, 1]) { const e = cone(s * 0.16, s * 0.5, C, s * 1.85); e.position.x = sx * s * 0.72; e.rotation.z = -sx * 1.25; body.add(e); }
      if (has('horns')) for (const sx of [-1, 1]) { const h = cone(s * 0.12, s * 0.42, mat(0xf2ecdc), s * 2.3); h.position.x = sx * s * 0.32; h.rotation.z = -sx * 0.4; body.add(h); }
      if (has('hood')) body.add(cone(s * 0.62, s * 0.9, A, s * 2.05, 6));
      if (has('crown')) { body.add(cyl(s * 0.42, s * 0.36, s * 0.26, mat(GOLD, { emissive: 0x8a6a10 }), s * 2.42, 6)); }
      if (has('club')) { const c = cyl(s * 0.2, s * 0.1, s * 1.2, mat(WOOD_D), s * 0.7, 6); c.position.x = s * 1.05; c.position.z = s * 0.3; c.rotation.x = 0.5; body.add(c); }
      if (has('staff')) { const st = cyl(s * 0.06, s * 0.06, s * 2.4, mat(WOOD_D), s * 0.2, 5); st.position.x = s * 1.0; body.add(st); const orb = sph(s * 0.22, mat(L.accent, { emissive: L.accent }), s * 2.7); orb.position.x = s * 1.0; body.add(orb); }
      if (has('shield')) { const sh = cyl(s * 0.5, s * 0.5, s * 0.1, mat(0x4b4f63), s * 0.9, 8); sh.rotation.x = Math.PI / 2; sh.position.set(-s * 0.9, s * 1.1, s * 0.4); body.add(sh); }
      if (has('banner')) { const p = box(s * 0.06, s * 2.2, s * 0.06, mat(DARK), s * 0.6); p.position.set(-s * 0.5, s * 0.6 + s * 1.1, -s * 0.5); body.add(p); const f = box(s * 0.6, s * 0.4, s * 0.04, mat(0xd9412f), s * 2.4); f.position.set(-s * 0.2, s * 2.6, -s * 0.5); body.add(f); }
      if (has('tail')) { const t = cone(s * 0.1, s * 0.7, C, s * 0.5); t.position.z = -s * 0.7; t.rotation.x = -1.2; body.add(t); }
      em.height = s * 2.9;
      break;
    }
    case 'quad': {
      const torso = box(s * 0.9, s * 0.8, s * 1.9, C, s * 0.7);
      body.add(torso);
      const head = box(s * 0.75, s * 0.7, s * 0.8, C, s * 1.05);
      head.position.z = s * 1.2;
      body.add(head);
      body.add(at(box(s * 0.4, s * 0.3, s * 0.5, A, s * 1.0), 0, null, s * 1.7));
      eyes(body, s * 1.55, s * 1.55, s * 0.24, s * 0.11, L.accent === 0xff8a2e ? 0xffc23e : undefined);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const leg = box(s * 0.26, s * 0.7, s * 0.26, A); leg.position.set(sx * s * 0.34, s * 0.35, sz * s * 0.65); body.add(leg); em.legs.push(leg); }
      for (const sx of [-1, 1]) { const ear = cone(s * 0.14, s * 0.36, A, s * 1.75); ear.position.set(sx * s * 0.26, s * 1.9, s * 1.05); body.add(ear); }
      const tail = cone(s * 0.14, s * 0.8, A, s * 1.1); tail.position.z = -s * 1.2; tail.rotation.x = -1.0; body.add(tail);
      em.height = s * 2.3;
      break;
    }
    case 'blob': {
      const b = sph(s, mat(L.color, { opacity: 0.92 }), s * 0.78);
      b.scale.y = s * 0.8;
      body.add(b);
      body.add(at(sph(s * 0.34, mat(L.accent, { opacity: 0.7 }), s * 0.6), s * 0.1, null, -s * 0.1));
      eyes(body, s * 1.0, s * 0.8, s * 0.3, s * 0.17);
      em.height = s * 2.0;
      break;
    }
    case 'flyer': {
      const b = sph(s * 0.75, C, 0);
      b.scale.z = s * 1.0;
      body.add(b);
      const head = sph(s * 0.5, C, s * 0.25); head.position.z = s * 0.75; body.add(head);
      eyes(body, s * 0.36, s * 1.12, s * 0.2, s * 0.12, 0xffe14a);
      for (const sx of [-1, 1]) {
        const pivot = new THREE.Group();
        const w = box(s * 1.6, s * 0.06, s * 1.0, A);
        w.position.set(sx * s * 0.85, 0, 0);
        pivot.add(w);
        const tip = cone(s * 0.3, s * 0.7, A, 0); tip.rotation.z = -sx * Math.PI / 2; tip.position.set(sx * s * 1.8, 0, -s * 0.2); pivot.add(tip);
        pivot.position.y = s * 0.2;
        body.add(pivot);
        em.wings.push(pivot);
      }
      for (const sx of [-1, 1]) { const ear = cone(s * 0.12, s * 0.34, A, s * 0.6); ear.position.set(sx * s * 0.25, s * 0.75, s * 0.7); body.add(ear); }
      em.height = s * 1.6;
      break;
    }
    case 'ghost': {
      const robe = cone(s * 0.85, s * 1.8, mat(L.color, { opacity: 0.85 }), 0, 7);
      robe.position.y = s * 1.0;
      body.add(robe);
      const head = sph(s * 0.55, mat(L.color, { opacity: 0.9 }), s * 1.9);
      body.add(head);
      eyes(body, s * 1.95, s * 0.42, s * 0.2, s * 0.13, L.accent);
      if (has('crown')) body.add(cyl(s * 0.4, s * 0.34, s * 0.24, mat(GOLD, { emissive: 0x8a6a10 }), s * 2.3, 6));
      if (has('staff')) { const st = cyl(s * 0.05, s * 0.05, s * 2.6, mat(0x2a2030), s * 0.2, 5); st.position.x = s * 0.95; body.add(st); const orb = sph(s * 0.24, mat(L.accent, { emissive: L.accent }), s * 2.95); orb.position.x = s * 0.95; body.add(orb); }
      for (const sx of [-1, 1]) { const arm = cone(s * 0.16, s * 0.8, mat(L.color, { opacity: 0.85 }), s * 1.0); arm.position.x = sx * s * 0.75; arm.rotation.z = sx * 0.9; body.add(arm); em.legs.push(arm); }
      em.height = s * 2.8;
      break;
    }
    case 'golem': {
      for (const sx of [-1, 1]) { const leg = box(s * 0.5, s * 0.7, s * 0.55, A); leg.position.x = sx * s * 0.42; body.add(leg); em.legs.push(leg); }
      const torso = box(s * 1.5, s * 1.2, s * 1.1, C, s * 0.65);
      torso.rotation.y = 0.1;
      body.add(torso);
      const head = box(s * 0.75, s * 0.6, s * 0.7, C, s * 1.85);
      body.add(head);
      eyes(body, s * 2.15, s * 0.36, s * 0.2, s * 0.11, L.accent);
      for (const sx of [-1, 1]) { const arm = box(s * 0.5, s * 1.2, s * 0.5, A, s * 0.55); arm.position.x = sx * s * 1.05; body.add(arm); em.legs.push(arm); }
      body.add(at(octa(s * 0.3, s * 0.45, mat(L.accent, { emissive: L.accent }), s * 1.3), 0, null, s * 0.5));
      if (has('horns')) for (const sx of [-1, 1]) { const h = cone(s * 0.16, s * 0.55, mat(0xf2fbff), s * 2.4); h.position.x = sx * s * 0.34; h.rotation.z = -sx * 0.5; body.add(h); }
      if (has('crown')) body.add(cyl(s * 0.44, s * 0.38, s * 0.26, mat(GOLD, { emissive: 0x8a6a10 }), s * 2.45, 6));
      em.height = s * 2.9;
      break;
    }
    case 'dragon': {
      const b = sph(s * 0.8, C, 0); b.scale.z = s * 1.5; body.add(b);
      const neck = cyl(s * 0.3, s * 0.42, s * 0.9, C, 0, 6); neck.rotation.x = 1.0; neck.position.set(0, s * 0.35, s * 1.15); body.add(neck);
      const head = box(s * 0.6, s * 0.5, s * 0.9, C, s * 0.5); head.position.z = s * 1.9; body.add(head);
      eyes(body, s * 0.95, s * 2.1, s * 0.22, s * 0.11, 0xffe14a);
      for (const sx of [-1, 1]) { const h = cone(s * 0.1, s * 0.45, mat(0xf2ecdc), s * 1.0); h.position.set(sx * s * 0.22, s * 1.25, s * 1.6); h.rotation.x = -0.6; body.add(h); }
      const tail = cone(s * 0.3, s * 1.8, C, 0, 6); tail.rotation.x = -Math.PI / 2; tail.position.set(0, 0, -s * 1.9); body.add(tail);
      for (const sx of [-1, 1]) {
        const pivot = new THREE.Group();
        const w = box(s * 2.0, s * 0.07, s * 1.4, A); w.position.x = sx * s * 1.1; pivot.add(w);
        const tip = cone(s * 0.5, s * 1.0, A, 0); tip.rotation.z = -sx * Math.PI / 2; tip.position.set(sx * s * 2.3, 0, -s * 0.3); pivot.add(tip);
        pivot.position.y = s * 0.3;
        body.add(pivot);
        em.wings.push(pivot);
      }
      body.add(at(octa(s * 0.25, s * 0.3, mat(L.accent, { emissive: L.accent }), s * 0.5), 0, null, s * 2.4));
      em.height = s * 1.8;
      break;
    }
  }
  return em;
}

/** The player's castle; palette comes from the world, `skin` from equipped cosmetics. */
export function buildCastle(world: WorldDef, skin: string): THREE.Group {
  const g = new THREE.Group();
  const wallC = skin === 'obsidian' ? 0x3a3d4a : skin === 'golden' ? 0xf0d98a : skin === 'crystal' ? 0xbfe6ff : world.palette.castle;
  const roofC = skin === 'obsidian' ? 0xb8321a : skin === 'golden' ? 0xd9412f : skin === 'crystal' ? 0x7a4bd1 : world.palette.roof;
  const wall = mat(wallC), roof = mat(roofC), dark = mat(0x4a4038);
  g.add(box(1.15, 0.5, 1.0, wall, 0));
  for (let i = -2; i <= 2; i++) g.add(at(box(0.14, 0.12, 0.14, wall, 0.5), i * 0.24, null, 0.44));
  g.add(at(box(0.36, 0.4, 0.06, dark, 0), 0, null, -0.5));
  g.add(at(box(0.3, 0.34, 0.07, mat(WOOD_D), 0), 0, null, -0.51));
  const keep = cyl(0.3, 0.34, 0.95, wall, 0, 8);
  g.add(keep);
  g.add(cone(0.42, 0.5, roof, 0.95, 8));
  for (const [x, z] of [[-0.58, -0.48], [0.58, -0.48], [-0.58, 0.48], [0.58, 0.48]]) {
    g.add(at(cyl(0.17, 0.19, 0.7, wall, 0, 8), x, null, z));
    g.add(at(cone(0.24, 0.34, roof, 0.7, 8), x, null, z));
  }
  g.add(at(box(0.02, 0.4, 0.02, mat(DARK), 1.4), 0, null, 0));
  const flag = at(box(0.22, 0.13, 0.02, mat(skin === 'golden' ? 0xffffff : GOLD), 1.66), 0.12, null, 0);
  flag.name = 'flag';
  g.add(flag);
  if (skin === 'crystal') g.add(at(octa(0.14, 0.26, mat(0x9fe6ff, { emissive: 0x9fe6ff }), 1.9), 0, null, 0));
  return g;
}

/** World decoration props scattered around the road. */
export function buildDecor(kind: string, world: WorldDef, r: number): THREE.Group {
  const g = new THREE.Group();
  const p = world.palette;
  const s = 0.75 + r * 0.6;
  switch (kind) {
    case 'tree': g.add(cyl(0.05, 0.07, 0.25, mat(WOOD_D), 0, 5), sph(0.26, mat(p.decor), 0.45), at(sph(0.18, mat(0x3fa34d), 0.62), 0.08, null, 0.04)); break;
    case 'pine': g.add(cyl(0.05, 0.06, 0.2, mat(WOOD_D), 0, 5), cone(0.26, 0.4, mat(p.decor), 0.18, 6), cone(0.19, 0.34, mat(p.decor), 0.42, 6), cone(0.2, 0.1, mat(0xffffff), 0.7, 6)); break;
    case 'bush': g.add(sph(0.16, mat(p.decor), 0.12), at(sph(0.12, mat(0x3fa34d), 0.1), 0.14, null, 0.05)); break;
    case 'rock': case 'icerock': case 'lavarock': { const c = kind === 'icerock' ? p.decor2 : kind === 'lavarock' ? 0x2a2020 : 0x9a9a9a; const o = octa(0.2, 0.16, mat(c), 0.1); o.rotation.y = r * 6; g.add(o, at(octa(0.11, 0.1, mat(c), 0.07), 0.2, null, 0.08)); if (kind === 'lavarock') g.add(at(sph(0.05, mat(0xff6a1f, { emissive: 0xff6a1f }), 0.16), 0.03, null, 0.1)); break; }
    case 'flower': for (let i = 0; i < 3; i++) g.add(at(sph(0.05, mat([0xff7da8, 0xfff06b, 0xffffff][i], { basic: true }), 0.06), (i - 1) * 0.13, null, (i % 2) * 0.1)); break;
    case 'crystal': { const c = p.decor2; g.add(octa(0.09, 0.3, mat(c, { emissive: c, opacity: 0.9 }), 0.22), at(octa(0.06, 0.18, mat(c, { emissive: c, opacity: 0.9 }), 0.12), 0.13, null, 0.05)); break; }
    case 'snowman': g.add(sph(0.16, mat(0xffffff), 0.14), sph(0.11, mat(0xffffff), 0.36), at(cone(0.03, 0.1, mat(0xff8a2e), 0.33), 0, null, 0.12)); break;
    case 'deadtree': g.add(cyl(0.04, 0.07, 0.45, mat(0x3a2c2a), 0, 5)); for (const sx of [-1, 1]) { const b = cyl(0.02, 0.03, 0.25, mat(0x3a2c2a), 0.3, 4); b.position.x = sx * 0.08; b.rotation.z = -sx * 0.8; g.add(b); } break;
    case 'ember': g.add(cyl(0.2, 0.22, 0.03, mat(0xff6a1f, { emissive: 0xff6a1f }), 0, 8), at(sph(0.05, mat(0xffd23e, { emissive: 0xffd23e }), 0.06), 0.05, null, 0)); break;
    case 'bones': g.add(sph(0.09, mat(0xe6e0cf), 0.08)); { const b = box(0.3, 0.04, 0.05, mat(0xe6e0cf), 0.01); b.rotation.y = r * 3; b.position.x = 0.15; g.add(b); } break;
    case 'mushroom': g.add(cyl(0.04, 0.05, 0.16, mat(0xe6e0cf), 0, 5), cone(0.17, 0.14, mat(p.decor, { emissive: p.decor }), 0.14, 7), at(sph(0.03, mat(p.decor2, { basic: true }), 0.22), 0.06, null, 0.06)); break;
    case 'grave': g.add(box(0.2, 0.26, 0.06, mat(0x6f6a8a), 0), at(box(0.26, 0.05, 0.3, mat(0x4a456a), 0), 0, null, 0.14)); break;
  }
  g.scale.setScalar(s);
  g.rotation.y = r * Math.PI * 2;
  return g;
}

export function disposeModelCaches(): void {
  geoCache.forEach((g) => g.dispose());
  matCache.forEach((m) => m.dispose());
  geoCache.clear();
  matCache.clear();
}
