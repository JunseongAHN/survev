import { GameObjectDefs } from "../../../shared/defs/register.ts";
import type { GunDef } from "../../../shared/defs/gameObjects/gunDefs.ts";
import { ObjectType } from "../../../shared/net/objectSerializeFns.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Game } from "../game/game.ts";
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
    }>;
    loot: Array<{ id: number; type: string; pos: Vec2; dist: number; count: number }>;
    obstacles: Array<{
        id: number;
        type: string;
        pos: Vec2;
        dist: number;
        collidable: boolean;
        height: number;
        scale: number;
    }>;
    bullets: Array<{ pos: Vec2; dir: Vec2; player_id: number }>;
    dead_bodies: Array<{ pos: Vec2; dist: number }>;
    gas: { mode: number; rad: number; pos: Vec2; rad_new: number; pos_new: Vec2 };
    alive_count: number;
    alive_teams: number;
}

/** Allowlist of every key an observation may contain, checked by tests so nothing leaks past the schema. */
export const observationAllowlist = {
    "": [
        "self",
        "teammates",
        "players",
        "loot",
        "obstacles",
        "bullets",
        "dead_bodies",
        "gas",
        "alive_count",
        "alive_teams",
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
    players: ["id", "team", "pos", "dist", "dir", "downed", "dead", "weapon"],
    loot: ["id", "type", "pos", "dist", "count"],
    obstacles: ["id", "type", "pos", "dist", "collidable", "height", "scale"],
    bullets: ["pos", "dir", "player_id"],
    dead_bodies: ["pos", "dist"],
    gas: ["mode", "rad", "pos", "rad_new", "pos_new"],
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
 */
export function extractAgentObservation(game: Game, player: Player, ids: ObservationIds): AgentObservation {
    const halfWidth = player.zoom + 4;
    const halfHeight = halfWidth / (16 / 9);
    const inView = (pos: Vec2) =>
        Math.abs(pos.x - player.pos.x) <= halfWidth && Math.abs(pos.y - player.pos.y) <= halfHeight;

    const teammates: AgentObservation["teammates"] = [];
    const players: AgentObservation["players"] = [];
    const loot: AgentObservation["loot"] = [];
    const obstacles: AgentObservation["obstacles"] = [];
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
                obstacles.push({
                    id: obstacle.__id,
                    type: obstacle.type,
                    pos: vec(obstacle.pos),
                    dist: v2.distance(player.pos, obstacle.pos),
                    collidable: obstacle.collidable,
                    height: obstacle.height,
                    scale: obstacle.scale,
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
    };
}
