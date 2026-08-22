import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../src/shared/rng.ts';

describe('Rng', () => {
  test('same seed produces the same sequence', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    assert.deepEqual(seqA, seqB);
  });

  test('different seeds diverge', () => {
    const a = new Rng(42);
    const b = new Rng(43);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    assert.notDeepEqual(seqA, seqB);
  });

  test('next() stays within [0, 1)', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 10_000; i++) {
      const value = rng.next();
      assert.ok(value >= 0 && value < 1, `value ${value} out of range`);
    }
  });

  test('int() respects inclusive bounds and covers them', () => {
    const rng = new Rng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const value = rng.int(3, 7);
      assert.ok(Number.isInteger(value));
      assert.ok(value >= 3 && value <= 7, `value ${value} out of range`);
      seen.add(value);
    }
    // Both endpoints must be reachable, not just the interior.
    assert.deepEqual([...seen].sort(), [3, 4, 5, 6, 7]);
  });

  test('int() rejects an inverted range', () => {
    assert.throws(() => new Rng(1).int(5, 2), RangeError);
  });

  test('rejects a non-integer seed', () => {
    assert.throws(() => new Rng(1.5), TypeError);
  });

  test('weighted() never selects a zero-weight key', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 2000; i++) {
      assert.notEqual(rng.weighted({ a: 1, b: 0, c: 2 }), 'b');
    }
  });

  test('weighted() roughly honours the distribution', () => {
    const rng = new Rng(5);
    const counts = { a: 0, b: 0 };
    const trials = 20_000;
    for (let i = 0; i < trials; i++) counts[rng.weighted({ a: 3, b: 1 })]++;
    const ratioA = counts.a / trials;
    // Expected 0.75; allow generous slack so this is not a flaky test.
    assert.ok(ratioA > 0.72 && ratioA < 0.78, `ratio ${ratioA} far from 0.75`);
  });

  test('weighted() rejects an all-zero distribution', () => {
    assert.throws(() => new Rng(1).weighted({ a: 0, b: 0 }), RangeError);
  });

  test('pick() throws on an empty array', () => {
    assert.throws(() => new Rng(1).pick([]), RangeError);
  });

  test('normalClamped() stays inside its bounds', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 5000; i++) {
      const value = rng.normalClamped(100, 50, 10, 200);
      assert.ok(value >= 10 && value <= 200, `value ${value} out of bounds`);
    }
  });

  test('shuffle() is a permutation and does not mutate its input', () => {
    const input = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
    const shuffled = new Rng(3).shuffle(input);
    assert.equal(shuffled.length, input.length);
    assert.deepEqual([...shuffled].sort((x, y) => x - y), [...input]);
    assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('shuffle() is deterministic for a seed', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.deepEqual(new Rng(21).shuffle(input), new Rng(21).shuffle(input));
  });
});
