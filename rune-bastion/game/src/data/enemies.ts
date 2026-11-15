import type { EnemyDef, EnemyTag } from '../core/types';

/**
 * Enemy roster. Each world re-skins the shared archetypes and adds its own twists;
 * bosses are authored and balanced separately at the bottom.
 */

type Arch = Pick<EnemyDef, 'hp' | 'speed' | 'armor' | 'bounty' | 'leak' | 'threat'> & { tags: EnemyTag[] };

const ARCH: Record<string, Arch> = {
  grunt: { tags: ['ground'], hp: 30, speed: 0.95, armor: 0, bounty: 5, leak: 1, threat: 1 },
  fast: { tags: ['ground', 'fast'], hp: 18, speed: 1.75, armor: 0, bounty: 5, leak: 1, threat: 1 },
  armored: { tags: ['ground', 'armored'], hp: 85, speed: 0.68, armor: 4, bounty: 13, leak: 2, threat: 3 },
  flying: { tags: ['flying'], hp: 24, speed: 1.15, armor: 0, bounty: 7, leak: 1, threat: 1.5 },
  magic: { tags: ['ground', 'magic'], hp: 48, speed: 0.8, armor: 0, bounty: 11, leak: 2, threat: 2.5 },
  elite: { tags: ['ground', 'elite'], hp: 170, speed: 0.8, armor: 1, bounty: 22, leak: 3, threat: 5 },
  special: { tags: ['ground', 'special'], hp: 55, speed: 0.85, armor: 0, bounty: 9, leak: 1, threat: 2.5 },
};

/** Magic enemies shrug off elements but are brittle against steel. */
const MAGIC_RESIST = { fire: 0.6, ice: 0.6, poison: 0.6, lightning: 0.6, physical: 1.3 };

function mk(id: string, world: number, arch: keyof typeof ARCH, look: EnemyDef['look'], over: Partial<EnemyDef> = {}): EnemyDef {
  const a = ARCH[arch];
  const { tags: extraTags, ...rest } = over;
  return {
    id, world, hp: a.hp, speed: a.speed, armor: a.armor,
    resist: arch === 'magic' ? { ...MAGIC_RESIST } : {}, bounty: a.bounty, leak: a.leak, threat: a.threat, look,
    ...rest,
    tags: [...a.tags, ...(extraTags ?? [])],
  };
}

