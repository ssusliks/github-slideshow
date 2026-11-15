import * as THREE from 'three';
import type { Battle, BattleEvent, EnemyState } from '../core/battle';
import type { Pt } from '../core/map';
import type { DamageType, WorldDef } from '../core/types';
import { ENEMIES } from '../data/enemies';
import { TOWERS } from '../data/towers';
import { hashStr } from '../core/rng';
import { EnemyModel, TowerModel, box, buildCastle, buildDecor, buildEnemy, buildTower, mat, octa, sph, torus } from './models';
import { Particles } from './particles';

export const EL_COLOR: Record<DamageType, number> = {
  physical: 0xdfe6ee, fire: 0xff7b2e, ice: 0x7de3ff, poison: 0x9be03c, lightning: 0xf7e94a, arcane: 0xd67dff, light: 0xfff2a8,
};

export interface ViewSettings {
  quality: 'low' | 'medium' | 'high';
  /** 0..1 effects intensity. */
  fx: number;
  shake: boolean;
}
const QUALITY = {
  low: { dpr: 1, particles: 150, aa: false, decor: 0.5 },
  medium: { dpr: 1.5, particles: 350, aa: false, decor: 1 },
  high: { dpr: 2, particles: 600, aa: true, decor: 1 },
};

const YAW = 0.3, PITCH = 0.9;
const FLY_H = 0.95;

interface TowerView { model: TowerModel; key: string; slot: number; pop: number; recoil: number; stun: THREE.Object3D }
interface EnemyView { model: EnemyModel; def: string; ring: THREE.Mesh; ringMat: THREE.MeshBasicMaterial; hpBg: THREE.Sprite; hpFill: THREE.Sprite; ice: THREE.Mesh; shield: THREE.Mesh; phase: number; x: number; z: number; yaw: number; spawn: number }
interface ProjView { mesh: THREE.Mesh; kind: string; d0: number; y0: number }
interface Seg { mesh: THREE.Mesh; life: number; max: number; w: number }
interface Ring { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; max: number; r0: number; r1: number }

/**
 * Three.js presentation of a Battle. Reads the simulation state every frame, consumes its
 * event queue for effects and never mutates game state. All transient objects are pooled.
 */
