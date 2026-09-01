import assert from 'node:assert/strict';
import {
  SECURITY_CHALLENGE_CONFIG,
  challengeScoreDeltaUnits,
  normalizeChallengeNickname,
  normalizedChallengeParticipantIdentity,
  validateChallengeNickname,
} from '../lib/security-challenge-config.ts';
import { readFeatureFlags } from '../lib/feature-flags.ts';

for (const [difficulty, weight] of Object.entries(SECURITY_CHALLENGE_CONFIG.weights)) {
  for (let choiceCount = 2; choiceCount <= 6; choiceCount += 1) {
    const correct = challengeScoreDeltaUnits(
      difficulty as keyof typeof SECURITY_CHALLENGE_CONFIG.weights,
      choiceCount,
      true,
    );
    const incorrect = challengeScoreDeltaUnits(
      difficulty as keyof typeof SECURITY_CHALLENGE_CONFIG.weights,
      choiceCount,
      false,
    );
    assert.equal(correct, 300 * weight);
    assert.equal(Number.isInteger(incorrect), true);
    const randomExpectation = correct / choiceCount
      + incorrect * ((choiceCount - 1) / choiceCount);
    assert.equal(randomExpectation, 0, `${difficulty}/${choiceCount} should be guess-neutral`);
  }
}

assert.equal(normalizeChallengeNickname('  Packet   Witch  '), 'Packet Witch');
assert.equal(normalizeChallengeNickname('Ｐacket'), 'Packet');
assert.equal(normalizedChallengeParticipantIdentity('  ПАКЕТ  '), 'пакет');
assert.equal(validateChallengeNickname('A'), null);
assert.equal(validateChallengeNickname(`good\u202Eevil`), null);
assert.equal(validateChallengeNickname(`good\nname`), null);
assert.equal(validateChallengeNickname('packet_witch'), 'packet_witch');
assert.throws(() => challengeScoreDeltaUnits('easy', 7, false));
assert.equal(readFeatureFlags({}).securityChallenge, false);
assert.equal(readFeatureFlags({ SECURITY_CHALLENGE_ENABLED: 'true' }).securityChallenge, true);
assert.equal(readFeatureFlags({ SECURITY_CHALLENGE_ENABLED: '0' }).securityChallenge, false);

const block = SECURITY_CHALLENGE_CONFIG.difficultyBlock;
assert.deepEqual(
  Object.fromEntries(['easy', 'medium', 'hard', 'expert'].map((difficulty) => [
    difficulty,
    block.filter((item) => item === difficulty).length,
  ])),
  { easy: 3, medium: 3, hard: 3, expert: 1 },
);

console.log('security challenge policy tests: PASS');
