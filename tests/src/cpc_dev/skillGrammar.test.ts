/**
 * The planner's output grammar. llama.cpp is not available to vitest, so these check the two
 * things that broke or would break a live request: rule names outside GBNF's `[a-zA-Z0-9-]`
 * (an underscore made the server reject every request with "failed to parse grammar"), and a
 * grammar that drifts from the skills the server can actually run.
 */

import { expect, test } from "vitest";
import { buildSkillGrammar, grammarSkills } from "../../../server/src/cpc_dev/skillGrammar.ts";

const agentIds = ["team-a-0", "team-a-1", "team-b-0", "team-b-1"];

test("every rule name is legal GBNF", () => {
    const grammar = buildSkillGrammar({ agentIds });
    const names = [...grammar.matchAll(/^([^\s:]+)\s*::=/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9-]+$/);
});

// the second live rejection: alternatives placed at the start of a line. Outside parentheses a
// newline ends a rule, so llama.cpp read `| "{" ...` as a new rule name ("expecting name at |")
test("no line starts with an alternative bar", () => {
    const grammar = buildSkillGrammar({ agentIds });
    for (const line of grammar.split("\n")) expect(line.trimStart().startsWith("|"), line).toBe(false);
});

test("every referenced rule is defined", () => {
    const grammar = buildSkillGrammar({ agentIds });
    const defined = new Set([...grammar.matchAll(/^([a-zA-Z0-9-]+)\s*::=/gm)].map((m) => m[1]));
    // strip quoted literals and character classes, then every remaining bare word is a rule reference
    const bodies = grammar
        .split("\n")
        .map((line) => line.replace(/^[a-zA-Z0-9-]+\s*::=/, ""))
        .join(" ")
        .replace(/"(?:\\.|[^"\\])*"/g, " ")
        .replace(/\[(?:\\.|[^\]\\])*\]/g, " ")
        .replace(/\{\d+(,\d*)?\}/g, " ");
    const referenced = new Set(bodies.match(/[a-zA-Z][a-zA-Z0-9-]*/g) ?? []);
    for (const name of referenced) expect(defined.has(name), `rule ${name} is used but not defined`).toBe(true);
});

test("the grammar offers exactly the skills the server runs, each with its own params", () => {
    const grammar = buildSkillGrammar({ agentIds });
    expect([...grammarSkills].sort()).toEqual(
        ["engage", "follow", "heal", "loot", "move_to", "retreat", "revive"],
    );
    for (const skill of grammarSkills) {
        expect(grammar).toContain(`"\\"${skill}\\""`);
    }
});

test("agent ids are a closed set, so the planner cannot invent a target", () => {
    const grammar = buildSkillGrammar({ agentIds: ["a-0", "b-0"] });
    expect(grammar).toMatch(/^agent ::= "\\"a-0\\"" \| "\\"b-0\\""$/m);
});

test("a restricted skill list narrows the choice", () => {
    const grammar = buildSkillGrammar({ agentIds, skills: ["loot", "engage"] });
    expect(grammar).toContain(`"\\"loot\\""`);
    expect(grammar).not.toContain(`"\\"revive\\""`);
    expect(() => buildSkillGrammar({ agentIds, skills: [] })).toThrow(/at least one skill/);
    expect(() => buildSkillGrammar({ agentIds: [] })).toThrow(/agentIds is required/);
});

// the planner is never asked for coordinates: a 4B model given bearings wrote "74m E" as {"x": 74, "y": 0}
test("move_to offers named targets, not coordinates", () => {
    const grammar = buildSkillGrammar({ agentIds });
    const rule = grammar.split("\n").find((line) => line.startsWith("params-move-to ::="))!;
    expect(rule).toContain(`"\\"to\\""`);
    expect(rule).not.toContain(`"\\"pos\\""`);
    expect(grammar).toMatch(/^target ::= "\\"point\\"" \| agent \| loot-target$/m);
});

// the first live planner session produced `loot {"type": "ammo"}` — not an item — so the skill
// failed and the planner was asked again; loot and heal now take no fields at all
test("loot and heal take no parameters", () => {
    const grammar = buildSkillGrammar({ agentIds });
    for (const skill of ["loot", "heal"]) {
        const rule = grammar.split("\n").find((line) => line.startsWith(`params-${skill} ::=`))!;
        expect(rule).toBe(`params-${skill} ::= "{" ws "}"`);
    }
});

test("a place the agent cannot see is not in the grammar", () => {
    const bare = buildSkillGrammar({ agentIds: ["team-a-0", "team-b-0"], skills: ["move_to"] });
    expect(bare).not.toContain("cover-target");
    expect(bare).not.toContain("building-target");

    const named = buildSkillGrammar({
        agentIds: ["team-a-0", "team-b-0"],
        skills: ["move_to"],
        covers: ["c1", "c2"],
        buildings: ["b1"],
    });
    expect(named).toContain("cover-target ::= \"\\\"cover:c1\\\"\" | \"\\\"cover:c2\\\"\"");
    expect(named).toContain("building-target ::= \"\\\"building:b1\\\"\"");
    expect(named).toContain("cover-target");
});

test("with no race point, `point` cannot be generated", () => {
    const withPoint = buildSkillGrammar({ agentIds: ["team-a-0"], skills: ["move_to"] });
    expect(withPoint).toContain("\"\\\"point\\\"\"");

    const without = buildSkillGrammar({ agentIds: ["team-a-0"], skills: ["move_to"], point: false });
    expect(without).not.toContain("\"\\\"point\\\"\"");
    expect(without).toContain("loot-target");
});