export class BattleView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  private battle: Battle | null = null;
  private world: WorldDef | null = null;
  private stat = new THREE.Group();
  private dyn = new THREE.Group();
  private towers = new Map<number, TowerView>();
  private enemies = new Map<number, EnemyView>();
  private enemyPool = new Map<string, EnemyView[]>();
  private projs = new Map<number, ProjView>();
  private projPool = new Map<string, THREE.Mesh[]>();
  private ringGeos = new Map<string, THREE.BufferGeometry>();
  /** Shared geometries of pooled effects (lightning segments, shock rings). */
  private segGeo = new THREE.BoxGeometry(1, 1, 1);
  private ringGeo = new THREE.RingGeometry(0.86, 1, 40).rotateX(-Math.PI / 2);
  private segs: Seg[] = [];
  private rings: Ring[] = [];
  private slotRings: THREE.Mesh[] = [];
  private slotMats: THREE.MeshBasicMaterial[] = [];
  private rangeRing: THREE.Mesh;
  private selRing: THREE.Mesh;
  private targetRing: THREE.Mesh;
  private ghost: { key: string; model: TowerModel } | null = null;
  private castle: THREE.Group | null = null;
  private castleFlash = 0;
  private portals: THREE.Object3D[] = [];
  particles: Particles;
  private center = new THREE.Vector3();
  private fitHalfW = 5;
  private zoom = 1;
  private shakeT = 0;
  private shakeAmp = 0;
  private time = 0;
  private w = 1;
  private h = 1;
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private v3 = new THREE.Vector3();
  private v2 = new THREE.Vector2();
  private textPool: HTMLElement[] = [];
  private textIdx = 0;
  private lastReactionText = 0;
  private hl: Map<number, string> | null = null;
  private selected = 0;
  /** insets (px) covered by HUD: the map is fitted into the remaining area. */
  insets = { top: 96, bottom: 190 };
  lost = false;

  constructor(private canvas: HTMLCanvasElement, private textLayer: HTMLElement, public settings: ViewSettings) {
    const q = QUALITY[settings.quality];
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: q.aa, alpha: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.setClearColor(0x000000, 0);
    this.scene.add(this.stat, this.dyn);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6a7a8a, 1.25));
    const sun = new THREE.DirectionalLight(0xfff4dd, 1.6);
    sun.position.set(-4, 9, 5);
    this.scene.add(sun);
    this.particles = new Particles(q.particles);
    this.particles.intensity = settings.fx;
    this.scene.add(this.particles.points);
    const ringGeo = new THREE.RingGeometry(0.96, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    this.rangeRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthTest: false }));
    this.rangeRing.visible = false;
    this.rangeRing.renderOrder = 5;
    this.selRing = torus(0.5, 0.03, new THREE.MeshBasicMaterial({ color: 0xfff2a8 }), 0.05);
    this.selRing.visible = false;
    const tg = new THREE.CircleGeometry(1, 40);
    tg.rotateX(-Math.PI / 2);
    this.targetRing = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ color: 0xff7b2e, transparent: true, opacity: 0.35, depthTest: false }));
    this.targetRing.visible = false;
    this.targetRing.renderOrder = 5;
    this.scene.add(this.rangeRing, this.selRing, this.targetRing);
    for (let i = 0; i < 14; i++) {
      const el = document.createElement('span');
      el.className = 'ftext';
      textLayer.appendChild(el);
      this.textPool.push(el);
    }
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; });
    this.resize();
  }

  applySettings(s: ViewSettings): void {
    this.settings = s;
    this.particles.intensity = s.fx;
    this.resize();
  }

  // ------------------------------------------------------------------ scene building
  setBattle(b: Battle, world: WorldDef, castleSkin: string): void {
    this.clearDynamic();
    this.stat.clear();
    this.battle = b;
    this.world = world;
    const map = b.map, p = world.palette;
    const q = QUALITY[this.settings.quality];
    // Island slab under the board.
    const slab = box(map.cols + 0.7, 0.5, map.rows + 0.7, mat(p.ground), -0.62);
    slab.position.set((map.cols - 1) / 2, slab.position.y, (map.rows - 1) / 2);
    this.stat.add(slab);
    const under = box(map.cols + 0.2, 0.5, map.rows + 0.2, mat(0x5a4636), -1.1);
    under.position.set((map.cols - 1) / 2, under.position.y, (map.rows - 1) / 2);
    this.stat.add(under);
    // Tiles: one instanced draw call.
    const tileGeo = new THREE.BoxGeometry(0.97, 0.12, 0.97);
    const tiles = new THREE.InstancedMesh(tileGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), map.cols * map.rows);
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    let n = 0;
    const isRoad = (c: string) => c === '#' || c === 'S' || c === 'T' || c === 'C';
    for (let y = 0; y < map.rows; y++) for (let x = 0; x < map.cols; x++) {
      const c = map.cells[y][x];
      const road = isRoad(c);
      m4.makeTranslation(x, road ? -0.1 : -0.06, y);
      tiles.setMatrixAt(n, m4);
      col.setHex(road ? p.path : (x + y) % 2 ? p.grassA : p.grassB);
      tiles.setColorAt(n, col);
      n++;
      if (!road && c !== 'o') {
        const r = (hashStr(`${map.cols}:${x}:${y}:${world.id}:${b.level.map}`) % 1000) / 1000;
        if (r < 0.42 * q.decor) {
          const d = buildDecor(world.decor[Math.floor(r * 97) % world.decor.length], world, (r * 7) % 1);
          d.position.set(x + ((r * 13) % 1 - 0.5) * 0.4, 0, y + ((r * 29) % 1 - 0.5) * 0.4);
          this.stat.add(d);
        }
      }
    }
    tiles.instanceMatrix.needsUpdate = true;
    if (tiles.instanceColor) tiles.instanceColor.needsUpdate = true;
    this.stat.add(tiles);
    // Tower slots.
    this.slotRings = [];
    this.slotMats = [];
    map.slots.forEach((s) => {
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.43, 0.07, 10), mat(0xa9a498));
      pad.position.set(s.x, 0.035, s.y);
      this.stat.add(pad);
      const rm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, depthTest: false });
      const rg = new THREE.RingGeometry(0.36, 0.5, 28);
      rg.rotateX(-Math.PI / 2);
      const ring = new THREE.Mesh(rg, rm);
      ring.position.set(s.x, 0.09, s.y);
      ring.renderOrder = 4;
      this.stat.add(ring);
      this.slotRings.push(ring);
      this.slotMats.push(rm);
    });
    // Castle and spawn portals.
    this.castle = buildCastle(world, castleSkin);
    this.castle.position.set(map.castle.x, 0, map.castle.y);
    this.stat.add(this.castle);
    this.portals = [];
    for (const s of map.spawns) {
      const portal = torus(0.36, 0.07, mat(0x7d4fd1, { emissive: 0x9b4de0 }), 0.42);
      portal.rotation.x = 0;
      portal.position.set(s.x, 0.42, s.y - 0.1);
      const core = new THREE.Mesh(new THREE.CircleGeometry(0.33, 16), mat(0x1a1030, { basic: true, opacity: 0.85 }));
      core.position.set(s.x, 0.42, s.y - 0.1);
      this.stat.add(portal, core);
      this.portals.push(portal);
    }
    this.fitCamera();
  }

  private clearDynamic(): void {
    this.dyn.clear();
    this.towers.clear();
    this.enemies.clear();
    this.enemyPool.clear();
    this.projs.clear();
    this.projPool.clear();
    this.segs = [];
    this.rings = [];
    this.ghost = null;
    this.selected = 0;
    this.selRing.visible = false;
    this.rangeRing.visible = false;
    this.targetRing.visible = false;
  }

  // ------------------------------------------------------------------ camera
  resize(): void {
    const q = QUALITY[this.settings.quality];
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.w = w; this.h = h;
    const dpr = Math.min(window.devicePixelRatio || 1, q.dpr) * this.dprScale;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.particles.setScale((h * dpr) / 2);
    if (this.battle) this.fitCamera(true);
  }
  /** Adaptive quality hook: 0.5..1 resolution scale. */
  dprScale = 1;
  setResolutionScale(s: number): void {
    if (Math.abs(s - this.dprScale) < 0.01) return;
    this.dprScale = s;
    this.resize();
  }

  private fitCamera(keep = false): void {
    if (!this.battle) return;
    const map = this.battle.map;
    const dir = new THREE.Vector3(Math.sin(YAW) * Math.cos(PITCH), Math.sin(PITCH), Math.cos(YAW) * Math.cos(PITCH));
    this.right.set(Math.cos(YAW), 0, -Math.sin(YAW));
    this.up.crossVectors(dir, this.right).normalize();
    const mid = new THREE.Vector3((map.cols - 1) / 2, 0, (map.rows - 1) / 2);
    let maxX = 0, minY = Infinity, maxY = -Infinity;
    const lo = -0.9, hx = map.cols - 0.1, hz = map.rows - 0.1;
    for (const [x, z, y] of [[lo, lo, 0], [hx, lo, 0], [lo, hz, 0], [hx, hz, 0], [lo, lo, 1.3], [hx, lo, 1.3], [lo, hz, -0.6], [hx, hz, -0.6]]) {
      const d = new THREE.Vector3(x, y, z).sub(mid);
      maxX = Math.max(maxX, Math.abs(d.dot(this.right)));
      const v = d.dot(this.up);
      minY = Math.min(minY, v); maxY = Math.max(maxY, v);
    }
    const aspect = this.w / this.h;
    const usable = Math.max(0.3, (this.h - this.insets.top - this.insets.bottom) / this.h);
    const halfWByWidth = maxX + 0.05;
    const halfWByHeight = ((maxY - minY) / 2 / usable) * aspect;
    this.fitHalfW = Math.max(halfWByWidth, halfWByHeight);
    if (!keep) {
      this.zoom = 1;
      this.center.copy(mid).addScaledVector(this.up, (minY + maxY) / 2);
      // Shift so the board sits in the middle of the area not covered by HUD.
      const halfH = this.fitHalfW / aspect;
      this.center.addScaledVector(this.up, ((this.insets.top - this.insets.bottom) / this.h) * halfH);
      this.center.y = 0;
      this.home = this.center.clone();
    }
    this.applyCamera(dir);
  }
  private home = new THREE.Vector3();

  private applyCamera(dir?: THREE.Vector3): void {
    const d = dir ?? new THREE.Vector3(Math.sin(YAW) * Math.cos(PITCH), Math.sin(PITCH), Math.cos(YAW) * Math.cos(PITCH));
    const halfW = this.fitHalfW / this.zoom, halfH = halfW / (this.w / this.h);
    const c = this.camera;
    c.left = -halfW; c.right = halfW; c.top = halfH; c.bottom = -halfH;
    c.position.copy(this.center).addScaledVector(d, 40);
    if (this.shakeT > 0) {
      const a = this.shakeAmp * (this.shakeT / 0.35);
      c.position.addScaledVector(this.right, (Math.random() - 0.5) * a).addScaledVector(this.up, (Math.random() - 0.5) * a);
    }
    c.lookAt(c.position.clone().addScaledVector(d, -1));
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }

  pan(dxPx: number, dyPx: number): void {
    if (!this.battle) return;
    const halfW = this.fitHalfW / this.zoom;
    const k = (2 * halfW) / this.w;
    const fwd = new THREE.Vector3(-Math.sin(YAW), 0, -Math.cos(YAW));
    this.center.addScaledVector(this.right, -dxPx * k).addScaledVector(fwd, (dyPx * k) / Math.sin(PITCH));
    const lim = 2.2 + (this.zoom - 1) * 3;
    this.center.x = Math.min(this.home.x + lim, Math.max(this.home.x - lim, this.center.x));
    this.center.z = Math.min(this.home.z + lim * 1.6, Math.max(this.home.z - lim * 1.6, this.center.z));
  }
  zoomBy(f: number): void {
    this.zoom = Math.min(2.4, Math.max(0.8, this.zoom * f));
    this.pan(0, 0);
  }
  resetCamera(): void {
    this.zoom = 1;
    this.center.copy(this.home);
  }

  groundAt(clientX: number, clientY: number): Pt | null {
    const r = this.canvas.getBoundingClientRect();
    this.v2.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.v2, this.camera);
    const hit = this.ray.ray.intersectPlane(this.plane, this.v3);
    return hit ? { x: hit.x, y: hit.z } : null;
  }
  screenOf(x: number, y: number, h = 0): { x: number; y: number } {
    this.v3.set(x, h, y).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((this.v3.x + 1) / 2) * r.width, y: r.top + ((1 - this.v3.y) / 2) * r.height };
  }
  /** Slot whose pad or tower is under the pointer (towers are tall, so test both the base and the body). */
  slotAtScreen(clientX: number, clientY: number, maxPx = 44): number {
    if (!this.battle) return -1;
    let best = -1, bd = maxPx * maxPx;
    this.battle.map.slots.forEach((s, i) => {
      for (const h of this.battle!.towerAt(i) ? [0.1, 0.5, 0.9] : [0.05]) {
        const p = this.screenOf(s.x, s.y, h);
        const d = (p.x - clientX) ** 2 + (p.y - clientY) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    });
    return best;
  }

  // ------------------------------------------------------------------ UI helpers
  setHighlights(hl: Map<number, string> | null): void {
    this.hl = hl;
    if (!hl) this.slotMats.forEach((m) => (m.opacity = 0));
  }
  setRange(x: number, y: number, r: number, color = 0xffffff): void {
    if (r <= 0) { this.rangeRing.visible = false; return; }
    this.rangeRing.visible = true;
    this.rangeRing.position.set(x, 0.1, y);
    this.rangeRing.scale.setScalar(r);
    (this.rangeRing.material as THREE.MeshBasicMaterial).color.setHex(color);
  }
  setSelected(id: number): void {
    this.selected = id;
  }
  setTargeting(r: number, pt?: Pt | null): void {
    if (r <= 0 || !pt) { this.targetRing.visible = false; return; }
    this.targetRing.visible = true;
    this.targetRing.position.set(pt.x, 0.12, pt.y);
    this.targetRing.scale.setScalar(r);
  }
  setGhost(def: string | null, tier = 1, branch: string | null = null, pt?: Pt | null): void {
    if (!def || !pt) {
      if (this.ghost) this.ghost.model.group.visible = false;
      return;
    }
    const key = `${def}:${tier}:${branch}`;
    if (!this.ghost || this.ghost.key !== key) {
      if (this.ghost) this.dyn.remove(this.ghost.model.group);
      this.ghost = { key, model: buildTower(TOWERS[def], tier, branch) };
      this.dyn.add(this.ghost.model.group);
    }
    this.ghost.model.group.visible = true;
    this.ghost.model.group.position.set(pt.x, 0.25, pt.y);
  }

  floatText(text: string, x: number, y: number, h: number, cls: string): void {
    const el = this.textPool[this.textIdx++ % this.textPool.length];
    const p = this.screenOf(x, y, h);
    const r = this.textLayer.getBoundingClientRect();
    el.textContent = text;
    el.className = 'ftext';
    el.style.left = `${p.x - r.left}px`;
    el.style.top = `${p.y - r.top}px`;
    void el.offsetWidth; // restart the CSS animation
    el.className = `ftext show ${cls}`;
  }
  shake(amp: number): void {
    if (!this.settings.shake) return;
    this.shakeT = 0.35;
    this.shakeAmp = Math.max(this.shakeAmp, amp);
  }

  // ------------------------------------------------------------------ pools
  private getEnemyView(def: string): EnemyView {
    const pool = this.enemyPool.get(def);
    const reused = pool?.pop();
    if (reused) { reused.model.group.visible = true; return reused; }
    const d = ENEMIES[def];
    const model = buildEnemy(d);
    const boss = d.tags.includes('boss');
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false });
    // One shadow/status disc geometry per enemy type, shared by every pooled instance.
    let rg = this.ringGeos.get(def);
    if (!rg) { rg = new THREE.CircleGeometry(d.look.size * 1.25, 16); rg.rotateX(-Math.PI / 2); this.ringGeos.set(def, rg); }
    const ring = new THREE.Mesh(rg, ringMat);
    const bw = boss ? 1.1 : 0.5;
    const hpBg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x1b1e26, depthTest: false }));
    hpBg.scale.set(bw + 0.05, boss ? 0.13 : 0.085, 1);
    const hpFill = new THREE.Sprite(new THREE.SpriteMaterial({ color: boss ? 0xc94fd6 : 0x6fe06b, depthTest: false }));
    hpFill.center.set(0, 0.5);
    hpFill.scale.set(bw, boss ? 0.09 : 0.055, 1);
    hpBg.renderOrder = 6; hpFill.renderOrder = 7;
    const ice = box(d.look.size * 2.2, model.height * 0.9, d.look.size * 2.2, mat(0x9fe6ff, { opacity: 0.5 }), 0);
    const shield = sph(Math.max(model.height * 0.62, d.look.size * 1.9), mat(0x8fd6ff, { opacity: 0.35, emissive: 0x4fa0ff }), 0);
    this.dyn.add(model.group, ring, hpBg, hpFill, ice, shield);
    return { model, def, ring, ringMat, hpBg, hpFill, ice, shield, phase: Math.random() * 6, x: 0, z: 0, yaw: 0, spawn: 0 };
  }
  private releaseEnemy(v: EnemyView): void {
    v.model.group.visible = false; v.ring.visible = false; v.hpBg.visible = false; v.hpFill.visible = false; v.ice.visible = false; v.shield.visible = false;
    let pool = this.enemyPool.get(v.def);
    if (!pool) this.enemyPool.set(v.def, (pool = []));
    pool.push(v);
  }
  private getProj(look: string, el: DamageType): THREE.Mesh {
    const kind = look === 'archer' || look === 'venom' ? 'arrow' : look === 'cannon' || look === 'meteor' || look === 'frostcannon' ? 'ball' : `orb:${el}`;
    const pool = this.projPool.get(kind);
    let m = pool?.pop();
    if (!m) {
      if (kind === 'arrow') m = box(0.04, 0.04, 0.32, mat(look === 'venom' ? 0xc9ff6b : 0xf2e6c9, { basic: true }), 0);
      else if (kind === 'ball') m = sph(0.11, mat(look === 'meteor' ? 0xff7b2e : look === 'frostcannon' ? 0x9fd8f5 : 0x2f3136, look === 'cannon' ? {} : { emissive: EL_COLOR[el] }), 0);
      else m = el === 'ice' ? octa(0.08, 0.16, mat(EL_COLOR[el], { emissive: EL_COLOR[el] }), 0) : sph(0.09, mat(EL_COLOR[el], { emissive: EL_COLOR[el], basic: true }), 0);
      m.userData.kind = kind;
      this.dyn.add(m);
    }
    m.visible = true;
    return m;
  }
  private addSeg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: number, w: number, life: number): void {
    let s = this.segs.find((x) => x.life <= 0);
    if (!s) {
      if (this.segs.length >= 70) return;
      const mesh = new THREE.Mesh(this.segGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false }));
      mesh.renderOrder = 8;
      this.dyn.add(mesh);
      s = { mesh, life: 0, max: 1, w };
      this.segs.push(s);
    }
    const m = s.mesh;
    (m.material as THREE.MeshBasicMaterial).color.setHex(color);
    m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    m.lookAt(bx, by, bz);
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    m.scale.set(w, w, len);
    m.visible = true;
    s.life = s.max = life;
    s.w = w;
  }
  private bolt(ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: number): void {
    const n = Math.max(2, Math.min(5, Math.round(Math.hypot(bx - ax, bz - az) * 2)));
    let px = ax, py = ay, pz = az;
    for (let i = 1; i <= n; i++) {
      const t = i / n, j = i === n ? 0 : 0.14;
      const x = ax + (bx - ax) * t + (Math.random() - 0.5) * j * 2, y = ay + (by - ay) * t + (Math.random() - 0.5) * j, z = az + (bz - az) * t + (Math.random() - 0.5) * j * 2;
      this.addSeg(px, py, pz, x, y, z, color, 0.06, 0.16);
      px = x; py = y; pz = z;
    }
  }
  private addRing(x: number, z: number, r0: number, r1: number, color: number, life: number, y = 0.1): void {
    let r = this.rings.find((q) => q.life <= 0);
    if (!r) {
      if (this.rings.length >= 14) return;
      const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, depthTest: false });
      const mesh = new THREE.Mesh(this.ringGeo, m);
      mesh.renderOrder = 6;
      this.dyn.add(mesh);
      r = { mesh, mat: m, life: 0, max: 1, r0, r1 };
      this.rings.push(r);
    }
    r.mat.color.setHex(color);
    r.mesh.position.set(x, y, z);
    r.mesh.visible = true;
    r.life = r.max = life; r.r0 = r0; r.r1 = r1;
  }

  // ------------------------------------------------------------------ events → effects
  private handle(ev: BattleEvent, b: Battle): void {
    const P = this.particles;
    switch (ev.t) {
      case 'shot': { const tv = this.towers.get(ev.tower); if (tv) { tv.recoil = 1; this.aim(tv, ev.tx, ev.ty); } break; }
      case 'chain': {
        const tv = this.towers.get(ev.tower);
        if (tv) tv.recoil = 1;
        const pts: number[] = ev.pts, col = EL_COLOR[ev.el as DamageType];
        let px = pts[0], py = tv ? tv.model.muzzleY * tv.model.group.scale.y : 0.9, pz = pts[1];
        for (let i = 3; i < pts.length; i += 3) {
          const y = pts[i + 2] ? FLY_H : 0.35;
          this.bolt(px, py, pz, pts[i], y, pts[i + 1], col);
          P.emit(pts[i], y, pts[i + 1], col, 3, { speed: 1.6, life: 0.25, size: 0.12 });
          px = pts[i]; py = y; pz = pts[i + 1];
        }
        break;
      }
      case 'beam': {
        const tv = this.towers.get(ev.tower);
        if (!tv) break;
        const y0 = tv.model.muzzleY * tv.model.group.scale.y, col = EL_COLOR[ev.el as DamageType];
        const pts: number[] = ev.pts;
        for (let i = 0; i < pts.length; i += 3) {
          const y = pts[i + 2] ? FLY_H : 0.35;
          this.addSeg(ev.x, y0, ev.y, pts[i], y, pts[i + 1], col, 0.05 + 0.05 * Math.min(1, ev.ramp), 0.3);
          if (Math.random() < 0.5) P.emit(pts[i], y, pts[i + 1], col, 1, { speed: 0.8, life: 0.3, size: 0.12 });
        }
        break;
      }
      case 'pulse': { const tv = this.towers.get(ev.tower); if (tv) tv.recoil = 1; this.addRing(ev.x, ev.y, 0.3, ev.r, EL_COLOR[ev.el as DamageType], 0.45); break; }
      case 'splash': this.addRing(ev.x, ev.y, 0.2, ev.r, EL_COLOR[ev.el as DamageType], 0.3); P.emit(ev.x, 0.2, ev.y, EL_COLOR[ev.el as DamageType], 8, { speed: 2.2, life: 0.4, size: 0.18 }); P.emit(ev.x, 0.15, ev.y, 0x6b5a4a, 4, { speed: 1.2, life: 0.5, size: 0.2, gravity: 1 }); break;
      case 'hit': {
        const y = ev.fly ? FLY_H : 0.35;
        P.emit(ev.x, y, ev.y, EL_COLOR[ev.el as DamageType], ev.crit ? 6 : 2, { speed: 1.4, life: 0.28, size: 0.11 });
        if (ev.crit) this.floatText(fmt(ev.dmg) + '!', ev.x, ev.y, y + 0.5, 'crit');
        break;
      }
      case 'kill': {
        const d = ENEMIES[ev.def];
        P.emit(ev.x, 0.4, ev.y, d.look.color, ev.boss ? 40 : 9, { speed: ev.boss ? 3.2 : 2, life: ev.boss ? 0.9 : 0.5, size: ev.boss ? 0.3 : 0.17 });
        P.emit(ev.x, 0.4, ev.y, 0xf2c94c, ev.boss ? 16 : 2, { speed: 1.5, up: 1.5, life: 0.6, size: 0.12 });
        this.floatText(`+${ev.coins}`, ev.x, ev.y, 0.7, 'coin');
        if (ev.boss) { this.shake(0.35); this.addRing(ev.x, ev.y, 0.3, 2.4, 0xffffff, 0.6); }
        break;
      }
      case 'reaction': {
        P.emit(ev.x, 0.5, ev.y, 0xffffff, 3, { speed: 1.8, life: 0.3, size: 0.14 });
        if (this.time - this.lastReactionText > 0.7 && this.settings.fx > 0.3) { this.lastReactionText = this.time; this.onReaction?.(ev.id, ev.x, ev.y); }
        break;
      }
      case 'spread': this.addRing(ev.x, ev.y, 0.2, ev.r, 0x9be03c, 0.35); break;
      case 'blast': this.addRing(ev.x, ev.y, 0.2, 1.1, 0xff7b2e, 0.3); P.emit(ev.x, 0.3, ev.y, 0xff7b2e, 10, { speed: 2.4, life: 0.4, size: 0.2 }); break;
      case 'leak': this.castleFlash = 0.5; this.shake(ev.boss ? 0.5 : 0.22); if (this.castle) P.emit(this.castle.position.x, 0.6, this.castle.position.z, 0xff4a3c, 10, { speed: 2, life: 0.5, size: 0.2 }); break;
      case 'place': { const tv = this.syncTower(b, ev.tower); if (tv) { tv.pop = 1; const s = b.slotPos(ev.slot); P.emit(s.x, 0.15, s.y, 0xd9d2c0, 8, { speed: 1.4, life: 0.4, size: 0.2, gravity: 1 }); } break; }
      case 'merge': {
        const s = b.slotPos(ev.slot), f = b.slotPos(ev.from);
        const tv = this.syncTower(b, ev.tower);
        if (tv) tv.pop = 1.4;
        const col = ev.hybrid ? 0xff7df2 : 0xfff2a8;
        this.addRing(s.x, s.y, 0.2, 1.3, col, 0.5);
        P.emit(s.x, 0.6, s.y, col, 26, { speed: 2.6, up: 1, life: 0.7, size: 0.2 });
        P.emit(f.x, 0.4, f.y, col, 8, { speed: 1.2, life: 0.4, size: 0.16 });
        this.addSeg(f.x, 0.5, f.y, s.x, 0.5, s.y, col, 0.08, 0.3);
        break;
      }
      case 'upgrade': { const t = b.tower(ev.tower); if (t) { const s = b.slotPos(t.slot); P.emit(s.x, 0.3, s.y, 0x7dff9a, 12, { speed: 0.8, up: 2.2, life: 0.6, size: 0.16, gravity: 0.5 }); const tv = this.towers.get(t.id); if (tv) tv.pop = 0.6; } break; }
      case 'sell': { const s = b.slotPos(ev.slot); P.emit(s.x, 0.3, s.y, 0xf2c94c, 10, { speed: 1.6, up: 1, life: 0.5, size: 0.14 }); break; }
      case 'ability': {
        if (ev.id === 'meteor') {
          const big = !ev.mini;
          this.addSeg(ev.x - 1.2, 5, ev.y - 2.5, ev.x, 0.2, ev.y, 0xffb23e, big ? 0.22 : 0.12, 0.22);
          this.addRing(ev.x, ev.y, 0.2, ev.r, 0xff7b2e, 0.5);
          P.emit(ev.x, 0.3, ev.y, 0xff7b2e, big ? 34 : 12, { speed: 3.4, life: 0.7, size: 0.26 });
          P.emit(ev.x, 0.3, ev.y, 0x3a2c2a, big ? 10 : 4, { speed: 1.5, up: 1, life: 0.9, size: 0.3, gravity: 0.5 });
          if (big) this.shake(0.4);
        } else if (ev.id === 'freeze') {
          for (const e of b.s.enemies) P.emit(e.x, 0.5, e.y, 0xbfeaff, 6, { speed: 1.2, life: 0.6, size: 0.14, gravity: 0.6 });
        } else if (ev.id === 'overcharge') {
          for (const t of b.s.towers) { const s = b.slotPos(t.slot); P.emit(s.x, 0.8, s.y, 0xf7e94a, 6, { speed: 1.2, up: 1.5, life: 0.6, size: 0.14 }); }
        } else if (ev.id === 'heal' && this.castle) {
          P.emit(this.castle.position.x, 0.5, this.castle.position.z, 0x7dff9a, 24, { speed: 1, up: 2.4, life: 0.9, size: 0.2, gravity: 0.3 });
        }
        break;
      }
      case 'enemyAbility': {
        const col = ev.kind === 'enrage' ? 0xff3c2e : ev.kind === 'shield' ? 0x8fd6ff : ev.kind === 'stun' ? 0xfff06b : 0xb46bff;
        P.emit(ev.x, 0.6, ev.y, col, 14, { speed: 2, life: 0.5, size: 0.2 });
        this.addRing(ev.x, ev.y, 0.2, ev.kind === 'stun' ? 2.6 : 1.1, col, 0.45);
        if (ev.kind === 'stun') this.shake(0.2);
        break;
      }
      case 'revive': if (this.castle) { this.addRing(this.castle.position.x, this.castle.position.z, 0.3, 4, 0x7dff9a, 0.8); P.emit(this.castle.position.x, 0.5, this.castle.position.z, 0x7dff9a, 30, { speed: 2, up: 2, life: 0.9, size: 0.22 }); } break;
      case 'win': if (this.castle) for (let i = 0; i < 5; i++) P.emit(this.castle.position.x + (Math.random() - 0.5) * 3, 1.5 + Math.random(), this.castle.position.z + (Math.random() - 0.5) * 2, [0xfff06b, 0xff7da8, 0x7de3ff, 0x7dff9a][i % 4], 16, { speed: 2.6, life: 1, size: 0.2, gravity: 1.5 }); break;
      case 'lose': if (this.castle) P.emit(this.castle.position.x, 0.6, this.castle.position.z, 0x3a3d42, 40, { speed: 1.6, up: 1.6, life: 1.4, size: 0.34, gravity: 0.2 }); this.shake(0.6); break;
    }
  }
  /** Set by the UI to show localised reaction names. */
  onReaction: ((id: string, x: number, y: number) => void) | null = null;

  private aim(tv: TowerView, tx: number, ty: number): void {
    const head = tv.model.head;
    if (!head) return;
    const g = tv.model.group;
    head.rotation.y = Math.atan2(tx - g.position.x, ty - g.position.z);
  }

  private syncTower(b: Battle, id: number): TowerView | null {
    const t = b.tower(id);
    if (!t) return null;
    const key = `${t.def}:${t.tier}:${t.branch}`;
    let tv = this.towers.get(id);
    if (!tv || tv.key !== key) {
      if (tv) this.dyn.remove(tv.model.group, tv.stun);
      const model = buildTower(TOWERS[t.def], t.tier, t.branch);
      const stun = torus(0.3, 0.035, mat(0xfff06b, { basic: true }), 0);
      stun.visible = false;
      this.dyn.add(model.group, stun);
      tv = { model, key, slot: -1, pop: 0, recoil: 0, stun };
      this.towers.set(id, tv);
    }
    if (tv.slot !== t.slot) {
      const s = b.slotPos(t.slot);
      tv.model.group.position.set(s.x, 0.07, s.y);
      tv.slot = t.slot;
    }
    return tv;
  }

  // ------------------------------------------------------------------ frame
  frame(dt: number): void {
    const b = this.battle;
    if (!b || this.lost) return;
    this.time += dt;
    const t = this.time, P = this.particles;
    // Towers
    const seen = new Set<number>();
    for (const tw of b.s.towers) {
      seen.add(tw.id);
      const tv = this.syncTower(b, tw.id)!;
      const m = tv.model, base = 1 + 0.07 * (tw.tier - 1);
      if (tv.pop > 0) tv.pop = Math.max(0, tv.pop - dt * 3);
      if (tv.recoil > 0) tv.recoil = Math.max(0, tv.recoil - dt * 6);
      const pop = 1 + Math.sin(tv.pop * Math.PI) * 0.25;
      m.group.scale.set(base * pop * (1 + tv.recoil * 0.05), base * pop * (1 - tv.recoil * 0.08), base * pop * (1 + tv.recoil * 0.05));
      for (const s of m.spin) s.rotation.y += dt * 1.6;
      for (let i = 0; i < m.bob.length; i++) m.bob[i].position.y += Math.sin(t * 2.4 + i) * dt * 0.05;
      for (let i = 0; i < m.flicker.length; i++) { const f = m.flicker[i]; const k = 1 + Math.sin(t * 9 + i * 2.1) * 0.08; f.scale.x = Math.abs(f.scale.x) > 0 ? (f.userData.sx ?? (f.userData.sx = f.scale.x)) * k : f.scale.x; f.scale.z = (f.userData.sz ?? (f.userData.sz = f.scale.z)) * k; }
      const stunned = tw.stun > 0;
      tv.stun.visible = stunned;
      if (stunned) { tv.stun.position.set(m.group.position.x, m.muzzleY * base + 0.45, m.group.position.z); tv.stun.rotation.z = t * 5; if (Math.random() < dt * 6) P.emit(m.group.position.x, m.muzzleY, m.group.position.z, 0xfff06b, 1, { speed: 0.6, life: 0.4, size: 0.12 }); }
      if (tw.tier >= 4 && Math.random() < dt * (tw.tier - 3) * 2) P.emit(m.group.position.x, 0.3, m.group.position.z, TOWERS[tw.def].look.accent, 1, { speed: 0.3, up: 1.2, life: 0.8, size: 0.1, gravity: 0, spread: 0.6 });
    }
    for (const [id, tv] of this.towers) if (!seen.has(id)) { this.dyn.remove(tv.model.group, tv.stun); this.towers.delete(id); }

    // Events (after towers exist, before enemies are released)
    if (b.events.length) {
      for (const ev of b.events) this.handle(ev, b);
    }

    // Enemies
    const alive = new Set<number>();
    const lerp = 1 - Math.exp(-dt * 18);
    for (const e of b.s.enemies) {
      alive.add(e.id);
      let v = this.enemies.get(e.id);
      if (!v) {
        v = this.getEnemyView(e.def);
        v.x = e.x; v.z = e.y; v.spawn = 0.3;
        this.enemies.set(e.id, v);
        P.emit(e.x, 0.4, e.y, 0x9b4de0, 5, { speed: 1, life: 0.35, size: 0.16 });
      }
      this.updateEnemy(v, e, dt, lerp, t);
    }
    for (const [id, v] of this.enemies) if (!alive.has(id)) { this.releaseEnemy(v); this.enemies.delete(id); }

    // Projectiles
    const live = new Set<number>();
    for (const p of b.s.projs) {
      live.add(p.id);
      let pv = this.projs.get(p.id);
      const d = Math.hypot(p.lx - p.x, p.ly - p.y);
      if (!pv) {
        const tv = this.towers.get(p.tower);
        pv = { mesh: this.getProj(p.look, p.el), kind: p.look, d0: Math.max(0.2, d), y0: tv ? tv.model.muzzleY * tv.model.group.scale.y : 0.8 };
        this.projs.set(p.id, pv);
      }
      const k = Math.min(1, Math.max(0, 1 - d / pv.d0));
      const target = b.s.enemies.find((e) => e.id === p.target);
      const ty = target?.fly ? FLY_H : 0.35;
      const arc = p.splash > 0 ? Math.sin(k * Math.PI) * 0.9 : 0;
      const y = pv.y0 + (ty - pv.y0) * k + arc;
      pv.mesh.position.set(p.x, y, p.y);
      if (pv.mesh.userData.kind === 'arrow') pv.mesh.lookAt(p.lx, ty, p.ly);
      if (p.el !== 'physical' && Math.random() < dt * 30) P.emit(p.x, y, p.y, EL_COLOR[p.el], 1, { speed: 0.3, life: 0.25, size: 0.1, gravity: 0 });
    }
    for (const [id, pv] of this.projs) if (!live.has(id)) {
      pv.mesh.visible = false;
      const k = pv.mesh.userData.kind as string;
      let pool = this.projPool.get(k);
      if (!pool) this.projPool.set(k, (pool = []));
      pool.push(pv.mesh);
      this.projs.delete(id);
    }

    // Timed effects
    for (const s of this.segs) if (s.life > 0) { s.life -= dt; const k = Math.max(0, s.life / s.max); s.mesh.scale.x = s.mesh.scale.y = s.w * k; if (s.life <= 0) s.mesh.visible = false; }
    for (const r of this.rings) if (r.life > 0) { r.life -= dt; const k = 1 - Math.max(0, r.life / r.max); r.mesh.scale.setScalar(r.r0 + (r.r1 - r.r0) * k); r.mat.opacity = 0.8 * (1 - k); if (r.life <= 0) r.mesh.visible = false; }
    P.update(dt);

    // Slot highlights
    if (this.hl) {
      const pulse = 0.55 + Math.sin(t * 6) * 0.2;
      this.slotMats.forEach((m, i) => {
        const k = this.hl!.get(i);
        if (!k) { m.opacity = 0; return; }
        m.color.setHex(k === 'free' ? 0x7dff9a : k === 'merge' ? 0xfff06b : k === 'hybrid' ? 0xff7df2 : k === 'hover' ? 0xffffff : 0xff5c5c);
        m.opacity = k === 'hover' ? 0.95 : pulse;
        this.slotRings[i].scale.setScalar(k === 'hover' ? 1.15 : 1 + Math.sin(t * 6) * 0.05);
      });
    }
    // Selection ring
    const sel = this.selected ? b.tower(this.selected) : undefined;
    this.selRing.visible = !!sel;
    if (sel) { const s = b.slotPos(sel.slot); this.selRing.position.set(s.x, 0.1, s.y); this.selRing.scale.setScalar(0.5 + Math.sin(t * 5) * 0.03); }

    // Castle & portals
    if (this.castle) {
      if (this.castleFlash > 0) this.castleFlash -= dt;
      const k = Math.max(0, this.castleFlash) * 2;
      this.castle.scale.setScalar(1 + Math.sin(k * 20) * 0.03 * k);
      const flag = this.castle.getObjectByName('flag');
      if (flag) flag.rotation.y = Math.sin(t * 3) * 0.4;
    }
    for (const p of this.portals) p.rotation.z = t * 1.5;

    if (this.shakeT > 0) { this.shakeT -= dt; if (this.shakeT <= 0) this.shakeAmp = 0; }
    this.applyCamera();
    this.renderer.render(this.scene, this.camera);
  }

  private updateEnemy(v: EnemyView, e: EnemyState, dt: number, lerp: number, t: number): void {
    const d = ENEMIES[e.def], m = v.model, s = d.look.size;
    const nx = v.x + (e.x - v.x) * lerp, nz = v.z + (e.y - v.z) * lerp;
    const dx = nx - v.x, dz = nz - v.z;
    if (dx * dx + dz * dz > 1e-7) {
      const want = Math.atan2(dx, dz);
      let diff = want - v.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      v.yaw += diff * Math.min(1, dt * 10);
    }
    v.x = nx; v.z = nz;
    const frozen = e.freezeT > 0;
    if (!frozen) v.phase += dt * (6 + d.speed * 5) * (1 - e.chillPct * 0.6);
    const ph = v.phase;
    let y = 0;
    if (e.fly) y = FLY_H - s * 0.4 + Math.sin(ph * 0.5) * 0.06;
    else if (m.shape === 'ghost') y = 0.12 + Math.sin(ph * 0.4) * 0.06;
    else if (m.shape === 'blob') y = Math.abs(Math.sin(ph * 0.6)) * 0.1;
    else y = Math.abs(Math.sin(ph)) * 0.035;
    if (v.spawn > 0) v.spawn = Math.max(0, v.spawn - dt);
    const grow = 1 - v.spawn / 0.3 * 0.6;
    m.group.position.set(nx, y, nz);
    m.group.rotation.y = v.yaw;
    m.group.scale.setScalar(grow);
    if (m.shape === 'blob') { const q = 1 + Math.sin(ph * 1.2) * 0.1; m.body.scale.set(1 / q, q, 1 / q); }
    for (let i = 0; i < m.legs.length; i++) m.legs[i].rotation.x = Math.sin(ph + (i % 2) * Math.PI) * 0.55;
    for (let i = 0; i < m.wings.length; i++) m.wings[i].rotation.z = Math.sin(ph * 1.3) * 0.6 * (i ? -1 : 1);
    // Ground ring doubles as a shadow and as the status indicator.
    const st = e.freezeT > 0 ? 0x7de3ff : e.burnT > 0 ? 0xff7b2e : e.poisonT > 0 ? 0x9be03c : e.chillT > 0 ? 0x7de3ff : e.markT > 0 ? 0xd67dff : e.enraged ? 0xff3c2e : 0;
    v.ring.visible = true;
    v.ring.position.set(nx, 0.02, nz);
    v.ringMat.color.setHex(st);
    v.ringMat.opacity = st ? 0.55 : 0.22;
    if (this.settings.fx > 0) {
      if (e.burnT > 0 && Math.random() < dt * 8) this.particles.emit(nx, y + s, nz, 0xff7b2e, 1, { speed: 0.4, up: 1.2, life: 0.4, size: 0.13, gravity: 0, spread: s });
      if (e.poisonT > 0 && Math.random() < dt * 5) this.particles.emit(nx, y + s, nz, 0x9be03c, 1, { speed: 0.3, up: 0.8, life: 0.5, size: 0.12, gravity: 0, spread: s });
      if (e.chillT > 0 && !frozen && Math.random() < dt * 4) this.particles.emit(nx, y + s * 1.5, nz, 0xe4f6ff, 1, { speed: 0.3, life: 0.5, size: 0.1, gravity: 1, spread: s });
    }
    v.ice.visible = frozen;
    if (frozen) v.ice.position.set(nx, y + m.height * 0.45, nz);
    v.shield.visible = e.shieldT > 0;
    if (e.shieldT > 0) { v.shield.position.set(nx, y + m.height * 0.45, nz); v.shield.scale.setScalar(Math.max(m.height * 0.62, s * 1.9) * (1 + Math.sin(t * 8) * 0.04)); }
    // HP bar
    const show = e.boss || e.hp < e.maxHp;
    v.hpBg.visible = v.hpFill.visible = show;
    if (show) {
      const bw = e.boss ? 1.1 : 0.5, top = y + m.height + 0.18;
      v.hpBg.position.set(nx, top, nz);
      v.hpFill.position.set(nx, top, nz).addScaledVector(this.right, -bw / 2);
      const k = Math.max(0, e.hp / e.maxHp);
      v.hpFill.scale.x = Math.max(0.001, bw * k);
      if (!e.boss) (v.hpFill.material as THREE.SpriteMaterial).color.setHex(k > 0.5 ? 0x6fe06b : k > 0.25 ? 0xf2c94c : 0xff5c5c);
    }
  }

  /** Renders a tower model alone on a transparent background (collection / merge previews). */
  dispose(): void {
    this.clearDynamic();
    this.particles.dispose();
    this.renderer.dispose();
    this.textPool.forEach((e) => e.remove());
  }
}

export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  const units = ['K', 'M', 'B', 'T', 'Qa'];
  let u = -1, v = a;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  return (n < 0 ? '-' : '') + (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + units[u];
}
