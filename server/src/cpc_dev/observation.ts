import type { GunDef } from "../../../shared/defs/gameObjects/gunDefs.ts";
import { GameObjectDefs } from "../../../shared/defs/register.ts";
import { GameConfig } from "../../../shared/gameConfig.ts";
import { ObjectType } from "../../../shared/net/objectSerializeFns.ts";
import { collider } from "../../../shared/utils/collider.ts";
import { util } from "../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Game } from "../game/game.ts";
import type { Building } from "../game/objects/building.ts";
import type { DeadBody } from "../game/objects/deadBody.ts";
import type { Loot } from "../game/objects/loot.ts";
import type { Obstacle } from "../game/objects/obstacle.ts";
import type { Player } from "../game/objects/player.ts";

/** Inventory slots surfaced to the agent (the ones that matter on the field scenario). */
export const observedInventory = [
    "bandage",
    "healthkit",
    "soda",
    "painkiller",
    "762mm",
    "9mm",
    "12gauge",
    "556mm",
] as const;

/**
 * Gunshot audible radius in world units. The client plays another player's shot on the
 * `otherPlayers` channel, whose `maxRange` is 48 with the default `rangeMult` of 1, so 48 u is
 * what a human can hear. It reaches past the view rectangle (zoom 28 -> 32 u half-width), which
 * is why heard shots are their own observation channel instead of being implied by `bullets`.
 */
export const shotsHeardRadius = 48;

/** near / mid / far split the audible radius into thirds. */
const nearRange = shotsHeardRadius / 3;
const midRange = (2 * shotsHeardRadius) / 3;

/** 8 compass points in world space, where y grows upward (N = +y) — not screen space. */
const compass = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"] as const;

export interface ShotHeard {
    dir: (typeof compass)[number];
    range: "near" | "mid" | "far";
}

/** Buckets one shot for a listener, or null when the shot is out of earshot. */
export function hearShot(listener: Vec2, shot: Vec2): ShotHeard | null {
    const offset = v2.sub(shot, listener);
    const dist = v2.length(offset);
    if (dist > shotsHeardRadius) return null;
    const index = (Math.round(Math.atan2(offset.y, offset.x) / (Math.PI / 4)) + 8) % 8;
    return {
        dir: compass[index],
        range: dist <= nearRange ? "near" : dist <= midRange ? "mid" : "far",
    };
}

export interface AgentObservation {
    self: {
        id: string;
        team: string;
        pos: Vec2;
        dir: Vec2;
        hp: number;
        boost: number;
        downed: boolean;
        dead: boolean;
        weapon: string;
        clip: number;
        reserve: number;
        weapons: Array<{ slot: number; type: string; ammo: number }>;
        inventory: Record<string, number>;
        scope: string;
        zoom: number;
        action: number;
        cur_weap_idx: number;
    };
    teammates: Array<{ id: string; pos: Vec2; dist: number; hp: number; downed: boolean; dead: boolean }>;
    players: Array<{
        id: string;
        team: string;
        pos: Vec2;
        dist: number;
        dir: Vec2;
        downed: boolean;
        dead: boolean;
        weapon: string;
        /** a shot at it would hit something else first */
        los_blocked: boolean;
    }>;
    loot: Array<{ id: number; type: string; pos: Vec2; dist: number; count: number }>;
    /** distance to the first bullet-stopper in each of `rayCount` directions, E first, counter-clockwise */
    rays: number[];
    /** whole structures in view; their walls also arrive as obstacles, this is the thing to name */
    buildings: Array<{ id: number; type: string; pos: Vec2; dist: number }>;
    obstacles: Array<{
        id: number;
        type: string;
        pos: Vec2;
        dist: number;
        collidable: boolean;
        height: number;
        scale: number;
        /** it sits on the line between this agent and the nearest standing enemy */
        blocks_los: boolean;
        /** 1 when stepping behind it would break that line, 0 otherwise */
        cover_score: number;
    }>;
    bullets: Array<{ pos: Vec2; dir: Vec2; player_id: number }>;
    dead_bodies: Array<{ pos: Vec2; dist: number }>;
    gas: { mode: number; rad: number; pos: Vec2; rad_new: number; pos_new: Vec2 };
    alive_count: number;
    alive_teams: number;
    /** shared objective point (race mode), shown to every agent like a HUD marker; null when there is none */
    objective: { index: number; pos: Vec2; radius: number; dist: number } | null;
    /** other players' shots within earshot since the previous observation (8-point compass, world y-up) */
    shots_heard: ShotHeard[];
}

