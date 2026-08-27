import { DIFFICULTIES, TEST_CONFIG, type Difficulty } from './test-config.ts';

export type QuestionDefinition = {
  id: number;
  difficulty: Difficulty;
  topic: string;
  prompt: string;
  choices: string[];
  correctIndex: number;
  active: boolean;
};

export type QuestionBankSummary = {
  total: number;
  active: number;
  inactive: number;
  pools: Record<Difficulty, { active: number; required: number; reserve: number }>;
  warnings: string[];
};

export const QUESTION_LIMITS = {
  promptLength: 280,
  choiceLength: 160,
  choicesMin: 2,
  choicesMax: 5,
} as const;

export class QuestionBankValidationError extends Error {
  readonly issues: string[];

  constructor(source: string, issues: string[]) {
    super(`Некорректный банк вопросов ${source}:\n- ${issues.join('\n- ')}`);
    this.name = 'QuestionBankValidationError';
    this.issues = issues;
  }
}

function normalized(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
}

export function validateQuestionBank(raw: unknown, source: string): QuestionDefinition[] {
  if (!Array.isArray(raw)) {
    throw new QuestionBankValidationError(source, ['корневое значение должно быть JSON-массивом']);
  }

  const issues: string[] = [];
  const seenIds = new Set<number>();
  const seenPrompts = new Map<string, number>();
  const questions: QuestionDefinition[] = [];

  raw.forEach((candidate, index) => {
    const label = `Запись #${index + 1}`;
    const entryIssues: string[] = [];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      issues.push(`${label}: ожидается объект`);
      return;
    }

    const question = candidate as Record<string, unknown>;
    const { id, difficulty, topic, prompt, choices, correctIndex, active } = question;

    if (!Number.isInteger(id) || (id as number) <= 0) {
      entryIssues.push('id должен быть положительным целым числом');
    } else if (seenIds.has(id as number)) {
      entryIssues.push(`id ${id} уже используется`);
    } else {
      seenIds.add(id as number);
    }
    if (!DIFFICULTIES.includes(difficulty as Difficulty)) {
      entryIssues.push('difficulty должен быть easy, medium, hard или expert');
    }
    if (typeof topic !== 'string' || !topic.trim()) {
      entryIssues.push('topic должен быть непустой строкой');
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      entryIssues.push('prompt должен быть непустой строкой');
    } else if (prompt.trim().length > QUESTION_LIMITS.promptLength) {
      entryIssues.push(`prompt должен содержать не более ${QUESTION_LIMITS.promptLength} символов`);
    } else {
      const promptKey = normalized(prompt);
      const duplicateId = seenPrompts.get(promptKey);
      if (duplicateId !== undefined) {
        entryIssues.push(`prompt дублирует вопрос id ${duplicateId}`);
      } else if (Number.isInteger(id)) {
        seenPrompts.set(promptKey, id as number);
      }
    }
    if (
      !Array.isArray(choices) ||
      choices.length < QUESTION_LIMITS.choicesMin ||
      choices.length > QUESTION_LIMITS.choicesMax
    ) {
      entryIssues.push(
        `choices должен содержать от ${QUESTION_LIMITS.choicesMin} до ${QUESTION_LIMITS.choicesMax} вариантов`,
      );
    } else if (choices.some((choice) => typeof choice !== 'string' || !choice.trim())) {
      entryIssues.push('каждый вариант choices должен быть непустой строкой');
    } else if (
      choices.some((choice) => (choice as string).trim().length > QUESTION_LIMITS.choiceLength)
    ) {
      entryIssues.push(
        `каждый вариант choices должен содержать не более ${QUESTION_LIMITS.choiceLength} символов`,
      );
    } else {
      const normalizedChoices = choices.map((choice) => normalized(choice as string));
      if (new Set(normalizedChoices).size !== normalizedChoices.length) {
        entryIssues.push('choices содержит повторяющиеся варианты');
      }
    }
    if (
      !Number.isInteger(correctIndex) ||
      !Array.isArray(choices) ||
      (correctIndex as number) < 0 ||
      (correctIndex as number) >= choices.length
    ) {
      entryIssues.push('correctIndex выходит за границы choices');
    }
    if (typeof active !== 'boolean') {
      entryIssues.push('active должен быть boolean');
    }

    issues.push(...entryIssues.map((issue) => `${label}: ${issue}`));
    if (entryIssues.length === 0) {
      questions.push({
        id: id as number,
        difficulty: difficulty as Difficulty,
        topic: (topic as string).trim(),
        prompt: (prompt as string).trim().replace(/\s+/g, ' '),
        choices: (choices as string[]).map((choice) => choice.trim().replace(/\s+/g, ' ')),
        correctIndex: correctIndex as number,
        active: active as boolean,
      });
    }
  });

  if (issues.length === 0) {
    for (const difficulty of DIFFICULTIES) {
      const activeCount = questions.filter(
        (question) => question.active && question.difficulty === difficulty,
      ).length;
      const requiredWithReserve = TEST_CONFIG.plan[difficulty] + 1;
      if (activeCount < requiredWithReserve) {
        issues.push(
          `Активных ${difficulty}: ${activeCount}; требуется минимум ${requiredWithReserve} `
          + '(стартовая квота и хотя бы один remedial-вопрос)',
        );
      }
    }
  }

  if (issues.length > 0) throw new QuestionBankValidationError(source, issues);
  return questions;
}

export function summarizeQuestionBank(questions: QuestionDefinition[]): QuestionBankSummary {
  const warnings: string[] = [];
  const pools = Object.fromEntries(
    DIFFICULTIES.map((difficulty) => {
      const active = questions.filter(
        (question) => question.active && question.difficulty === difficulty,
      ).length;
      const required = TEST_CONFIG.plan[difficulty];
      const reserve = active - required;
      if (reserve === 1) {
        warnings.push(`Пул ${difficulty} содержит только один remedial-вопрос.`);
      }
      return [difficulty, { active, required, reserve }];
    }),
  ) as QuestionBankSummary['pools'];
  const active = questions.filter((question) => question.active).length;
  return {
    total: questions.length,
    active,
    inactive: questions.length - active,
    pools,
    warnings,
  };
}
