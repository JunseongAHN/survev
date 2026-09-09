import { util } from "../../../shared/utils/util.ts";

/**
 * Seeded uniform RNG for the CPC scenarios. Park-Miller's first outputs are almost linear in the seed
 * (seeds 1 apart differ by 1e-5) and string seeds like "run-0" / "run-1" hash to neighbouring integers,
 * so the seed is mixed first (two xorshift-multiply rounds); `stream` gives independent sequences
 * (loot scatter, spawn geometry, objective positions) from one episode seed.
 */
export function seededRand(seed: number, stream = 0): (min?: number, max?: number) => number {
    let x = (seed + stream) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x ^= x >>> 16;
    // Park-Miller needs a seed in [1, 2^31 - 2]
    return util.seededRand(((x >>> 0) % 2147483646) + 1);
}