/** Allowlist of every key an observation may contain, checked by tests so nothing leaks past the schema. */
export const observationAllowlist = {
    "": [
        "self",
        "teammates",
        "players",
        "loot",
        "obstacles",
        "buildings",
        "rays",
        "bullets",
        "dead_bodies",
        "gas",
        "alive_count",
        "alive_teams",
        "objective",
        "shots_heard",
    ],
    self: [
        "id",
        "team",
        "pos",
        "dir",
        "hp",
        "boost",
        "downed",
        "dead",
        "weapon",
        "clip",
        "reserve",
        "weapons",
        "inventory",
        "scope",
        "zoom",
        "action",
        "cur_weap_idx",
    ],
    "self.weapons": ["slot", "type", "ammo"],
    "self.inventory": [...observedInventory],
    teammates: ["id", "pos", "dist", "hp", "downed", "dead"],
    players: ["id", "team", "pos", "dist", "dir", "downed", "dead", "weapon", "los_blocked"],
    loot: ["id", "type", "pos", "dist", "count"],
    obstacles: ["id", "type", "pos", "dist", "collidable", "height", "scale", "blocks_los", "cover_score"],
    buildings: ["id", "type", "pos", "dist"],
    bullets: ["pos", "dir", "player_id"],
    dead_bodies: ["pos", "dist"],
    gas: ["mode", "rad", "pos", "rad_new", "pos_new"],
    objective: ["index", "pos", "radius", "dist"],
    shots_heard: ["dir", "range"],
    vec2: ["x", "y"],
} as const;

export interface ObservationIds {
    /** native player id -> agent id; players outside the map fall back to their in-game name */
    agentIdOf: (player: Player) => string;
    teamIdOf: (player: Player) => string;
}

function vec(v: Vec2): Vec2 {
    return { x: v.x, y: v.y };
}

/**
 * Builds what this player's client would know right now. Call it after `game.netSync()` so
 * `player.visibleObjects` is current. The server streams every object in the grid cells overlapping the
 * view rectangle (`zoom + 4` half-width, 16:9), which overshoots the rectangle by up to a grid cell; the
 * observation keeps only objects inside the rectangle itself, i.e. what the client actually draws.
 * Teammates come from group status (always known); enemy HP is never included.
 * `shotsHeard` is supplied by the caller, which owns the fire events of the step (see `hearShot`).
 */
/** How many directions the range readings cover, and how far each one looks (world units). */
export const rayCount = 16;
export const rayRange = 48;

/**
 * The first thing that would stop a bullet between two points, by the engine's own rule.
 *
 * `bullet.ts` keeps travelling through anything that is dead, on another layer or shorter than
 * `GameConfig.bullet.height`, and then decides with `hit = col.collidable` — so a bush (collidable
 * false) hides a player from the eye but never from a shot. Line of sight here means exactly that:
 * what the shot would do, not what the eye can see.
 */
export function firstBlocker(
    game: Game,
    from: Vec2,
    to: Vec2,
    layer: number,
): { obstacle: Obstacle; dist: number } | undefined {
    let best: { obstacle: Obstacle; dist: number } | undefined;
    for (const obj of game.grid.intersectLineSegment(from, to)) {
        if (obj.__type !== ObjectType.Obstacle) continue;
        const obstacle = obj as Obstacle;
        if (
            obstacle.dead
            || !obstacle.collidable
            || obstacle.height < GameConfig.bullet.height
            || !util.sameLayer(obstacle.layer, layer)
        ) {
            continue;
        }
        const hit = collider.intersectSegment(obstacle.collider, from, to);
        if (!hit) continue;
        const dist = v2.distance(from, hit.point);
        if (!best || dist < best.dist) best = { obstacle, dist };
    }
    return best;
}

