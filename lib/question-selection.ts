import { DIFFICULTIES, type Difficulty } from './test-config.ts';

export type SelectableQuestion = {
  id: number;
  difficulty: Difficulty;
  dedupe_key: string;
};

function questionDedupeKey(question: SelectableQuestion) {
  return question.dedupe_key || `question:${question.id}`;
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
