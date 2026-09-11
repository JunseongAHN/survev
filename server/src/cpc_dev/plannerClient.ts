/**
 * Asks the System 2 planner (llama-server, OpenAI-compatible) for one decision.
 *
 * Never awaited on the tick path: the caller fires a request and keeps running the current skill,
 * so a slow or dead planner costs freshness, not frames. Every failure — timeout, HTTP error, a
 * reply that is not a known skill — comes back as `{error}` rather than a throw, because the live
 * loop's answer to all of them is the same: keep playing on the scripted selector.
 */

import { grammarSkills } from "./skillGrammar.ts";
import type { SkillName } from "./skills.ts";

export interface PlannerDecision {
    skill: SkillName;
    params: Record<string, unknown>;
    commit_ms: number;
    say?: string | null;
}

export interface PlannerReply {
    decision?: PlannerDecision;
    error?: string;
    latencyMs: number;
}

export interface PlannerRequest {
    url: string;
    systemPrompt: string;
    block: string;
    grammar: string;
    timeoutMs?: number;
    temperature?: number;
}

export async function askPlanner(request: PlannerRequest): Promise<PlannerReply> {
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    try {
        const response = await fetch(`${request.url}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(request.timeoutMs ?? 2000),
            body: JSON.stringify({
                messages: [
                    { role: "system", content: request.systemPrompt },
                    { role: "user", content: request.block },
                ],
                grammar: request.grammar,
                temperature: request.temperature ?? 0.7,
                max_tokens: 96,
                cache_prompt: true,
                // Qwen3.5 thinks by default; the grammar forbids it anyway, this keeps the template honest
                chat_template_kwargs: { enable_thinking: false },
            }),
        });
        if (!response.ok) {
            return {
                error: `planner HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
                latencyMs: elapsed(),
            };
        }
        const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const text = data.choices?.[0]?.message?.content ?? "";
        return parseDecision(text, elapsed());
    } catch (err) {
        return { error: `planner unreachable: ${(err as Error).message}`, latencyMs: elapsed() };
    }
}

/** The grammar makes a malformed reply unlikely, not impossible (a truncated generation). */
export function parseDecision(text: string, latencyMs: number): PlannerReply {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { error: `planner reply is not JSON: ${text.slice(0, 120)}`, latencyMs };
    }
    const d = raw as Partial<PlannerDecision>;
    if (typeof d.skill !== "string" || !(grammarSkills as readonly string[]).includes(d.skill)) {
        return { error: `planner chose an unknown skill: ${String(d.skill)}`, latencyMs };
    }
    if (typeof d.params !== "object" || d.params === null) {
        return { error: "planner reply has no params object", latencyMs };
    }
    const commit = typeof d.commit_ms === "number" && Number.isFinite(d.commit_ms) ? d.commit_ms : 1200;
    return {
        decision: {
            skill: d.skill as SkillName,
            params: d.params as Record<string, unknown>,
            commit_ms: commit,
            say: typeof d.say === "string" ? d.say : null,
        },
        latencyMs,
    };
}
