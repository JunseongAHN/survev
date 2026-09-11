/**
 * The grammar System 2's output has to obey.
 *
 * The planner returns `{skill, params, commit_ms, say?, ping?}`. Rather than parse whatever a 4B
 * model feels like emitting and retry on failure, the sampler is constrained by a GBNF grammar, so
 * an invalid decision is not merely rejected — it cannot be generated. That matters at 2 Hz inside
 * a live match: a retry loop would show up as the teammate freezing.
 *
 * The grammar is generated from the skill list rather than written by hand, so a new skill cannot
 * be added to `skills.ts` and forgotten here; each skill gets exactly its own parameters.
 *
 * `commit_ms` is the window the planner holds its decision for, and `say` is the chat line — the
 * plan caps Korean utterances at about 15 characters, which the grammar enforces as a length
 * bound rather than a prompt request.
 */

import type { SkillName } from "./skills.ts";

/** What each skill's `params` object looks like on the wire, as GBNF. */
const paramRules: Record<SkillName, string> = {
    // a named place, never coordinates: the state block gives bearings, and a 4B model asked for
    // world positions writes "74m E" as {"x": 74, "y": 0}
    move_to: `"{" ws "\\"to\\"" ws ":" ws target ( ws "," ws "\\"arrive\\"" ws ":" ws number )? ws "}"`,
    follow: `"{" ws "\\"target\\"" ws ":" ws agent ( ws "," ws "\\"distance\\"" ws ":" ws number )? ws "}"`,
    loot: `"{" ( ws "\\"type\\"" ws ":" ws string )? ws "}"`,
    heal: `"{" ( ws "\\"item\\"" ws ":" ws string )? ws "}"`,
    engage: `"{" ws "\\"target\\"" ws ":" ws agent ( ws "," ws "\\"style\\"" ws ":" ws style )? ws "}"`,
    retreat: `"{" ( ws "\\"away_from\\"" ws ":" ws agent ( ws "," ws "\\"distance\\"" ws ":" ws number )? )? ws "}"`,
    revive: `"{" ws "\\"target\\"" ws ":" ws agent ws "}"`,
};

export interface GrammarOptions {
    /** agent ids the planner may name, so it cannot invent a teammate or an enemy */
    agentIds: readonly string[];
    /** only these skills are offered; defaults to every implemented one */
    skills?: readonly SkillName[];
    /** bounds on the commit window, milliseconds */
    commitMs?: { min: number; max: number };
    /** maximum characters in `say`; the plan wants short, situational Korean */
    sayMaxChars?: number;
}

const allSkills = Object.keys(paramRules) as SkillName[];

const quoted = (values: readonly string[]) => values.map((v) => `"\\"${v}\\""`).join(" | ");

/**
 * GBNF rule names may only use `[a-zA-Z0-9-]`. Skill names have underscores (`move_to`), and a
 * rule called `params-move_to` makes llama.cpp stop parsing at `_to` and reject the whole request.
 */
export const ruleName = (skill: string) => `params-${skill.replace(/[^a-zA-Z0-9-]/g, "-")}`;

/**
 * A GBNF grammar for one decision. Pass it to llama.cpp as `grammar` (or `--grammar-file`); the
 * sampler then cannot produce anything outside it.
 */
export function buildSkillGrammar(options: GrammarOptions): string {
    const skills = options.skills ?? allSkills;
    if (!skills.length) throw new Error("at least one skill has to be offered");
    if (!options.agentIds.length) throw new Error("agentIds is required: the planner names targets by id");
    const sayMax = options.sayMaxChars ?? 20;

    // one alternative per skill, each pinned to its own params: the model cannot pick `engage` and
    // then hand over `pos`, which a schema-per-field grammar would allow
    const decisions = skills
        .map(
            (skill) =>
                `"{" ws "\\"skill\\"" ws ":" ws "\\"${skill}\\"" ws "," ws "\\"params\\"" ws ":" ws `
                + `${ruleName(skill)} ws "," ws commit ( ws "," ws say )? ( ws "," ws ping )? ws "}"`,
        )
        // `|` ends the line rather than starting the next: outside parentheses a newline ends a
        // GBNF rule, so a line that begins with `|` is read as a new rule name and rejected
        .join(" |\n      ");

    return `root ::= ${decisions}

${skills.map((s) => `${ruleName(s)} ::= ${paramRules[s]}`).join("\n")}

commit ::= "\\"commit_ms\\"" ws ":" ws commit-value
commit-value ::= ${commitAlternatives(options.commitMs ?? { min: 300, max: 3000 })}
say ::= "\\"say\\"" ws ":" ws ( say-text | "null" )
say-text ::= "\\"" [^"\\\\\\n]{1,${sayMax}} "\\""
ping ::= "\\"ping\\"" ws ":" ws ( vec | "null" )

agent ::= ${quoted(options.agentIds)}
target ::= "\\"point\\"" | agent | loot-target
loot-target ::= "\\"loot:" [a-z0-9]{1,24} "\\""
style ::= ${quoted(["push", "hold_angle", "trade"])}
vec ::= "{" ws "\\"x\\"" ws ":" ws number ws "," ws "\\"y\\"" ws ":" ws number ws "}"
number ::= "-"? [0-9]+ ( "." [0-9]+ )?
string ::= "\\"" [a-z0-9_]{1,24} "\\""
ws ::= [ \\t\\n]*
`;
}

/**
 * `commit_ms` as a set of literal choices rather than a free number. A grammar cannot express
 * "between 300 and 3000", and letting the model write any integer invites 0 or 999999; a short
 * ladder also makes the decision legible in a log.
 */
function commitAlternatives(bounds: { min: number; max: number }): string {
    const ladder = [300, 600, 900, 1200, 1800, 2400, 3000].filter(
        (ms) => ms >= bounds.min && ms <= bounds.max,
    );
    if (!ladder.length) throw new Error(`no commit window inside ${bounds.min}..${bounds.max} ms`);
    return ladder.map((ms) => `"${ms}"`).join(" | ");
}

/** The skills the grammar knows about, for callers that want to check coverage. */
export const grammarSkills: readonly SkillName[] = allSkills;