const list: EnemyDef[] = [
  // ---- World 1: Greenvale ----
  mk('goblin', 1, 'grunt', { shape: 'biped', color: 0xc9d44a, accent: 0x7a3b2a, size: 0.34, extras: ['ears'] }),
  mk('wolf', 1, 'fast', { shape: 'quad', color: 0x8a8f99, accent: 0x4a4e57, size: 0.32 }),
  mk('ogre', 1, 'armored', { shape: 'biped', color: 0xb8a86a, accent: 0x6b6f7a, size: 0.5, extras: ['armor', 'club'] }),
  mk('bat', 1, 'flying', { shape: 'flyer', color: 0x5b3f6e, accent: 0x2c1f38, size: 0.28 }),
  mk('shaman', 1, 'magic', { shape: 'biped', color: 0x4f9d8a, accent: 0xc94fd6, size: 0.36, extras: ['staff', 'hood'] },
    { abilities: [{ type: 'heal_aura', radius: 1.6, pctPerSec: 0.025 }] }),
  mk('slime', 1, 'special', { shape: 'blob', color: 0x4fd6c9, accent: 0x2f8f8a, size: 0.42 },
    { abilities: [{ type: 'split', into: 'slimelet', count: 2 }] }),
  mk('slimelet', 1, 'grunt', { shape: 'blob', color: 0x7fe8dc, accent: 0x2f8f8a, size: 0.26 }, { hp: 16, bounty: 2, threat: 0.5 }),
  mk('champion', 1, 'elite', { shape: 'biped', color: 0xa9b82f, accent: 0x8a2f2f, size: 0.48, extras: ['ears', 'armor', 'banner'] },
    { abilities: [{ type: 'haste_aura', radius: 1.6, pct: 0.2 }] }),

  // ---- World 2: Frostpeak ----
  mk('frostling', 2, 'grunt', { shape: 'biped', color: 0x8fd3f2, accent: 0x3d6f96, size: 0.34, extras: ['horns'] }, { resist: { ice: 0.6, fire: 1.3 } }),
  mk('snowwolf', 2, 'fast', { shape: 'quad', color: 0xf0f6fa, accent: 0x9fb7c6, size: 0.33 }, { resist: { ice: 0.7 } }),
  mk('icegolem', 2, 'armored', { shape: 'golem', color: 0x7fb4d9, accent: 0xdaf3ff, size: 0.52 }, { resist: { ice: 0.5, fire: 1.4 }, armor: 5 }),
  mk('wyvern', 2, 'flying', { shape: 'flyer', color: 0x6fa3c9, accent: 0xe4f6ff, size: 0.34 }, { resist: { ice: 0.7 } }),
  mk('icewitch', 2, 'magic', { shape: 'biped', color: 0x5d7fd1, accent: 0xbfeaff, size: 0.36, extras: ['staff', 'hood'] },
    { abilities: [{ type: 'haste_aura', radius: 1.8, pct: 0.25 }] }),
  mk('wisp', 2, 'special', { shape: 'ghost', color: 0xbfeaff, accent: 0x6fd0ff, size: 0.3 },
    { abilities: [{ type: 'blink', every: 5, dist: 1.6 }], hp: 40 }),
  mk('yeti', 2, 'elite', { shape: 'biped', color: 0xe9f1f5, accent: 0x7fb4d9, size: 0.52, extras: ['horns', 'club'] },
    { resist: { ice: 0.6, fire: 1.25 }, abilities: [{ type: 'regen', pctPerSec: 0.012 }] }),

  // ---- World 3: Ember Wastes ----
  mk('imp', 3, 'grunt', { shape: 'biped', color: 0xd9502f, accent: 0x5a1e12, size: 0.32, extras: ['horns', 'tail'] }, { resist: { fire: 0.6, ice: 1.3 } }),
  mk('hellhound', 3, 'fast', { shape: 'quad', color: 0x7a2416, accent: 0xff8a2e, size: 0.34 }, { resist: { fire: 0.6 } }),
  mk('magmabrute', 3, 'armored', { shape: 'golem', color: 0x4a3a36, accent: 0xff6a1f, size: 0.54 }, { resist: { fire: 0.5, ice: 1.4 }, armor: 5 }),
  mk('drake', 3, 'flying', { shape: 'flyer', color: 0xc9401f, accent: 0xffc23e, size: 0.36 }, { resist: { fire: 0.6 } }),
  mk('pyromancer', 3, 'magic', { shape: 'biped', color: 0x8f2f4a, accent: 0xffb23e, size: 0.36, extras: ['staff', 'hood'] },
    { abilities: [{ type: 'heal_aura', radius: 1.6, pctPerSec: 0.03 }] }),
  mk('lavaspawn', 3, 'special', { shape: 'blob', color: 0xff6a1f, accent: 0x4a2a1f, size: 0.44 },
    { resist: { fire: 0.5, ice: 1.3 }, abilities: [{ type: 'split', into: 'cinder', count: 3 }] }),
  mk('cinder', 3, 'fast', { shape: 'blob', color: 0xffa23e, accent: 0x4a2a1f, size: 0.22 }, { hp: 12, bounty: 2, threat: 0.5, resist: { fire: 0.5 } }),
  mk('warlord', 3, 'elite', { shape: 'biped', color: 0x9a2a1c, accent: 0x2f3136, size: 0.5, extras: ['horns', 'armor', 'club'] },
    { armor: 3, resist: { fire: 0.7 }, abilities: [{ type: 'enrage', below: 0.5, speedMul: 1.6 }] }),

  // ---- World 4: Shadow Mire ----
  mk('skeleton', 4, 'grunt', { shape: 'biped', color: 0xe6e0cf, accent: 0x5a554a, size: 0.33, extras: ['skull'] }, { tags: ['undead'], resist: { poison: 0.6 } }),
  mk('ghoul', 4, 'fast', { shape: 'quad', color: 0x6f8f6a, accent: 0x2f3f2c, size: 0.33 }, { tags: ['undead'], resist: { poison: 0.6 } }),
  mk('boneknight', 4, 'armored', { shape: 'biped', color: 0xd9d2bd, accent: 0x4b4f63, size: 0.5, extras: ['skull', 'armor', 'shield'] },
    { tags: ['undead'], armor: 6, resist: { poison: 0.5, light: 1.2 } }),
  mk('wraith', 4, 'flying', { shape: 'ghost', color: 0x6a4fa3, accent: 0xc9a6ff, size: 0.36 },
    { tags: ['undead', 'magic'], resist: { physical: 0.6, poison: 0.5, light: 1.4, arcane: 1.2 } }),
  mk('necromancer', 4, 'magic', { shape: 'biped', color: 0x3d2f5a, accent: 0x7dff9a, size: 0.38, extras: ['staff', 'hood'] },
    { abilities: [{ type: 'summon', every: 8, count: 1, enemy: 'skeleton' }], threat: 3.5 }),
  mk('abomination', 4, 'elite', { shape: 'golem', color: 0x6f8f5a, accent: 0x8f3f4a, size: 0.56 },
    { tags: ['undead'], resist: { poison: 0.5 }, abilities: [{ type: 'regen', pctPerSec: 0.015 }] }),
  mk('shade', 4, 'special', { shape: 'ghost', color: 0x2f2a3d, accent: 0xff5c7a, size: 0.32 },
    { tags: ['undead'], abilities: [{ type: 'blink', every: 4, dist: 1.8 }], resist: { physical: 0.75, light: 1.4 } }),

  // ---- Bosses (hp is tuned separately from the level multiplier, see waves.ts BOSS_HP_SCALE) ----
  {
    id: 'boss_grumbak', world: 1, tags: ['ground', 'boss'], hp: 1500, speed: 0.42, armor: 2, resist: { poison: 0.8 },
    bounty: 120, leak: 15, threat: 20,
    abilities: [{ type: 'summon', every: 8, count: 3, enemy: 'goblin' }, { type: 'haste_aura', radius: 2.2, pct: 0.3 }],
    look: { shape: 'biped', color: 0x9fb02a, accent: 0x7a2f2f, size: 0.85, extras: ['ears', 'crown', 'club', 'armor'] },
  },
  {
    id: 'boss_hrimgar', world: 2, tags: ['ground', 'boss'], hp: 2100, speed: 0.4, armor: 4, resist: { ice: 0.4, fire: 1.3 },
    bounty: 160, leak: 15, threat: 24,
    abilities: [{ type: 'shield', every: 11, dur: 3.5, reduce: 0.85 }, { type: 'stun_towers', every: 9, count: 2, dur: 3 }],
    look: { shape: 'golem', color: 0x8fc6ea, accent: 0xffffff, size: 0.95, extras: ['crown', 'horns'] },
  },
  {
    id: 'boss_ignarok', world: 3, tags: ['flying', 'boss'], hp: 2000, speed: 0.36, armor: 2, resist: { fire: 0.4, ice: 1.3, lightning: 1.15 },
    bounty: 200, leak: 15, threat: 28,
    abilities: [{ type: 'enrage', below: 0.4, speedMul: 1.7 }, { type: 'stun_towers', every: 8, count: 3, dur: 2.5 }, { type: 'summon', every: 12, count: 2, enemy: 'drake' }],
    look: { shape: 'dragon', color: 0xb8321a, accent: 0xffc23e, size: 0.95, extras: ['horns'] },
  },
  {
    id: 'boss_morvane', world: 4, tags: ['ground', 'boss', 'undead', 'magic'], hp: 2300, speed: 0.38, armor: 2,
    resist: { poison: 0.5, fire: 0.8, ice: 0.8, lightning: 0.8, light: 1.35, physical: 1.1 },
    bounty: 260, leak: 15, threat: 32,
    abilities: [{ type: 'summon', every: 7, count: 3, enemy: 'skeleton' }, { type: 'heal_aura', radius: 2.4, pctPerSec: 0.03 }, { type: 'shield', every: 14, dur: 3, reduce: 0.9 }, { type: 'blink', every: 16, dist: 1.2 }],
    look: { shape: 'ghost', color: 0x3d2f5a, accent: 0x7dff9a, size: 0.95, extras: ['crown', 'staff'] },
  },
];

export const ENEMIES: Record<string, EnemyDef> = Object.fromEntries(list.map((e) => [e.id, e]));
export const BOSS_IDS = list.filter((e) => e.tags.includes('boss')).map((e) => e.id);
