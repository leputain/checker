import assert from 'node:assert/strict';
import {
  QuestionBankValidationError,
  summarizeQuestionBank,
  validateQuestionBank,
} from '../lib/question-bank-validation.ts';
import { DIFFICULTIES, TEST_CONFIG, type Difficulty } from '../lib/test-config.ts';
import { selectUniqueQuestionPlan } from '../lib/question-selection.ts';

let nextId = 1;

function question(difficulty: Difficulty, overrides: Record<string, unknown> = {}) {
  const id = nextId++;
  return {
    id,
    difficulty,
    topic: 'general',
    prompt: `Вопрос ${id}`,
    choices: [`Вариант ${id}-A`, `Вариант ${id}-B`],
    correctIndex: 0,
    active: true,
    dedupeKey: undefined as string | undefined,
    ...overrides,
  };
}

function minimumBank() {
  nextId = 1;
  return DIFFICULTIES.flatMap((difficulty) =>
    Array.from({ length: TEST_CONFIG.plan[difficulty] + 1 }, () => question(difficulty)),
  );
}

const valid = validateQuestionBank(minimumBank(), 'valid.json');
assert.equal(valid.length, 24);
assert.equal(summarizeQuestionBank(valid).warnings.length, 4);

const bankWithReserve = minimumBank();
for (const difficulty of DIFFICULTIES) bankWithReserve.push(question(difficulty));
assert.equal(summarizeQuestionBank(validateQuestionBank(bankWithReserve, 'reserve.json')).warnings.length, 0);

const matchedPlan = selectUniqueQuestionPlan([
  { id: 1, difficulty: 'easy', dedupe_key: 'shared' },
  { id: 2, difficulty: 'easy', dedupe_key: 'easy-only' },
  { id: 3, difficulty: 'medium', dedupe_key: 'shared' },
], { easy: 1, medium: 1, hard: 0, expert: 0 });
assert.deepEqual(matchedPlan?.map((item) => item.id), [2, 3]);

const deduplicatedPool = minimumBank();
deduplicatedPool[0].dedupeKey = 'shared-concept';
deduplicatedPool[1].dedupeKey = 'shared-concept';
assert.throws(
  () => validateQuestionBank(deduplicatedPool, 'deduplicated-pool.json'),
  /Уникальных активных easy: 5; требуется минимум 6/,
);

const bankWithDedupeKey = minimumBank();
bankWithDedupeKey[0].dedupeKey = 'Windows-GpUpdate';
assert.equal(
  validateQuestionBank(bankWithDedupeKey, 'dedupe-key.json')[0].dedupeKey,
  'windows-gpupdate',
);

const likelyDuplicate = minimumBank();
likelyDuplicate[0].prompt = 'Чем хеширование отличается от шифрования?';
likelyDuplicate[1].prompt = 'Чем хеширование обычно отличается от шифрования?';
assert.throws(
  () => validateQuestionBank(likelyDuplicate, 'likely-duplicate.json'),
  /похожи по смыслу.*одинаковый dedupeKey/,
);

const crossTopicDedupe = minimumBank();
crossTopicDedupe[0].topic = 'Linux';
crossTopicDedupe[1].topic = 'Сети';
crossTopicDedupe[0].dedupeKey = 'shared-concept';
crossTopicDedupe[1].dedupeKey = 'shared-concept';
assert.throws(
  () => validateQuestionBank(crossTopicDedupe, 'cross-topic.json'),
  /dedupeKey shared-concept используется в разных темах/,
);

const invalid = minimumBank();
invalid[1].id = invalid[0].id;
invalid[2].choices = ['Одинаково', ' одинаково '];
invalid[3].prompt = invalid[0].prompt.toLocaleUpperCase('ru-RU');
assert.throws(
  () => validateQuestionBank(invalid, 'invalid.json'),
  (error: unknown) => {
    assert.ok(error instanceof QuestionBankValidationError);
    assert.match(error.message, /id .* уже используется/);
    assert.match(error.message, /повторяющиеся варианты/);
    assert.match(error.message, /prompt дублирует/);
    return true;
  },
);

const insufficient = minimumBank();
insufficient.find((item) => item.difficulty === 'expert')!.active = false;
assert.throws(
  () => validateQuestionBank(insufficient, 'insufficient.json'),
  /Уникальных активных expert: 1; требуется минимум 2/,
);

const oversized = minimumBank();
oversized[0].prompt = 'П'.repeat(281);
oversized[1].choices = ['A', 'B', 'C', 'D', 'E', 'F'];
oversized[2].choices = ['A'.repeat(161), 'B'];
oversized[3].dedupeKey = 'некорректный ключ';
assert.throws(
  () => validateQuestionBank(oversized, 'oversized.json'),
  (error: unknown) => {
    assert.ok(error instanceof QuestionBankValidationError);
    assert.match(error.message, /prompt должен содержать не более 280/);
    assert.match(error.message, /choices должен содержать от 2 до 5/);
    assert.match(error.message, /вариант choices должен содержать не более 160/);
    assert.match(error.message, /dedupeKey должен содержать/);
    return true;
  },
);

console.log('question bank tests: PASS');
