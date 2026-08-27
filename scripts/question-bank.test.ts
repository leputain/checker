import assert from 'node:assert/strict';
import {
  QuestionBankValidationError,
  summarizeQuestionBank,
  validateQuestionBank,
} from '../lib/question-bank-validation.ts';
import { DIFFICULTIES, TEST_CONFIG, type Difficulty } from '../lib/test-config.ts';

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
assert.equal(valid.length, 10);
assert.equal(summarizeQuestionBank(valid).warnings.length, 4);

const bankWithReserve = minimumBank();
for (const difficulty of DIFFICULTIES) bankWithReserve.push(question(difficulty));
assert.equal(summarizeQuestionBank(validateQuestionBank(bankWithReserve, 'reserve.json')).warnings.length, 0);

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
  /Активных expert: 1; требуется минимум 2/,
);

const oversized = minimumBank();
oversized[0].prompt = 'П'.repeat(281);
oversized[1].choices = ['A', 'B', 'C', 'D', 'E', 'F'];
oversized[2].choices = ['A'.repeat(161), 'B'];
assert.throws(
  () => validateQuestionBank(oversized, 'oversized.json'),
  (error: unknown) => {
    assert.ok(error instanceof QuestionBankValidationError);
    assert.match(error.message, /prompt должен содержать не более 280/);
    assert.match(error.message, /choices должен содержать от 2 до 5/);
    assert.match(error.message, /вариант choices должен содержать не более 160/);
    return true;
  },
);

console.log('question bank tests: PASS');