export function extractAgentObservation(
    game: Game,
    player: Player,
    ids: ObservationIds,
    objective: AgentObservation["objective"] = null,
    shotsHeard: ShotHeard[] = [],
): AgentObservation {
    const halfWidth = player.zoom + 4;
    const halfHeight = halfWidth / (16 / 9);
    const inView = (pos: Vec2) =>
        Math.abs(pos.x - player.pos.x) <= halfWidth && Math.abs(pos.y - player.pos.y) <= halfHeight;

    const teammates: AgentObservation["teammates"] = [];
    const players: AgentObservation["players"] = [];
    const loot: AgentObservation["loot"] = [];
    const obstacles: AgentObservation["obstacles"] = [];
    const obstacleObjects: Obstacle[] = [];
    const buildings: AgentObservation["buildings"] = [];
    const deadBodies: AgentObservation["dead_bodies"] = [];

    for (const mate of game.playerBarn.players) {
        if (mate === player || mate.groupId !== player.groupId) continue;
        teammates.push({
            id: ids.agentIdOf(mate),
            pos: vec(mate.pos),
            dist: v2.distance(player.pos, mate.pos),
            hp: mate.health,
            downed: mate.downed,
            dead: mate.dead,
        });
    }

    for (const obj of player.visibleObjects) {
        if (!inView(obj.pos)) continue;
        switch (obj.__type) {
            case ObjectType.Player: {
                const other = obj as Player;
                if (other === player || other.groupId === player.groupId) break;
                players.push({
                    id: ids.agentIdOf(other),
                    team: ids.teamIdOf(other),
                    pos: vec(other.pos),
                    dist: v2.distance(player.pos, other.pos),
                    dir: vec(other.dir),
                    downed: other.downed,
                    dead: other.dead,
                    weapon: other.activeWeapon,
                    los_blocked: false,
                });
                break;
            }
            case ObjectType.Loot: {
                const item = obj as Loot;
                loot.push({
                    id: item.__id,
                    type: item.type,
                    pos: vec(item.pos),
                    dist: v2.distance(player.pos, item.pos),
                    count: item.count,
                });
                break;
            }
            case ObjectType.Obstacle: {
                const obstacle = obj as Obstacle;
                obstacleObjects.push(obstacle);
                obstacles.push({
                    id: obstacle.__id,
                    type: obstacle.type,
                    pos: vec(obstacle.pos),
                    dist: v2.distance(player.pos, obstacle.pos),
                    collidable: obstacle.collidable,
                    height: obstacle.height,
                    scale: obstacle.scale,
                    blocks_los: false,
                    cover_score: 0,
                });
                break;
            }
            case ObjectType.Building: {
                const building = obj as Building;
                buildings.push({
                    id: building.__id,
                    type: building.type,
                    pos: vec(building.pos),
                    dist: v2.distance(player.pos, building.pos),
                });
                break;
            }
            case ObjectType.DeadBody: {
                const body = obj as DeadBody;
                deadBodies.push({ pos: vec(body.pos), dist: v2.distance(player.pos, body.pos) });
                break;
            }
        }
    }

    // bullets are streamed to clients separately from objects; apply the same view rectangle
    const bullets: AgentObservation["bullets"] = [];
    for (const bullet of game.bulletBarn.bullets) {
        if (!bullet.active || !inView(bullet.pos)) continue;
        bullets.push({ pos: vec(bullet.pos), dir: vec(bullet.dir), player_id: bullet.playerId });
    }

    const activeWeapon = player.weapons[player.curWeapIdx];
    const gunDef = GameObjectDefs.typeToDefSafe(activeWeapon.type) as GunDef | undefined;
    const items = player.inventory as Readonly<Record<string, number>>;
    const reserve = gunDef?.type === "gun" ? (items[gunDef.ammo] ?? 0) : 0;
    const inventory: Record<string, number> = {};
    for (const item of observedInventory) inventory[item] = items[item] ?? 0;

    const gas = game.gas;
    // what a shot would actually do, on the agent's own information: the line to each enemy, which
    // obstacle sits on the line to the nearest one, and how far each direction is clear
    for (const entry of players) {
        entry.los_blocked = !!firstBlocker(game, player.pos, entry.pos, player.layer);
    }
    const nearestEnemy = players.filter((p) => !p.dead).sort((a, b) => a.dist - b.dist)[0];
    if (nearestEnemy) {
        for (const [index, obstacle] of obstacleObjects.entries()) {
            const entry = obstacles[index];
            if (!entry.collidable || obstacle.height < GameConfig.bullet.height) continue;
            entry.blocks_los = !!collider.intersectSegment(obstacle.collider, player.pos, nearestEnemy.pos);
            // stepping to the far side of it, 2 u out: does the line break there?
            const away = v2.normalizeSafe(v2.sub(obstacle.pos, nearestEnemy.pos), v2.create(1, 0));
            const behind = v2.add(obstacle.pos, v2.mul(away, 2));
            entry.cover_score = firstBlocker(game, behind, nearestEnemy.pos, player.layer) ? 1 : 0;
        }
    }
    const rays: number[] = [];
    for (let i = 0; i < rayCount; i++) {
        const angle = (i * 2 * Math.PI) / rayCount;
        const end = v2.add(player.pos, v2.create(Math.cos(angle) * rayRange, Math.sin(angle) * rayRange));
        rays.push(firstBlocker(game, player.pos, end, player.layer)?.dist ?? rayRange);
    }

    return {
        self: {
            id: ids.agentIdOf(player),
            team: ids.teamIdOf(player),
            pos: vec(player.pos),
            dir: vec(player.dir),
            hp: player.health,
            boost: player.boost,
            downed: player.downed,
            dead: player.dead,
            weapon: player.activeWeapon,
            clip: activeWeapon.ammo,
            reserve,
            weapons: player.weapons.map((w, slot) => ({ slot, type: w.type, ammo: w.ammo })),
            inventory,
            scope: player.scope,
            zoom: player.zoom,
            action: player.actionType,
            cur_weap_idx: player.curWeapIdx,
        },
        teammates,
        players,
        loot,
        obstacles,
        buildings,
        rays,
        bullets,
        dead_bodies: deadBodies,
        gas: {
            mode: gas.mode,
            rad: gas.currentRad,
            pos: vec(gas.currentPos),
            rad_new: gas.radNew,
            pos_new: vec(gas.posNew),
        },
        alive_count: game.aliveCount,
        alive_teams: game.playerBarn.groups.filter((g) => g.livingPlayers.length > 0).length,
        objective,
        shots_heard: shotsHeard,
    };
}
