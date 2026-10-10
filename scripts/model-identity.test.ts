import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ANALYTICS_FACTS_VERSION,
  BALANCED_TEST_CONFIG_ID,
  BALANCED_TEST_CONFIG_JSON,
  BALANCED_TEST_PROFILE_ID,
  REMEDIAL_POLICY_VERSION,
  SCORING_VERSION,
  TEST_CONFIG_ID,
  TEST_CONFIG_JSON,
  TEST_PROFILE_ID,
  LEGACY_SCORING_VERSION,
  LEGACY_PASS_ACCURACY,
  LEGACY_V2_TEST_CONFIG_ID,
  LEGACY_V2_TEST_CONFIG_JSON,
  LEGACY_V2_BALANCED_TEST_CONFIG_ID,
  LEGACY_V2_BALANCED_TEST_CONFIG_JSON,
} from '../lib/test-config.ts';

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

assert.equal(SCORING_VERSION, 3);
assert.equal(LEGACY_SCORING_VERSION, 2);
assert.equal(LEGACY_PASS_ACCURACY, 70);
assert.equal(ANALYTICS_FACTS_VERSION, 1);
assert.equal(TEST_PROFILE_ID, 'general-v1');
assert.equal(BALANCED_TEST_PROFILE_ID, 'general-balanced-v2');
assert.equal(REMEDIAL_POLICY_VERSION, 2);
assert.equal(sha256(TEST_CONFIG_JSON), TEST_CONFIG_ID);
assert.equal(sha256(BALANCED_TEST_CONFIG_JSON), BALANCED_TEST_CONFIG_ID);
assert.notEqual(TEST_CONFIG_ID, BALANCED_TEST_CONFIG_ID);
assert.equal(sha256(LEGACY_V2_TEST_CONFIG_JSON), LEGACY_V2_TEST_CONFIG_ID);
assert.equal(sha256(LEGACY_V2_BALANCED_TEST_CONFIG_JSON), LEGACY_V2_BALANCED_TEST_CONFIG_ID);
assert.equal(LEGACY_V2_TEST_CONFIG_ID, '8c50cc5d8d7b8b0c738b1357d0acbfef0242e3600a2fe140aa2b2b8d375c76da');
assert.equal(LEGACY_V2_BALANCED_TEST_CONFIG_ID, '073e57b6087c34e14c697d4f22d4fb4add5f82525e8799e3c58e7a9c99b8fd63');
assert.notEqual(TEST_CONFIG_ID, LEGACY_V2_TEST_CONFIG_ID);
assert.notEqual(BALANCED_TEST_CONFIG_ID, LEGACY_V2_BALANCED_TEST_CONFIG_ID);

for (const json of [TEST_CONFIG_JSON, BALANCED_TEST_CONFIG_JSON]) {
  const snapshot = JSON.parse(json) as Record<string, unknown>;
  assert(!('questionStatsMinSample' in snapshot), 'Analytics presentation settings stay outside model identity.');
  assert('selectionPolicy' in snapshot);
  assert('remedialPolicy' in snapshot);
  assert('scoringPolicy' in snapshot);
  assert.equal(snapshot.scoringVersion, 3);
  assert.deepEqual(snapshot.verdict, { passScore: 80, passBaseCorrect: 17, reviewScore: 50 });
}

for (const json of [LEGACY_V2_TEST_CONFIG_JSON, LEGACY_V2_BALANCED_TEST_CONFIG_JSON]) {
  const snapshot = JSON.parse(json) as Record<string, unknown>;
  assert.equal(snapshot.scoringVersion, 2);
  assert(!('scoringPolicy' in snapshot), 'legacy identity remains byte-for-byte compatible');
  assert.deepEqual(snapshot.verdict, { passScore: 80, passAccuracy: 70, reviewScore: 50 });
}

console.log('Model identity tests passed.');
