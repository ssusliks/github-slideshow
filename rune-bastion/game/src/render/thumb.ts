import * as THREE from 'three';
import type { EnemyDef, TowerDef } from '../core/types';
import { buildCastle, buildEnemy, buildTower } from './models';

/**
 * Renders small portraits of towers / enemies with a shared offscreen WebGL renderer and
 * caches them as data URLs, so menus show the real models without shipping any image files.
 */
const cache = new Map<string, string>();
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene, camera: THREE.OrthographicCamera, holder: THREE.Group;
let failed = false;
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

function ensure(): boolean {
  if (failed) return false;
  if (renderer) return true;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 160;
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setClearColor(0x000000, 0);
    scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x6a7a8a, 1.3));
    const sun = new THREE.DirectionalLight(0xfff4dd, 1.7);
    sun.position.set(-3, 6, 5);
    scene.add(sun);
    camera = new THREE.OrthographicCamera(-0.62, 0.62, 0.62, -0.62, 0.1, 50);
    camera.position.set(2.2, 2.6, 4.4);
    holder = new THREE.Group();
    scene.add(holder);
    return true;
  } catch {
    failed = true;
    return false;
  }
}

function shoot(obj: THREE.Object3D, height: number, zoom: number): string {
  holder.clear();
  holder.add(obj);
  const half = Math.max(0.5, height * 0.62) * zoom;
  camera.left = -half; camera.right = half; camera.top = half; camera.bottom = -half;
  camera.lookAt(0, height * 0.5, 0);
  camera.updateProjectionMatrix();
  renderer!.render(scene, camera);
  const url = renderer!.domElement.toDataURL('image/png');
  holder.clear();
  return url;
}

export function towerThumb(def: TowerDef, tier = 1, branch: string | null = null): string {
  const key = `t:${def.id}:${tier}:${branch}`;
  let url = cache.get(key);
  if (url) return url;
  if (!ensure()) return BLANK;
  const m = buildTower(def, tier, branch);
  url = shoot(m.group, (m.muzzleY + 0.45) * m.group.scale.y, 1);
  cache.set(key, url);
  return url;
}

export function enemyThumb(def: EnemyDef): string {
  const key = `e:${def.id}`;
  let url = cache.get(key);
  if (url) return url;
  if (!ensure()) return BLANK;
  const m = buildEnemy(def);
  m.group.rotation.y = 0.5;
  const flying = m.shape === 'flyer' || m.shape === 'dragon';
  if (flying) m.group.position.y = m.height * 0.5;
  url = shoot(m.group, Math.max(m.height, def.look.size * 3) * (flying ? 1.2 : 1), flying ? 1.5 : 1.05);
  cache.set(key, url);
  return url;
}

export function castleThumb(world: import('../core/types').WorldDef, skin: string): string {
  const key = `c:${world.id}:${skin}`;
  let url = cache.get(key);
  if (url) return url;
  if (!ensure()) return BLANK;
  const g = buildCastle(world, skin);
  g.rotation.y = -0.5;
  url = shoot(g, 2.0, 1.05);
  cache.set(key, url);
  return url;
}
