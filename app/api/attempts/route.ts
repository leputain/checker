import { NextResponse } from 'next/server';
import { env } from 'cloudflare:workers';
import { telegramNotificationPolicy, telegramReadiness } from '@/db/telegram-outbox';
import {
  attemptPayload,
  database,
  ensureQuestionBankReady,
  ensureSchema,
  findAttemptByStartKey,
  publicAlias,
  sha256Hex,
} from '@/db/runtime';
import { selectUniqueQuestionPlan } from '@/lib/question-selection.ts';
import {
  BALANCED_PROFILE_ID,
  calculateCoverageScore,
  selectBalancedQuestionPlan,
  type BalancedQuestion,
  type QuestionExposure,
} from '@/lib/balanced-selection.ts';
import { readFeatureFlags } from '@/lib/feature-flags.ts';
import { progressTelegramMessage } from '@/lib/telegram-messages.ts';
import { candidateKey } from '@/lib/candidate-key.ts';
import {
  ANALYTICS_FACTS_VERSION,
  BALANCED_TEST_CONFIG_ID,
  BASE_QUESTION_COUNT,
  DIFFICULTIES,
  LEGACY_SELECTION_STRATEGY,
  LEGACY_SELECTION_VERSION,
  SCORING_VERSION,
  TEST_CONFIG,
  TEST_CONFIG_ID,
  TEST_PROFILE_ID,
} from '@/lib/test-config.ts';
import { BASE_MAX_SCORE, questionScoreValue } from '@/lib/scoring.ts';
import { APP_RELEASE } from '@/lib/release.ts';
import {
  ATTEMPT_VERSION_UNSUPPORTED_CODE,
  isUnsupportedActiveAttempt,
} from '@/lib/attempt-policy.ts';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };
const START_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
type CandidateQuestion = BalancedQuestion & { weight: number };

