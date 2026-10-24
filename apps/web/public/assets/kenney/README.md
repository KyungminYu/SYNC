# Kenney assets (CC0)

Pixel-art sprites for the dashboard shop floor (16 × 16 tiles, drawn at 3×).

| File                    | Pack                                                                                                                           | Layout                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `rpg-urban.png`         | [RPG Urban Pack](https://kenney.nl/assets/rpg-urban-pack) — characters (4 directions × idle/walk), floor tiles, rope           | 27 × 18 frames, no spacing                                 |
| `guests.png`            | Generated from RPG Urban Pack by `scripts/assets/make_guest_sprites.py`: 10 customer looks (rows **a–j**, clothing recoloured) | 12 × 10 frames (row = kind, 4 directions × idle/walk/walk) |
| `roguelike-indoors.png` | [Roguelike Indoors](https://kenney.nl/assets/roguelike-indoors) — counters, machine, sink, plants, mats                        | 27 × 18 frames, 1 px spacing                               |

Both packs are Creative Commons Zero (see the LICENSE files); credit "Kenney.nl" is appreciated but not required.
Frame indices used by the dashboard live in `apps/web/src/dashboard/floor/sprites.ts`. Each customer gets a guest kind (a–j) from a seeded random draw on the run seed and customer id (`guestKind` in `dashboard/model/scene.ts`).
