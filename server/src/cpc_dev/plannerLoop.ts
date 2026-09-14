/**
 * System 2's commit/interrupt loop for one agent (plan §4).
 *
 * The planner answers in ~250 ms; the game ticks every 10. So the loop never waits: `decide` is
 * called at the decision cadence, fires a request when something warrants a new decision, and
 * meanwhile returns whatever should run now —
 *
 * - the **committed** skill, while its `commit_ms` window is open and nothing interrupted it;
 * - the committed skill still, if the window closed or the agent got hit but a new decision is on
 *   its way (a person keeps doing what they were doing until they have decided otherwise);
 * - the **fallback** (the scripted selector) when there is nothing to hold on to: before the first
 *   reply, after the committed skill finished or failed, or after the planner erred.
 *
 * Interrupts are the plan's list: the commit window expires, the skill completes or fails, the
 * agent loses hp, a new enemy comes into view, the teammate goes down. Decision intervals therefore
 * come out short in a fight and long when it is quiet, which is the attention pattern the plan
 * wants rather than a fixed clock.
 */

import type { AgentObservation } from "./observation.ts";
import type { PlannerReply } from "./plannerClient.ts";
import type { SkillChoice } from "./scriptedPolicy.ts";
import { availableSkills } from "./skillMask.ts";
import type { SkillName, SkillStatus } from "./skills.ts";
import type { SkillRequest } from "./skillWire.ts";
import { buildStateBlock } from "./stateBlock.ts";

export type InterruptReason =
    | "start"
    | "commit_expired"
    | "skill_done"
    | "skill_failed"
    | "hit"
    | "enemy_seen"
    | "mate_downed";

/** One line of the planner log: every question, answer and refusal, for the playtest review. */
export interface PlannerEvent {
    t: number;
    kind: "asked" | "decided" | "rejected" | "error";
    reason?: InterruptReason;
    skill?: string;
    params?: Record<string, unknown>;
    say?: string | null;
    commitMs?: number;
    latencyMs?: number;
    error?: string;
    block?: string;
    /** the skills the grammar offered on this question */
    skills?: string[];
}

export interface PlannerLoopOptions {
    agentId: string;
    /** `skills` is what can run now; the caller builds the grammar from it so nothing else can be chosen */
    /** the observation comes along so the grammar can offer exactly the places in view */
    ask: (block: string, skills: readonly SkillName[], obs: AgentObservation) => Promise<PlannerReply>;
    /** wire decision -> engine params; throws when the decision cannot run (e.g. target not in view) */
    resolve: (request: SkillRequest) => SkillChoice;
    onEvent?: (event: PlannerEvent) => void;
    /** seconds before asking again after a failed or rejected decision, so a dead planner is not hammered */
    errorBackoff?: number;
    /** hp lost since the decision that counts as being hit */
    hitThreshold?: number;
    /**
     * A decision whose skill finishes or fails within this many seconds was no decision at all —
     * `loot` when already armed completes on its first tick. Asking again at once turned that into a
     * loop of three questions a second in the first live session, so the loop waits
     * `quickDoneBackoff` seconds on the fallback instead.
     */
    quickDone?: number;
    quickDoneBackoff?: number;
}

interface Commitment {
    choice: SkillChoice;
    since: number;
    until: number;
    hp: number;
    enemies: Set<string>;
    mateDowned: boolean;
}

export class PlannerLoop {
    /** who picked the skill returned by the last `decide` */
    source: "planner" | "fallback" = "fallback";
    private commitment?: Commitment;
    private inFlight = false;
    private pending?: { reply: PlannerReply; reason: InterruptReason };
    private retryAfter = 0;
    private asked = false;

    constructor(private readonly options: PlannerLoopOptions) {}