export async function POST(request: Request) {
  try {
    await ensureSchema();
    const body = (await request.json()) as { name?: string; startKey?: string; token?: string };
    const startKey = body.startKey?.trim() ?? '';
    const token = body.token?.trim() ?? '';
    if (!START_KEY_PATTERN.test(startKey) || !TOKEN_PATTERN.test(token)) {
      return NextResponse.json(
        { error: 'Некорректные параметры запуска.' },
        { status: 400, headers: NO_STORE },
      );
    }

    const tokenHash = await sha256Hex(token);
    const existing = await findAttemptByStartKey(startKey);
    if (existing) {
      if (existing.token_hash !== tokenHash) {
        return NextResponse.json(
          { error: 'Конфликт параметров запуска.' },
          { status: 409, headers: NO_STORE },
        );
      }
      if (isUnsupportedActiveAttempt(existing)) {
        return NextResponse.json(
          {
            error: 'Эта активная попытка создана в устаревшей версии теста.',
            code: ATTEMPT_VERSION_UNSUPPORTED_CODE,
          },
          { status: 409, headers: NO_STORE },
        );
      }
      return NextResponse.json(await attemptPayload(existing), { headers: NO_STORE });
    }

    const name = body.name?.trim().replace(/\s+/g, ' ');
    if (!name || name.length < 2 || name.length > 80) {
      return NextResponse.json(
        { error: body.name === undefined ? 'Попытка запуска не найдена.' : 'Имя должно содержать от 2 до 80 символов.' },
        { status: body.name === undefined ? 404 : 400, headers: NO_STORE },
      );
    }

    const telegram = await telegramReadiness();
    if (!telegram.ready) {
      return NextResponse.json(
        { error: 'Сервис уведомлений не настроен. Обратитесь к администратору.' },
        { status: 503, headers: NO_STORE },
      );
    }

    const bankRevision = await ensureQuestionBankReady();
    const db = database();
    const candidates: CandidateQuestion[] = [];
    for (const difficulty of DIFFICULTIES) {
      const result = await db
        .prepare(
          `SELECT questions.id, questions.weight, questions.dedupe_key, questions.topic
           FROM questions
           JOIN question_bank_revision_items membership
             ON membership.question_id = questions.id
           WHERE membership.revision_hash = ? AND membership.active = 1
             AND questions.difficulty = ?
           ORDER BY RANDOM()`,
        )
        .bind(bankRevision, difficulty)
        .all<{ id: number; weight: number; dedupe_key: string; topic: string }>();
      for (const question of result.results) {
        candidates.push({ ...question, difficulty });
      }
    }
    const exposureRows = await db.prepare(`SELECT question_id,
        COUNT(presented_at) AS presentation_count,
        MAX(presented_at) AS last_presented_at
      FROM attempt_questions
      WHERE presented_at IS NOT NULL
      GROUP BY question_id`)
      .all<{
        question_id: number;
        presentation_count: number;
        last_presented_at: number | null;
      }>();
    const exposureByQuestionId = new Map<number, QuestionExposure>(
      exposureRows.results.map((row) => [row.question_id, {
        presentationCount: row.presentation_count,
        lastPresentedAt: row.last_presented_at,
      }]),
    );
    const flags = readFeatureFlags(env);
    const legacySelected = selectUniqueQuestionPlan(candidates, TEST_CONFIG.plan, 1);
    const balanced = flags.balancedSelection || flags.balancedSelectionShadow
      ? selectBalancedQuestionPlan(candidates, TEST_CONFIG.plan, exposureByQuestionId, {
          reservePerDifficulty: 1,
        })
      : null;
    const selected = flags.balancedSelection ? balanced?.questions ?? null : legacySelected;
    if (!selected || selected.length < BASE_QUESTION_COUNT) {
      return NextResponse.json(
        { error: 'В банке недостаточно активных вопросов.' },
        { status: 503, headers: NO_STORE },
      );
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const selectionVersion = flags.balancedSelection && balanced
      ? balanced.selectionVersion
      : LEGACY_SELECTION_VERSION;
    const selectionStrategy = flags.balancedSelection && balanced
      ? balanced.strategy
      : LEGACY_SELECTION_STRATEGY;
    const testProfileId = selectionVersion === 2 ? BALANCED_PROFILE_ID : TEST_PROFILE_ID;
    const testConfigId = selectionVersion === 2 ? BALANCED_TEST_CONFIG_ID : TEST_CONFIG_ID;
    // Persist the score of the plan that was actually assigned. In shadow mode
    // this makes the legacy-vs-balanced comparison reproducible instead of
    // storing only one side of it.
    const coverageScore = flags.balancedSelection && balanced
      ? balanced.coverageScore ?? calculateCoverageScore(selected, exposureByQuestionId, now)
      : calculateCoverageScore(selected, exposureByQuestionId, now);
    const shadowCoverageScore = !flags.balancedSelection && flags.balancedSelectionShadow
      ? balanced?.coverageScore ?? null
      : null;
    const identityKey = await candidateKey(name);
    const baseQuestionIds = selected.map((question) => question.id);
    const baseMaxScore = selected.reduce(
      (sum, question) => sum + questionScoreValue(question.weight, 'base'),
      0,
    );
    if (baseMaxScore !== BASE_MAX_SCORE) throw new Error('base_score_plan_mismatch');
    const [first, ...pending] = baseQuestionIds;
    const insertStatement = db
      .prepare(
        `INSERT INTO attempts (
          id, token_hash, start_key, candidate_name, candidate_key, public_alias, bank_revision,
          scoring_version, app_version, test_config_id, test_profile_id, analytics_facts_version,
          selection_version, selection_strategy, coverage_score, shadow_coverage_score,
          status, started_at, total_deadline_at, current_question_started_at, question_deadline_at,
          current_question_id, pending_question_ids, asked_question_ids,
          base_question_ids, base_max_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(start_key) DO NOTHING`,
      )
      .bind(
        id,
        tokenHash,
        startKey,
        name,
        identityKey,
        publicAlias(name),
        bankRevision,
        SCORING_VERSION,
        APP_RELEASE,
        testConfigId,
        testProfileId,
        ANALYTICS_FACTS_VERSION,
        selectionVersion,
        selectionStrategy,
        coverageScore,
        shadowCoverageScore,
        now,
        now + TEST_CONFIG.totalTimeSeconds * 1_000,
        now,
        now + TEST_CONFIG.questionTimeSeconds * 1_000,
        first,
        JSON.stringify(pending),
        JSON.stringify([first]),
        JSON.stringify(baseQuestionIds),
        baseMaxScore,
      );
    const statements: D1PreparedStatement[] = [insertStatement];
    selected.forEach((question, index) => {
      statements.push(
        db.prepare(`INSERT INTO attempt_questions (
          attempt_id, question_id, question_kind, ordinal, source_question_id,
          score_value, assigned_at, presented_at
        ) SELECT id, ?, 'base', ?, NULL, ?, ?, ?
          FROM attempts WHERE id = ? AND status = 'active'
          ON CONFLICT(attempt_id, question_id) DO NOTHING`)
          .bind(
            question.id,
            index + 1,
            questionScoreValue(question.weight, 'base'),
            now,
            index === 0 ? now : null,
            id,
          ),
      );
    });
    const notificationPolicy = telegramNotificationPolicy();
    if (notificationPolicy.enabled && notificationPolicy.createProgressCard) {
      const eventId = `started-${id}`;
      const message = progressTelegramMessage({
        attemptId: id,
        candidateName: name,
        state: 'started',
        answeredCount: 0,
        totalQuestions: baseQuestionIds.length,
        correctCount: 0,
        wrongCount: 0,
        score: 0,
        baseMaxScore,
        totalRemainingSeconds: TEST_CONFIG.totalTimeSeconds,
      });
      statements.push(
        db.prepare(`INSERT INTO telegram_outbox (
          id, attempt_id, question_id, event_type, payload_text, delivery_method,
          parse_mode, silent, status, attempt_count, next_attempt_at, created_at
        ) SELECT ?, id, NULL, 'started', ?, 'send', 'HTML', 1, 'pending', 0, ?, ?
          FROM attempts WHERE id = ? AND status = 'active'
          ON CONFLICT(id) DO NOTHING`)
          .bind(eventId, message, now, now, id),
      );
    }
    const results = await db.batch(statements);
    const insert = results[0];

    const attempt = await findAttemptByStartKey(startKey);
    if (!attempt || attempt.token_hash !== tokenHash) {
      return NextResponse.json(
        { error: 'Конфликт параметров запуска.' },
        { status: 409, headers: NO_STORE },
      );
    }
    if (isUnsupportedActiveAttempt(attempt)) {
      return NextResponse.json(
        {
          error: 'Эта активная попытка создана в устаревшей версии теста.',
          code: ATTEMPT_VERSION_UNSUPPORTED_CODE,
        },
        { status: 409, headers: NO_STORE },
      );
    }
    return NextResponse.json(await attemptPayload(attempt), {
      status: (insert.meta.changes ?? 0) > 0 ? 201 : 200,
      headers: NO_STORE,
    });
  } catch {
    console.error('attempt_start_failed');
    return NextResponse.json(
      { error: 'Не удалось подготовить тест.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
