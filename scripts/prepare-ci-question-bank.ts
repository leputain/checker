import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateQuestionBankReadiness } from '../lib/question-bank-readiness.ts';
import { validateQuestionBank, type QuestionDefinition } from '../lib/question-bank-validation.ts';
import { SECURITY_CHALLENGE_CONFIG } from '../lib/security-challenge-config.ts';
import { DIFFICULTIES, GENERAL_TOPIC_PLAN } from '../lib/test-config.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const conceptsPerCell = 10;

/** Public test content only: no example or private bank is read or copied. */
export function createCiQuestionBank(): QuestionDefinition[] {
  let id = 0;
  const raw = Object.keys(GENERAL_TOPIC_PLAN).flatMap((topic) => (
    DIFFICULTIES.flatMap((difficulty) => Array.from({ length: conceptsPerCell }, () => {
      id += 1;
      const marker = `fixture${String(id).padStart(4, '0')}`;
      const correctIndex = id % 4;
      const choices = Array.from({ length: 4 }, (_, index) => (
        index === correctIndex
          ? `Верный ответ ${marker}`
          : `Неверный вариант ${marker}: ${index}`
      ));
      return {
        id, topic, difficulty,
        prompt: `Синтетическая проверка ${marker}?`,
        choices, correctIndex, active: true, dedupeKey: `ci:${marker}`,
      };
    }))
  ));
  // The runtime derives canonical weights from difficulty and TEST_CONFIG.
  return validateQuestionBank(raw, 'ci-synthetic-bank');
}

export function validateCiQuestionBank(questions: readonly QuestionDefinition[]) {
  const readiness = evaluateQuestionBankReadiness(questions);
  if (readiness.balanced.status !== 'READY' || readiness.legacy.status !== 'READY') {
    throw new Error('Synthetic CI bank does not satisfy general selection and remedial readiness.');
  }
  const topics = Object.fromEntries(Object.keys(GENERAL_TOPIC_PLAN).map((topic) => (
    [topic, questions.filter((question) => question.topic === topic).length]
  )));
  if (Object.values(topics).some((count) => count >= 250)) {
    throw new Error('Synthetic CI topic exceeds the whole-category mutation fixture limit.');
  }
  const infosecQuestions = questions.filter((question) => (
    question.active && question.topic === SECURITY_CHALLENGE_CONFIG.categorySelectionKey
  ));
  for (const difficulty of DIFFICULTIES) {
    const unique = new Set(infosecQuestions.filter((question) => question.difficulty === difficulty)
      .map((question) => question.dedupeKey));
    if (unique.size < conceptsPerCell) {
      throw new Error(`Synthetic CI infosec ${difficulty} has insufficient unique concepts.`);
    }
  }
  return { questions: questions.length, topics, balanced: readiness.balanced.status, legacy: readiness.legacy.status };
}

export async function prepareCiQuestionBank(
  workspace = projectRoot,
  environment: { CI?: string; GITHUB_ACTIONS?: string } = {
    CI: process.env.CI, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
  },
) {
  if (environment.CI !== 'true' || environment.GITHUB_ACTIONS !== 'true') {
    throw new Error('Synthetic bank preparation is restricted to GitHub Actions CI.');
  }
  const questions = createCiQuestionBank();
  const summary = validateCiQuestionBank(questions);
  const target = path.join(path.resolve(workspace), 'db', 'questions.json');
  await mkdir(path.dirname(target), { recursive: true });
  // Exclusive creation also rejects symlinks; existing banks are never opened.
  const file = await open(target, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(questions, null, 2)}\n`, 'utf8');
  } finally {
    await file.close();
  }
  return { source: 'synthetic-ci-only', ...summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await prepareCiQuestionBank()));
}