    /**
     * `status` is the latest result of the skill that `decide` last returned; `fallback` is what to
     * run when there is no decision to hold on to. Returns the skill to run until the next call.
     */
    decide(
        t: number,
        obs: AgentObservation,
        status: SkillStatus | undefined,
        fallback: () => SkillChoice | undefined,
    ): SkillChoice | undefined {
        // a reply that just landed starts a new commitment; the status in hand belongs to the old one
        const fresh = this.absorb(t, obs);
        const skillStatus = fresh ? undefined : status;

        const reason = this.interrupt(t, obs, skillStatus);
        if (reason && !this.inFlight && t >= this.retryAfter) this.ask(t, obs, reason, status);

        // a finished or failed skill is not worth holding on to while the next decision is pending
        if (this.commitment && (skillStatus?.done || skillStatus?.failed)) this.commitment = undefined;

        if (this.commitment) {
            this.source = "planner";
            return this.commitment.choice;
        }
        this.source = "fallback";
        return fallback();
    }

    private absorb(t: number, obs: AgentObservation): boolean {
        const pending = this.pending;
        if (!pending) return false;
        this.pending = undefined;
        const { reply } = pending;
        if (!reply.decision) {
            this.retryAfter = t + (this.options.errorBackoff ?? 0.5);
            this.emit({ t, kind: "error", reason: pending.reason, error: reply.error, latencyMs: reply.latencyMs });
            return false;
        }
        const d = reply.decision;
        try {
            const choice = this.options.resolve({ skill: d.skill, params: d.params });
            this.commitment = {
                choice,
                since: t,
                until: t + d.commit_ms / 1000,
                hp: obs.self.hp,
                enemies: new Set(obs.players.filter((p) => !p.dead).map((p) => p.id)),
                mateDowned: obs.teammates.some((m) => m.downed),
            };
            this.emit({
                t,
                kind: "decided",
                reason: pending.reason,
                skill: d.skill,
                params: d.params,
                say: d.say,
                commitMs: d.commit_ms,
                latencyMs: reply.latencyMs,
            });
            return true;
        } catch (err) {
            // the world moved on while the planner thought (the target left view, say)
            this.retryAfter = t + (this.options.errorBackoff ?? 0.5);
            this.emit({
                t,
                kind: "rejected",
                reason: pending.reason,
                skill: d.skill,
                params: d.params,
                error: (err as Error).message,
                latencyMs: reply.latencyMs,
            });
            return false;
        }
    }

    private interrupt(t: number, obs: AgentObservation, status: SkillStatus | undefined): InterruptReason | undefined {
        const c = this.commitment;
        if (!c) return this.asked ? "commit_expired" : "start";
        if (status?.failed || status?.done) {
            if (t - c.since < (this.options.quickDone ?? 0.5)) {
                this.retryAfter = Math.max(this.retryAfter, t + (this.options.quickDoneBackoff ?? 1));
            }
            return status.failed ? "skill_failed" : "skill_done";
        }
        if (obs.self.hp < c.hp - (this.options.hitThreshold ?? 10)) return "hit";
        if (obs.players.some((p) => !p.dead && !c.enemies.has(p.id))) return "enemy_seen";
        if (!c.mateDowned && obs.teammates.some((m) => m.downed)) return "mate_downed";
        if (t >= c.until) return "commit_expired";
        return undefined;
    }

    private ask(t: number, obs: AgentObservation, reason: InterruptReason, status: SkillStatus | undefined): void {
        const current = this.commitment ?? undefined;
        const skills = availableSkills(obs);
        const block = buildStateBlock(obs, {
            agentId: this.options.agentId,
            t,
            currentSkill: current
                ? { skill: current.choice.skill, done: !!status?.done, failed: status?.failed }
                : null,
            canDo: skills,
        });
        this.asked = true;
        this.inFlight = true;
        this.emit({ t, kind: "asked", reason, block, skills: [...skills] });
        this.options
            .ask(block, skills, obs)
            .catch((err: unknown): PlannerReply => ({ error: String(err), latencyMs: 0 }))
            .then((reply) => {
                this.pending = { reply, reason };
                this.inFlight = false;
            });
    }

    private emit(event: PlannerEvent): void {
        this.options.onEvent?.(event);
    }
}
