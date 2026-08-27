import {
  QuestionBankValidationError,
  validateQuestionBank,
} from '@/lib/question-bank-validation.ts';

const bankModules = import.meta.glob('./questions*.json', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

export function loadQuestionBank() {
  const source = './questions.json' in bankModules
    ? './questions.json'
    : './questions.example.json';
  const contents = bankModules[source];
  if (!contents) throw new Error('Question bank is missing: add db/questions.json or questions.example.json.');
  let raw: unknown;
  try {
    raw = JSON.parse(contents) as unknown;
  } catch {
    throw new QuestionBankValidationError(source, ['файл содержит некорректный JSON']);
  }
  return validateQuestionBank(raw, source);
}
