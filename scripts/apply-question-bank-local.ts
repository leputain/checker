import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { applyQuestionImport, previewQuestionImport } from '../lib/question-bank-workflow.ts';
import { readLocalD1DatabaseId, resolveOpsContext, type OpsContextOptions } from './ops-context.ts';

export type ApplyLocalQuestionImportOptions = OpsContextOptions & {
  importPath?: string;
  log?: (message: string) => void;
};

export async function applyLocalQuestionImport(options: ApplyLocalQuestionImportOptions = {}) {
  const context = resolveOpsContext(options);
  const importPath = path.resolve(
    options.importPath ?? path.join(context.workspaceRoot, 'db', 'questions.import-2026-09-01.json'),
  );
  const log = options.log ?? console.log;
  const document = JSON.parse(await readFile(importPath, 'utf8')) as { questions?: unknown };
  if (!Array.isArray(document.questions) || document.questions.length === 0) {
    throw new Error('Import document must contain a non-empty questions array.');
  }

  const databaseId = await readLocalD1DatabaseId(context);
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: databaseId },
    d1Persist: path.join(context.persistPath, 'v3', 'd1'),
  });
  try {
    const db = await miniflare.getD1Database('DB');
    const existing = await db.prepare(`SELECT COUNT(*) AS count FROM questions
      WHERE id >= 1000000`).first<{ count: number }>();
    if ((existing?.count ?? 0) === document.questions.length) {
      log(`Question import already applied: ${existing!.count} questions.`);
      return { alreadyApplied: true, changedCount: 0, currentBankRevision: null };
    }
    if ((existing?.count ?? 0) !== 0) {
      throw new Error(`Partial question import detected: ${existing!.count}/${document.questions.length}.`);
    }

    const state = await db.prepare(`SELECT current_revision FROM question_bank_state WHERE id = 1`)
      .first<{ current_revision: string }>();
    if (!state?.current_revision) throw new Error('Question bank is not initialized.');

    const preview = await previewQuestionImport(db, {
      questions: document.questions,
      expectedBankRevision: state.current_revision,
    });
    if (preview.summary.invalid > 0 || !preview.readiness?.ready) {
      const issues = preview.items.flatMap((item) => item.issues);
      throw new Error(`Question import preview failed: ${issues.join('; ') || 'bank is not ready'}`);
    }

    const result = await applyQuestionImport(db, {
      questions: document.questions,
      previewToken: preview.previewToken,
      expectedBankRevision: state.current_revision,
      idempotencyKey: 'question-bank-markdown-2026-09-01-v1',
      note: 'Импорт закрытых вопросов из tests_with_o.markdown от 01.09.2026',
    }, 'local-cli:question-bank-import');
    log(`Question import applied: added=${result.importSummary.added}, `
      + `revised=${result.importSummary.revised}, unchanged=${result.importSummary.unchanged}, `
      + `revision=${result.currentBankRevision}.`);
    return { alreadyApplied: false, ...result };
  } finally {
    await miniflare.dispose();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  applyLocalQuestionImport({ importPath: process.argv[2] }).catch((error) => {
    console.error(`Question import failed: ${error instanceof Error ? error.message : 'unknown_error'}`);
    process.exitCode = 1;
  });
}
