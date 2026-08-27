import assert from 'node:assert/strict';
import { calculateAccuracy, calculateScore, calculateVerdict } from '../lib/scoring.ts';

const baseMaxScore = 14;

const perfectScore = calculateScore(9, 5, baseMaxScore, true);
assert.equal(perfectScore, 14);
assert.equal(calculateAccuracy(6, 0), 100);
assert.equal(calculateVerdict(perfectScore, baseMaxScore, 100), 'PASS');

const recoveredScore = calculateScore(9, 5, baseMaxScore, true);
const recoveredAccuracy = calculateAccuracy(6, 1);
assert.equal(recoveredScore, 14);
assert.equal(recoveredAccuracy, 86);
assert.equal(calculateVerdict(recoveredScore, baseMaxScore, recoveredAccuracy), 'PASS');

let unstableScore = 0;
for (const weight of [5, 5, 3, 2]) {
  unstableScore = calculateScore(unstableScore, weight, baseMaxScore, true);
}
const unstableAccuracy = calculateAccuracy(4, 6);
assert.equal(unstableScore, 14);
assert.equal(unstableAccuracy, 40);
assert.equal(calculateVerdict(unstableScore, baseMaxScore, unstableAccuracy), 'REVIEW');
assert.notEqual(calculateVerdict(unstableScore, baseMaxScore, unstableAccuracy), 'PASS');

assert.equal(calculateScore(14, 5, baseMaxScore, true), 14);
assert.equal(calculateScore(9, 5, baseMaxScore, false), 9);
assert.equal(calculateVerdict(7, baseMaxScore, 50), 'REVIEW');

console.log('scoring tests: PASS');
