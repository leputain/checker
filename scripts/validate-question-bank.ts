import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  QuestionBankValidationError,
  summarizeQuestionBank,
  validateQuestionBank,
} from '../lib/question-bank-validation.ts';
import { DIFFICULTIES } from '../lib/test-config.ts';

const localPath = path.resolve('db/questions.json');
const examplePath = path.resolve('db/questions.example.json');

async function main() {
  const bankPath = await access(localPath).then(() => localPath).catch(() => examplePath);
  const source = path.relative(process.cwd(), bankPath);
  const raw = JSON.parse(await readFile(bankPath, 'utf8')) as unknown;
  const questions = validateQuestionBank(raw, source);
  const summary = summarizeQuestionBank(questions);

  console.log(`Банк вопросов корректен: ${source}`);
  console.log(`Всего: ${summary.total}; активных: ${summary.active}; неактивных: ${summary.inactive}`);
  for (const difficulty of DIFFICULTIES) {
    const pool = summary.pools[difficulty];
    console.log(
      `${difficulty}: ${pool.active} активных, план ${pool.required}, резерв ${pool.reserve}`,
    );
  }
  for (const warning of summary.warnings) console.warn(`Предупреждение: ${warning}`);
}

main().catch((error: unknown) => {
  if (error instanceof QuestionBankValidationError || error instanceof SyntaxError) {
    console.error(error.message);
  } else {
    console.error('Не удалось проверить банк вопросов.', error);
  }
  process.exitCode = 1;
});
