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
} from '../lib/test-config.ts';

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

assert.equal(SCORING_VERSION, 2);
assert.equal(ANALYTICS_FACTS_VERSION, 1);
assert.equal(TEST_PROFILE_ID, 'general-v1');
assert.equal(BALANCED_TEST_PROFILE_ID, 'general-balanced-v2');
assert.equal(REMEDIAL_POLICY_VERSION, 2);
assert.equal(sha256(TEST_CONFIG_JSON), TEST_CONFIG_ID);
assert.equal(sha256(BALANCED_TEST_CONFIG_JSON), BALANCED_TEST_CONFIG_ID);
assert.notEqual(TEST_CONFIG_ID, BALANCED_TEST_CONFIG_ID);

for (const json of [TEST_CONFIG_JSON, BALANCED_TEST_CONFIG_JSON]) {
  const snapshot = JSON.parse(json) as Record<string, unknown>;
  assert(!('questionStatsMinSample' in snapshot), 'Analytics presentation settings stay outside model identity.');
  assert('selectionPolicy' in snapshot);
  assert('remedialPolicy' in snapshot);
}

console.log('Model identity tests passed.');
