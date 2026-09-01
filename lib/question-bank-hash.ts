import type { QuestionDefinition } from './question-bank-validation.ts';
import { TEST_CONFIG } from './test-config.ts';

export async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(digest);
}

export async function sha256Hex(value: string) {
  return Array.from(await sha256(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalQuestion(question: QuestionDefinition) {
  return {
    id: question.id,
    difficulty: question.difficulty,
    topic: question.topic,
    prompt: question.prompt,
    ...(question.contextType && question.context !== undefined
      ? { contextType: question.contextType, context: question.context }
      : {}),
    choices: question.choices,
    correctIndex: question.correctIndex,
    weight: TEST_CONFIG.weights[question.difficulty],
  };
}

export async function questionContentHash(question: QuestionDefinition) {
  return sha256Hex(JSON.stringify({
    ...canonicalQuestion(question),
    dedupeKey: question.dedupeKey,
  }));
}

export async function questionBankRevision(questions: readonly QuestionDefinition[]) {
  const canonical = [...questions]
    .sort((left, right) => left.id - right.id)
    .map((question) => ({
      ...canonicalQuestion(question),
      active: question.active,
      dedupeKey: question.dedupeKey,
    }));
  return sha256Hex(JSON.stringify(canonical));
}
