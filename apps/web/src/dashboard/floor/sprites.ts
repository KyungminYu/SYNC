/**
 * Sprite sheets and frame indices for the pixel-art shop floor
 * (apps/web/public/assets/kenney, CC0). Tiles are 16 × 16 and drawn at 3×.
 */
import type { ResourceType, Role } from '../../sync/contract';
import { GUEST_KINDS, type Facing, type GuestKind } from '../model/scene';

/** Source tile size and on-screen scale. */
export const TILE = 16;
export const SCALE = 3;
export const TILE_PX = TILE * SCALE;

/** Texture keys and URLs (served from Vite's public folder). */
export const SHEETS = {
  urban: {
    key: 'kenney-urban',
    url: '/assets/kenney/rpg-urban.png',
    spacing: 0,
  },
  indoors: {
    key: 'kenney-indoors',
    url: '/assets/kenney/roguelike-indoors.png',
    spacing: 1,
  },
  guests: {
    key: 'kenney-guests',
    url: '/assets/kenney/guests.png',
    spacing: 0,
  },
} as const;

/** Frames per row in the two Kenney sheets. */
const KENNEY_COLS = 27;

const DIR: Record<Facing, number> = { left: 0, down: 1, up: 2, right: 3 };

/** Walk cycle: step, idle, other step, idle (frame rows 1, 0, 2, 0). */
export const WALK_CYCLE = [1, 0, 2, 0];

/** Staff characters in rpg-urban.png: frame of (left, idle) for each role. */
const STAFF_BASE: Record<Role, number> = {
  cashier: 104, // red top
  barista: 428, // headband
  server: 185, // blue hair
  cleaner: 23, // green shirt
};

/** Frame in rpg-urban.png for a staff member facing a direction. anim: 0 idle, 1–2 walk. */
export function staffFrame(role: Role, facing: Facing, anim: number) {
  return STAFF_BASE[role] + anim * KENNEY_COLS + DIR[facing];
}

/** Frame in guests.png for guest kind a–j (one row of 12 frames per kind). */
export function guestFrame(kind: GuestKind, facing: Facing, anim: number) {
  return GUEST_KINDS.indexOf(kind) * 12 + anim * 4 + DIR[facing];
}

/** Furniture in roguelike-indoors.png. */
export const FURNITURE = {
  counter: 325,
  counterBack: 324,
  plantA: 16,
  plantB: 17,
} as const;

/** What each slot type looks like. */
export const SLOT_FRAME: Record<ResourceType, number> = {
  register: 331, // counter with till
  bar: 393, // espresso machine
  pickup: 355, // counter with tray
  clean: 332, // sink
};

/** Floor and rope tiles in rpg-urban.png. */
export const URBAN = {
  stone: 109,
  ropeLeft: 244,
  ropeMid: 245,
  ropeRight: 246,
  doorOpen: 312, // open glass double door (front wall)
} as const;
