import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateQuestionBankReadiness } from '../lib/question-bank-readiness.ts';
import {
  QuestionBankValidationError,
  validateQuestionBank,
} from '../lib/question-bank-validation.ts';
import { DIFFICULTIES, GENERAL_TOPIC_PLAN } from '../lib/test-config.ts';

const localPath = path.resolve('db/questions.json');
const examplePath = path.resolve('db/questions.example.json');

function reserveLabel(status: string, available: number | null) {
  return available === null ? status : `${status} (${available} после worst-case base plan)`;
}

async function main() {
  const forceExample = process.argv.includes('--example');
  const bankPath = forceExample
    ? examplePath
    : await access(localPath).then(() => localPath).catch(() => examplePath);
  const source = path.relative(process.cwd(), bankPath);
  const raw = JSON.parse(await readFile(bankPath, 'utf8')) as unknown;
  // Readiness must be able to explain NOT READY without weakening the strict
  // validator used by candidate runtime and CI.
  const questions = validateQuestionBank(raw, source, { enforceOperationalReadiness: false });
  const report = evaluateQuestionBankReadiness(questions);

  console.log('Question Bank Readiness');
  console.log(`Source: ${source}`);
  console.log(`Active questions: ${report.activeQuestions}`);
  console.log(`Unique dedupe groups: ${report.uniqueDedupeGroups}`);
  console.log('');
  console.log('Difficulty (active / unique / required):');
  for (const difficulty of DIFFICULTIES) {
    const pool = report.difficulty[difficulty];
    console.log(
      `${difficulty.padEnd(8)} ${String(pool.active).padStart(3)} / `
      + `${String(pool.unique).padStart(3)} / ${String(pool.required).padStart(2)}`,
    );
  }

  console.log('');
  console.log('Topics (active / unique / target):');
  for (const [topic, pool] of Object.entries(report.topics)) {
    console.log(
      `${topic.padEnd(36)} ${String(pool.active).padStart(3)} / `
      + `${String(pool.unique).padStart(3)} / ${pool.required ?? '-'}`,
    );
  }

  console.log('');
  console.log('Topic x difficulty matrix (unique dedupe groups):');
  console.log(`${'Topic'.padEnd(36)} ${DIFFICULTIES.map((item) => item.padStart(7)).join(' ')}`);
  for (const [topic, row] of Object.entries(report.topicDifficulty)) {
    console.log(
      `${topic.padEnd(36)} ${DIFFICULTIES.map((item) => String(row[item].unique).padStart(7)).join(' ')}`,
    );
  }

  console.log('');
  console.log(`Legacy selector:   ${report.legacy.status}`);
  console.log(`Balanced selector: ${report.balanced.status}`);
  console.log('Balanced target:');
  for (const [topic, required] of Object.entries(GENERAL_TOPIC_PLAN)) {
    console.log(`${topic.padEnd(36)} ${required}`);
  }

  console.log('');
  console.log('Remedial reserve by difficulty:');
  for (const difficulty of DIFFICULTIES) {
    const pool = report.difficulty[difficulty];
    console.log(`${difficulty.padEnd(8)} ${reserveLabel(pool.reserveStatus, pool.availableAfterWorstCase)}`);
  }
  const balancedReserveWarnings = Object.entries(GENERAL_TOPIC_PLAN).flatMap(([topic]) => (
    DIFFICULTIES.flatMap((difficulty) => {
      const cell = report.topicDifficulty[topic][difficulty];
      return cell.unique > 0 && cell.reserveStatus !== 'GOOD'
        ? [`${topic}/${difficulty}: ${reserveLabel(cell.reserveStatus, cell.availableAfterWorstCase)}`]
        : [];
    })
  ));
  if (balancedReserveWarnings.length > 0) {
    console.log('Balanced remedial reserve warnings:');
    for (const warning of balancedReserveWarnings) console.log(`- ${warning}`);
  }
  if (report.unexpectedTopics.length > 0) {
    console.log('');
    console.log(`Unexpected topics (ignored by balanced mandatory quotas): ${report.unexpectedTopics.join(', ')}`);
  }
  for (const warning of report.warnings) console.warn(`Warning: ${warning}`);
  console.log('Prompts, choices and correct answers are intentionally omitted.');
}

main().catch((error: unknown) => {
  if (error instanceof QuestionBankValidationError || error instanceof SyntaxError) {
    console.error(error.message);
  } else {
    console.error('Не удалось построить безопасный readiness-отчёт банка.');
  }
  process.exitCode = 1;
});
