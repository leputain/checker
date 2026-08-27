import { DIFFICULTIES, type Difficulty } from './test-config.ts';

export type SelectableQuestion = {
  id: number;
  difficulty: Difficulty;
  dedupe_key: string;
};

export type RemedialCandidate = SelectableQuestion & {
  topic: string;
};

function questionDedupeKey(question: SelectableQuestion) {
  return question.dedupe_key || `question:${question.id}`;
}

function normalizedTopic(topic: string) {
  return topic.trim().toLocaleLowerCase('ru-RU');
}

/**
 * Candidates are expected in randomized order. Prefer a unique question from the
 * same topic, then fall back to any unique question of the requested difficulty.
 */
export function selectRemedialQuestion<T extends RemedialCandidate>(
  candidates: readonly T[],
  difficulty: Difficulty,
  topic: string,
  excludedIds: ReadonlySet<number>,
  excludedDedupeKeys: ReadonlySet<string>,
) {
  const available = candidates.filter((candidate) => (
    candidate.difficulty === difficulty &&
    !excludedIds.has(candidate.id) &&
    !excludedDedupeKeys.has(questionDedupeKey(candidate))
  ));
  const targetTopic = normalizedTopic(topic);
  return available.find((candidate) => normalizedTopic(candidate.topic) === targetTopic)
    ?? available[0];
}

export function selectUniqueQuestionPlan<T extends SelectableQuestion>(
  candidates: readonly T[],
  plan: Readonly<Record<Difficulty, number>>,
  reservePerDifficulty = 0,
) {
  const slots = DIFFICULTIES.flatMap((difficulty) => (
    Array.from({ length: plan[difficulty] + reservePerDifficulty }, (_, index) => ({
      difficulty,
      selected: index < plan[difficulty],
    }))
  ));
  const candidatesByDifficultyAndKey = new Map<Difficulty, Map<string, T>>();
  const keysByDifficulty = new Map<Difficulty, string[]>();

  for (const difficulty of DIFFICULTIES) {
    candidatesByDifficultyAndKey.set(difficulty, new Map());
    keysByDifficulty.set(difficulty, []);
  }
  for (const candidate of candidates) {
    const key = questionDedupeKey(candidate);
    const byKey = candidatesByDifficultyAndKey.get(candidate.difficulty)!;
    if (byKey.has(key)) continue;
    byKey.set(key, candidate);
    keysByDifficulty.get(candidate.difficulty)!.push(key);
  }

  const keyOwner = new Map<string, number>();
  const matchedKeys = new Array<string>(slots.length);
  const assignSlot = (slotIndex: number, visitedKeys: Set<string>): boolean => {
    for (const key of keysByDifficulty.get(slots[slotIndex].difficulty)!) {
      if (visitedKeys.has(key)) continue;
      visitedKeys.add(key);
      const owner = keyOwner.get(key);
      if (owner === undefined || assignSlot(owner, visitedKeys)) {
        keyOwner.set(key, slotIndex);
        matchedKeys[slotIndex] = key;
        return true;
      }
    }
    return false;
  };

  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    if (!assignSlot(slotIndex, new Set())) return null;
  }

  return slots.flatMap((slot, slotIndex) => (
    slot.selected
      ? [candidatesByDifficultyAndKey.get(slot.difficulty)!.get(matchedKeys[slotIndex])!]
      : []
  ));
}
