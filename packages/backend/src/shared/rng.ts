/**
 * Deterministic pseudo-random number generator.
 *
 * The synthetic dataset must be byte-identical for a given seed (PRD section
 * 27), so we cannot use Math.random(). This is a mulberry32 generator: small,
 * fast, and with good enough statistical properties for generating test data.
 * It is NOT cryptographically secure and must never be used for tokens, keys,
 * or idempotency values that need unpredictability.
 */
export class Rng {
  #state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed)) {
      throw new TypeError(`Rng seed must be an integer, received ${seed}`);
    }
    // Coerce to uint32 so negative or oversized seeds still behave.
    this.#state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (min > max) throw new RangeError(`int(${min}, ${max}): min exceeds max`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** True with the given probability. */
  bool(probability: number): boolean {
    return this.next() < probability;
  }

  /** Uniformly pick one element. Throws on an empty list. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick() called on empty array');
    return items[this.int(0, items.length - 1)] as T;
  }

  /**
   * Pick one entry from a weighted distribution. Weights need not sum to 1;
   * they are normalised internally. Zero/negative weights are never selected.
   */
  weighted<T extends string>(distribution: Readonly<Record<T, number>>): T {
    const entries = Object.entries(distribution) as [T, number][];
    const total = entries.reduce((sum, [, w]) => sum + Math.max(0, w), 0);
    if (total <= 0) throw new RangeError('weighted() requires a positive total weight');

    let threshold = this.next() * total;
    for (const [key, weight] of entries) {
      threshold -= Math.max(0, weight);
      if (threshold < 0) return key;
    }
    // Floating-point drift only; fall back to the last positive-weight entry.
    return entries.filter(([, w]) => w > 0).at(-1)![0];
  }

  /**
   * Sample from a normal distribution via the Box-Muller transform, clamped to
   * [min, max]. Used for transaction amounts, which cluster around a mean but
   * need a realistic tail.
   */
  normalClamped(mean: number, stdDev: number, min: number, max: number): number {
    const u1 = Math.max(this.next(), Number.EPSILON);
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.min(max, Math.max(min, mean + z * stdDev));
  }

  /** Fisher-Yates shuffle, returning a new array. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }
}
