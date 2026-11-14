import * as THREE from 'three';

/**
 * Single pooled point-sprite particle system (one draw call). The pool size is the hard
 * budget chosen by the quality preset; emit() silently drops particles when it is full.
 */
export class Particles {
  readonly points: THREE.Points;
  private max: number;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grav: Float32Array;
  private size0: Float32Array;
  private cursor = 0;
  alive = 0;
  /** 0..1 multiplier from the "effects intensity" setting and adaptive quality. */
  intensity = 1;
  private tmp = new THREE.Color();

  constructor(max: number) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.size0 = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 400 } },
      vertexShader: `
        attribute vec4 pcolor; attribute float psize; uniform float scale; varying vec4 vc;
        void main() { vc = pcolor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = psize * scale * projectionMatrix[1][1]; }`,
      fragmentShader: `
        varying vec4 vc;
        void main() { vec2 d = gl_PointCoord - 0.5; float r = dot(d, d); if (r > 0.25) discard; gl_FragColor = vec4(vc.rgb, vc.a * (1.0 - r * 2.4)); }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
  }

  /** `halfHeightPx` = half of the drawing-buffer height; converts world sizes to point sizes. */
  setScale(halfHeightPx: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = halfHeightPx;
  }

  emit(x: number, y: number, z: number, color: number, count: number, opt: { speed?: number; up?: number; life?: number; size?: number; gravity?: number; spread?: number } = {}): void {
    const n = Math.round(count * this.intensity);
    if (n <= 0) return;
    const speed = opt.speed ?? 1.5, life = opt.life ?? 0.5, size = opt.size ?? 0.16, spread = opt.spread ?? 0.1;
    this.tmp.setHex(color);
    for (let k = 0; k < n; k++) {
      // Find a dead slot starting from the cursor; give up quickly when the pool is saturated.
      let i = -1;
      for (let t = 0; t < 8; t++) {
        const c = (this.cursor + t) % this.max;
        if (this.life[c] <= 0) { i = c; break; }
      }
      this.cursor = (this.cursor + 1) % this.max;
      if (i < 0) return;
      const a = Math.random() * Math.PI * 2, e = Math.random() * 2 - 1, sp = speed * (0.4 + Math.random() * 0.6);
      const h = Math.sqrt(1 - e * e);
      this.pos[i * 3] = x + (Math.random() - 0.5) * spread;
      this.pos[i * 3 + 1] = y + (Math.random() - 0.5) * spread;
      this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * spread;
      this.vel[i * 3] = Math.cos(a) * h * sp;
      this.vel[i * 3 + 1] = Math.abs(e) * sp + (opt.up ?? 0);
      this.vel[i * 3 + 2] = Math.sin(a) * h * sp;
      const shade = 0.8 + Math.random() * 0.4;
      this.col[i * 4] = Math.min(1, this.tmp.r * shade);
      this.col[i * 4 + 1] = Math.min(1, this.tmp.g * shade);
      this.col[i * 4 + 2] = Math.min(1, this.tmp.b * shade);
      this.col[i * 4 + 3] = 1;
      this.life[i] = this.maxLife[i] = life * (0.7 + Math.random() * 0.6);
      this.size0[i] = size * (0.7 + Math.random() * 0.6);
      this.grav[i] = opt.gravity ?? 3;
    }
  }

  update(dt: number): void {
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.size[i] = 0; this.col[i * 4 + 3] = 0; continue; }
      alive++;
      this.vel[i * 3 + 1] -= this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const k = this.life[i] / this.maxLife[i];
      this.size[i] = this.size0[i] * (0.4 + 0.6 * k);
      this.col[i * 4 + 3] = Math.min(1, k * 2);
    }
    this.alive = alive;
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.pcolor.needsUpdate = true;
    g.attributes.psize.needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
