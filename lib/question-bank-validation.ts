import { DIFFICULTIES, TEST_CONFIG, type Difficulty } from './test-config.ts';
import { selectUniqueQuestionPlan } from './question-selection.ts';

export type QuestionDefinition = {
  id: number;
  /** Stable catalog relation; operational metadata, not canonical question content. */
  categoryId?: number | null;
  difficulty: Difficulty;
  topic: string;
  /** Stable category identity used by readiness/selection; not canonical question content. */
  selectionTopic?: string;
  prompt: string;
  contextType?: QuestionContextType;
  context?: string;
  choices: string[];
  correctIndex: number;
  active: boolean;
  dedupeKey: string;
};

export const QUESTION_CONTEXT_TYPES = ['text', 'code', 'command', 'log', 'config'] as const;
export type QuestionContextType = typeof QUESTION_CONTEXT_TYPES[number];

export type QuestionBankSummary = {
  total: number;
  active: number;
  inactive: number;
  pools: Record<Difficulty, { active: number; unique: number; required: number; reserve: number }>;
  warnings: string[];
};

export const QUESTION_LIMITS = {
  promptLength: 280,
  topicLength: 80,
  choiceLength: 160,
  choicesMin: 2,
  choicesMax: 5,
  dedupeKeyLength: 80,
  contextLength: 2_000,
} as const;

const DEDUPE_KEY_PATTERN = /^[a-z0-9][a-z0-9:_-]*$/;
const PROMPT_STOP_WORDS = new Set([
  'какой', 'какая', 'какое', 'какие', 'как', 'что', 'чем', 'где', 'для',
  'используется', 'используют', 'обычно', 'основной', 'основное', 'основная',
  'прежде', 'всего', 'лучше', 'наиболее', 'при', 'после', 'между', 'это',
  'означает', 'предназначена', 'предназначено', 'выполняет',
]);

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

function promptTokens(value: string) {
  return new Set(normalized(value)
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/giu, ' ')
    .split(' ')
    .filter((token) => token.length > 2 && !PROMPT_STOP_WORDS.has(token)));
}

function promptsLikelyDuplicate(left: string, right: string) {
  const leftTokens = promptTokens(left);
  const rightTokens = promptTokens(right);
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = leftTokens.size + rightTokens.size - intersection;
  return intersection >= 3 && union > 0 && intersection / union >= 0.58;
}

export function validateQuestionBank(
  raw: unknown,
  source: string,
  options: { enforceOperationalReadiness?: boolean } = {},
): QuestionDefinition[] {
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
    const {
      id,
      difficulty,
      topic,
      prompt,
      contextType,
      context,
      choices,
      correctIndex,
      active,
      dedupeKey,
    } = question;

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
    } else if (topic.trim().length > QUESTION_LIMITS.topicLength) {
      entryIssues.push(`topic должен содержать не более ${QUESTION_LIMITS.topicLength} символов`);
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
    if ((contextType === undefined) !== (context === undefined)) {
      entryIssues.push('contextType и context должны задаваться совместно');
    } else if (contextType !== undefined && !QUESTION_CONTEXT_TYPES.includes(
      contextType as QuestionContextType,
    )) {
      entryIssues.push(`contextType должен быть одним из: ${QUESTION_CONTEXT_TYPES.join(', ')}`);
    } else if (context !== undefined && (typeof context !== 'string' || !context.trim())) {
      entryIssues.push('context должен быть непустой строкой');
    } else if (typeof context === 'string' && context.length > QUESTION_LIMITS.contextLength) {
      entryIssues.push(`context должен содержать не более ${QUESTION_LIMITS.contextLength} символов`);
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
    if (
      dedupeKey !== undefined && (
        typeof dedupeKey !== 'string' ||
        !DEDUPE_KEY_PATTERN.test(dedupeKey.trim().toLowerCase()) ||
        dedupeKey.trim().length > QUESTION_LIMITS.dedupeKeyLength
      )
    ) {
      entryIssues.push(
        `dedupeKey должен содержать до ${QUESTION_LIMITS.dedupeKeyLength} символов: a-z, 0-9, :, _ или -`,
      );
    }

    issues.push(...entryIssues.map((issue) => `${label}: ${issue}`));
    if (entryIssues.length === 0) {
      questions.push({
        id: id as number,
        difficulty: difficulty as Difficulty,
        topic: (topic as string).trim(),
        prompt: (prompt as string).trim().replace(/\s+/g, ' '),
        ...(contextType !== undefined && typeof context === 'string'
          ? {
              contextType: contextType as QuestionContextType,
              // Context can contain significant indentation and line endings (logs/config/code).
              context,
            }
          : {}),
        choices: (choices as string[]).map((choice) => choice.trim().replace(/\s+/g, ' ')),
        correctIndex: correctIndex as number,
        active: active as boolean,
        dedupeKey: typeof dedupeKey === 'string'
          ? dedupeKey.trim().toLowerCase()
          : `question:${id as number}`,
      });
    }
  });

  if (issues.length === 0) {
    for (let leftIndex = 0; leftIndex < questions.length; leftIndex += 1) {
      const left = questions[leftIndex];
      if (!left.active) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < questions.length; rightIndex += 1) {
        const right = questions[rightIndex];
        if (
          !right.active ||
          normalized(left.topic) !== normalized(right.topic) ||
          left.dedupeKey === right.dedupeKey ||
          !promptsLikelyDuplicate(left.prompt, right.prompt)
        ) continue;
        issues.push(
          `Вопросы id ${left.id} и ${right.id} похожи по смыслу; `
          + 'назначьте им одинаковый dedupeKey или отключите один из них',
        );
      }
    }

    const topicByDedupeKey = new Map<string, string>();
    for (const question of questions) {
      const topic = normalized(question.topic);
      const existingTopic = topicByDedupeKey.get(question.dedupeKey);
      if (existingTopic && existingTopic !== topic) {
        issues.push(`dedupeKey ${question.dedupeKey} используется в разных темах`);
      } else {
        topicByDedupeKey.set(question.dedupeKey, topic);
      }
    }

    if (options.enforceOperationalReadiness !== false) {
      for (const difficulty of DIFFICULTIES) {
        const activeCount = new Set(questions
          .filter((question) => question.active && question.difficulty === difficulty)
          .map((question) => question.dedupeKey)).size;
        const requiredWithReserve = TEST_CONFIG.plan[difficulty] + 1;
        if (activeCount < requiredWithReserve) {
          issues.push(
            `Уникальных активных ${difficulty}: ${activeCount}; требуется минимум ${requiredWithReserve} `
            + '(стартовая квота и хотя бы один remedial-вопрос)',
          );
        }
      }
      if (!selectUniqueQuestionPlan(
        questions.filter((question) => question.active).map((question) => ({
          id: question.id,
          difficulty: question.difficulty,
          dedupe_key: question.dedupeKey,
        })),
        TEST_CONFIG.plan,
        1,
      )) {
        issues.push(
          'Невозможно собрать стартовый тест и remedial-резерв без повторения смысловых групп между уровнями сложности',
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
      const activeQuestions = questions.filter(
        (question) => question.active && question.difficulty === difficulty,
      );
      const active = activeQuestions.length;
      const unique = new Set(activeQuestions.map((question) => question.dedupeKey)).size;
      const required = TEST_CONFIG.plan[difficulty];
      const reserve = unique - required;
      if (reserve === 1) {
        warnings.push(`Пул ${difficulty} содержит только один remedial-вопрос.`);
      }
      return [difficulty, { active, unique, required, reserve }];
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
