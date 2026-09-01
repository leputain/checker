import { calculateAccuracy } from './scoring.ts';
import {
  analyticsCursor,
  questionAnalyticsMatches,
  sortQuestionAnalyticsItems,
  type ParsedAnalyticsQuery,
} from './analytics-query.ts';
import {
  analyticsReliability,
  interviewerRecommendations,
  median,
  observedQuestionMetrics,
  questionAnalyticsSignals,
  questionAnalyticsSummary,
  questionPromptPreview,
  questionQuality,
  questionSample,
  roundedRate,
  summarizeQuestionFacts,
} from './analytics-math.ts';
import { buildCandidateInsights, type CandidateTopicGroup } from './candidate-insights.ts';
import type {
  AnalyticsCohortDto,
  AnalyticsListDto,
  AnalyticsOverviewDto,
  AnalyticsOverviewPeriodDto,
  AnalyticsRevisionItemDto,
  AnalyticsTrendItemDto,
  CandidateAnalyticsItemDto,
  CandidateDimensionPerformanceDto,
  CandidatePrintDto,
  GroupAnalyticsItemDto,
  QuestionAnalyticsDetailDto,
  QuestionAnalyticsItemDto,
  QuestionKindSplitDto,
  QuestionAnalyticsListDto,
} from './analytics-contract.ts';
import { QUESTION_ANALYTICS_MODEL_VERSION } from './analytics-contract.ts';
import type {
  AnalyticsAttemptRow,
  AnalyticsFactRow,
  AnalyticsOverviewAttemptRow,
} from './analytics-repository.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;
const EXACT_ANSWER_ORIGINS = new Set([
  'submitted',
  'question_timeout',
  'total_timeout_presented',
  'total_timeout_unshown',
]);
const PRESENTED_ANSWER_ORIGINS = new Set([
  'submitted',
  'question_timeout',
  'total_timeout_presented',
]);
const moscowDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function adminCandidateAlias(attemptId: string) {
  const opaque = attemptId.replace(/[^a-zA-Z0-9]/gu, '').slice(0, 8).toUpperCase();
  return `Кандидат ${opaque || 'БЕЗ-ID'}`;
}

function iso(timestamp: number | null) {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function average(values: readonly number[]) {
  const valid = values.filter(Number.isFinite);
  if (valid.length === 0) return null;
  return Math.round((valid.reduce((total, value) => total + value, 0) / valid.length) * 10) / 10;
}

function isExactOutcome(row: AnalyticsFactRow) {
  return row.presentedAt !== null
    && row.answerId !== null
    && row.factVersion === 1
    && row.answerOrigin !== null
    && PRESENTED_ANSWER_ORIGINS.has(row.answerOrigin);
}

function isResolvedFact(row: AnalyticsFactRow) {
  return row.answerId !== null
    && row.factVersion === 1
    && row.answerOrigin !== null
    && EXACT_ANSWER_ORIGINS.has(row.answerOrigin);
}

function factMatches(query: ParsedAnalyticsQuery, row: AnalyticsFactRow) {
  return (query.questionKind === 'all' || row.questionKind === query.questionKind)
    && (query.topic === null || row.topic === query.topic)
    && (query.difficulty === null || row.difficulty === query.difficulty);
}

export type AnalyticsCohortCounts = {
  eligibleAttempts: number;
  eligibleAnswers: number;
};

export function buildAnalyticsCohort(
  query: ParsedAnalyticsQuery,
  counts: AnalyticsCohortCounts,
  calibrationEnabled = true,
  generatedAt = Date.now(),
): AnalyticsCohortDto {
  return {
    questionAnalyticsModelVersion: QUESTION_ANALYTICS_MODEL_VERSION,
    from: query.from,
    to: query.to,
    bankRevision: query.bankRevision,
    scoringVersion: query.scoringVersion,
    testConfigId: query.testConfigId,
    testProfileId: query.testProfileId,
    appVersion: query.appVersion,
    topic: query.topic,
    difficulty: query.difficulty,
    questionKind: query.questionKind,
    qualityStatus: query.qualityStatus,
    minSample: query.minSample,
    candidatePolicy: query.candidatePolicy,
    eligibleAttempts: counts.eligibleAttempts,
    eligibleAnswers: counts.eligibleAnswers,
    generatedAt: new Date(generatedAt).toISOString(),
    warnings: [...query.warnings],
    statisticsCompleteness: 'complete',
    calibrationEnabled,
  };
}

function cohortDto(
  query: ParsedAnalyticsQuery,
  attempts: readonly AnalyticsAttemptRow[],
  facts: readonly AnalyticsFactRow[],
  calibrationEnabled = true,
) {
  const matchingFacts = facts.filter((row) => factMatches(query, row));
  const attemptIds = new Set(matchingFacts.map((row) => row.attemptId));
  return buildAnalyticsCohort(query, {
    eligibleAttempts: query.topic || query.difficulty || query.questionKind !== 'all'
      ? attemptIds.size
      : attempts.length,
    eligibleAnswers: matchingFacts.filter(isExactOutcome).length,
  }, calibrationEnabled);
}

function kindSplit(rows: readonly AnalyticsFactRow[], minSample: number): QuestionKindSplitDto {
  const presented = rows.filter((row) => row.presentedAt !== null);
  const outcomes = presented.filter(isExactOutcome);
  const correct = outcomes.filter((row) => row.isCorrect).length;
  const earned = outcomes.reduce((total, row) => total + (row.awardedScore ?? 0), 0);
  return {
    assigned: rows.length,
    presented: presented.length,
    resolved: outcomes.length,
    correct,
    incorrect: outcomes.filter((row) => !row.isCorrect && !row.timedOut).length,
    timedOut: outcomes.filter((row) => row.timedOut).length,
    earned,
    max: rows.reduce((total, row) => total + row.scoreValue, 0),
    successRate: outcomes.length >= minSample ? roundedRate(correct, outcomes.length) : null,
  };
}

function questionItems(
  query: ParsedAnalyticsQuery,
  attempts: readonly AnalyticsAttemptRow[],
  allFacts: readonly AnalyticsFactRow[],
  calibrationEnabled = true,
): QuestionAnalyticsItemDto[] {
  if (
    calibrationEnabled
    && query.candidatePolicy === 'latest'
    && query.questionKind === 'all'
  ) {
    const displayItems = questionItems(
      { ...query, qualityStatus: 'all' },
      attempts,
      allFacts,
      false,
    );
    const baseItems = new Map(questionItems(
      { ...query, questionKind: 'base', qualityStatus: 'all' },
      attempts,
      allFacts,
      true,
    ).map((item) => [item.questionId, item]));
    return sortQuestionAnalyticsItems(query, displayItems.map((item) => {
      const calibration = baseItems.get(item.questionId);
      return calibration ? {
        ...item,
        discrimination: calibration.discrimination,
        quality: calibration.quality,
        qualityWarnings: calibration.qualityWarnings,
        recommendation: calibration.recommendation,
        signals: calibration.signals,
      } : item;
    }).filter((item) => questionAnalyticsMatches({ ...query, q: null }, item, item.promptPreview)));
  }
  const effectiveCalibration = calibrationEnabled
    && query.candidatePolicy === 'latest'
    && query.questionKind === 'base';
  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const baseAwardedByAttempt = new Map<string, number>();
  for (const row of allFacts) {
    if (row.questionKind !== 'base' || row.awardedScore === null) continue;
    baseAwardedByAttempt.set(
      row.attemptId,
      (baseAwardedByAttempt.get(row.attemptId) ?? 0) + row.awardedScore,
    );
  }
  const grouped = new Map<number, AnalyticsFactRow[]>();
  for (const row of allFacts) {
    if (!factMatches(query, row)) continue;
    const rows = grouped.get(row.questionId) ?? [];
    rows.push(row);
    grouped.set(row.questionId, rows);
  }

  const preliminary = [...grouped]
    .map(([questionId, rows]) => {
      const first = rows[0];
      const presented = rows.filter((row) => row.presentedAt !== null);
      const outcomes = presented.filter(isExactOutcome);
      const responseTimes = outcomes.flatMap((row) => (
        row.answerOrigin === 'submitted'
          && row.canonicalSelectedIndex !== null
          && row.elapsedSeconds !== null
          ? [row.elapsedSeconds]
          : []
      ));
      const summary = summarizeQuestionFacts(
        outcomes.map((row) => {
          const attempt = attemptById.get(row.attemptId);
          const baseAwarded = baseAwardedByAttempt.get(row.attemptId);
          const restMaximum = attempt ? attempt.baseMaxScore - row.scoreValue : 0;
          const restScore = row.questionKind === 'base'
            && attempt
            && baseAwarded !== undefined
            && row.awardedScore !== null
            && restMaximum > 0
            ? (100 * (baseAwarded - row.awardedScore)) / restMaximum
            : null;
          return {
            correct: row.isCorrect,
            timedOut: row.timedOut,
            elapsedSeconds: row.elapsedSeconds ?? 0,
            selectedIndex: row.canonicalSelectedIndex,
            restScore,
            submitted: row.answerOrigin === 'submitted',
          };
        }),
        first.choiceCount,
        first.correctIndex,
        query.minSample,
      );
      const lastPresented = presented.reduce<number | null>(
        (latest, row) => latest === null || row.presentedAt! > latest ? row.presentedAt : latest,
        null,
      );
      const lastAnswered = outcomes.reduce<number | null>(
        (latest, row) => latest === null || row.answeredAt! > latest ? row.answeredAt : latest,
        null,
      );
      return {
        rows,
        summary,
        responseTimes,
        rawMedianSeconds: median(responseTimes),
        rawSuccessRate: roundedRate(outcomes.filter((row) => row.isCorrect).length, outcomes.length),
        rawTimeoutRate: roundedRate(outcomes.filter((row) => row.timedOut).length, outcomes.length),
        item: {
        questionId,
        promptPreview: questionPromptPreview(first.prompt),
        topic: first.topic,
        difficulty: first.difficulty,
        active: first.active,
        kind: query.questionKind,
        assignedCount: rows.length,
        presentedCount: presented.length,
        outcomeCount: outcomes.length,
        sampleSize: summary.sampleSize,
        reliability: summary.reliability,
        completionRate: roundedRate(outcomes.length, presented.length),
        successRate: summary.successRate,
        timeoutRate: summary.timeoutRate,
        averageSeconds: outcomes.length >= query.minSample ? average(responseTimes) : null,
        medianSeconds: summary.medianSeconds,
        minSeconds: outcomes.length >= query.minSample && responseTimes.length
          ? Math.min(...responseTimes)
          : null,
        maxSeconds: outcomes.length >= query.minSample && responseTimes.length
          ? Math.max(...responseTimes)
          : null,
        lastPresentedAt: iso(lastPresented),
        lastAnsweredAt: iso(lastAnswered),
        discrimination: effectiveCalibration ? summary.discrimination : null,
        base: kindSplit(rows.filter((row) => row.questionKind === 'base'), query.minSample),
        additional: kindSplit(
          rows.filter((row) => row.questionKind === 'additional'),
          query.minSample,
        ),
        quality: {
          enabled: false,
          earned: null,
          maxAvailable: null,
          partial: true,
          status: 'disabled',
          critical: false,
          components: [],
        },
        qualityWarnings: [],
        recommendation: effectiveCalibration ? summary.recommendation : null,
        observed: observedQuestionMetrics({
          assignedCount: rows.length,
          presentedCount: presented.length,
          outcomeCount: outcomes.length,
          submittedCount: responseTimes.length,
          correctCount: outcomes.filter((row) => row.isCorrect).length,
          timeoutCount: outcomes.filter((row) => row.timedOut).length,
          averageSeconds: average(responseTimes),
          medianSeconds: median(responseTimes),
          minSeconds: responseTimes.length ? Math.min(...responseTimes) : null,
          maxSeconds: responseTimes.length ? Math.max(...responseTimes) : null,
        }),
        sample: questionSample(outcomes.length),
        signals: questionAnalyticsSignals({
          difficulty: first.difficulty,
          sample: questionSample(outcomes.length),
          successRate: null,
          timeoutRate: null,
          medianSeconds: null,
          peerMedianSeconds: null,
          peerCount: 0,
          discrimination: null,
        }),
        } satisfies QuestionAnalyticsItemDto,
      };
    });
  const peerGroups = new Map<string, Array<{ questionId: number; value: number }>>();
  const peerKeys = new Set(preliminary.map(({ item }) => `${item.difficulty}\u0000${item.kind}`));
  for (const key of peerKeys) {
    const values = preliminary.flatMap((entry) => (
      `${entry.item.difficulty}\u0000${entry.item.kind}` === key
        && entry.item.sampleSize >= 30
        && entry.rawMedianSeconds !== null
        ? [{ questionId: entry.item.questionId, value: entry.rawMedianSeconds }]
        : []
    ));
    peerGroups.set(key, values);
  }

  const enriched = preliminary
    .map(({ item, summary, rawMedianSeconds, rawSuccessRate, rawTimeoutRate }) => {
      if (!effectiveCalibration) return item;
      const peerValues = (peerGroups.get(`${item.difficulty}\u0000${item.kind}`) ?? [])
        .filter((peer) => peer.questionId !== item.questionId)
        .map((peer) => peer.value);
      const peerMedianSeconds = median(peerValues);
      const result = questionQuality({
        difficulty: item.difficulty,
        sampleSize: item.sampleSize,
        successRate: rawSuccessRate,
        timeoutRate: rawTimeoutRate,
        medianSeconds: rawMedianSeconds,
        peerMedianSeconds,
        peerCount: peerValues.length,
        functioningDistractors: summary.functioningDistractorCount,
        distractorCount: summary.distractorCount,
        discrimination: summary.discrimination,
      });
      return {
        ...item,
        quality: result.quality,
        qualityWarnings: result.warnings,
        signals: questionAnalyticsSignals({
          difficulty: item.difficulty,
          sample: item.sample,
          successRate: rawSuccessRate,
          timeoutRate: rawTimeoutRate,
          medianSeconds: rawMedianSeconds,
          peerMedianSeconds,
          peerCount: peerValues.length,
          discrimination: summary.discrimination,
        }),
      };
    });
  return sortQuestionAnalyticsItems(
    query,
    enriched.filter((item) => questionAnalyticsMatches(
      query,
      item,
      (() => {
        const row = grouped.get(item.questionId)?.[0];
        return row ? `${row.prompt}\n${row.context ?? ''}` : item.promptPreview;
      })(),
    )),
  );
}

export function buildQuestionList(
  query: ParsedAnalyticsQuery,
  attempts: readonly AnalyticsAttemptRow[],
  facts: readonly AnalyticsFactRow[],
  calibrationEnabled = true,
): QuestionAnalyticsListDto {
  const allItems = questionItems(query, attempts, facts, calibrationEnabled);
  const summaryItems = query.qualityStatus === 'all'
    ? allItems
    : questionItems(
        { ...query, qualityStatus: 'all' },
        attempts,
        facts,
        calibrationEnabled,
      );
  const items = allItems.slice(query.cursorOffset, query.cursorOffset + query.limit);
  const nextOffset = query.cursorOffset + items.length;
  return {
    questionAnalyticsModelVersion: QUESTION_ANALYTICS_MODEL_VERSION,
    cohort: cohortDto(query, attempts, facts, calibrationEnabled),
    items,
    totalCount: allItems.length,
    summary: questionAnalyticsSummary(summaryItems),
    nextCursor: nextOffset < allItems.length ? analyticsCursor(nextOffset) : null,
  };
}

export function buildQuestionDetail(
  query: ParsedAnalyticsQuery,
  attempts: readonly AnalyticsAttemptRow[],
  facts: readonly AnalyticsFactRow[],
  questionId: number,
  calibrationEnabled = true,
): Omit<QuestionAnalyticsDetailDto, 'reviewHistory'> | null {
  const item = questionItems(
    { ...query, qualityStatus: 'all' },
    attempts,
    facts,
    calibrationEnabled,
  ).find((candidate) => candidate.questionId === questionId);
  if (!item) return null;
  const rows = facts.filter((row) => row.questionId === questionId && factMatches(query, row));
  const first = rows[0];
  const outcomes = rows.filter(isExactOutcome);
  const baseAwarded = new Map<string, number>();
  for (const row of facts) {
    if (row.questionKind === 'base' && row.awardedScore !== null) {
      baseAwarded.set(row.attemptId, (baseAwarded.get(row.attemptId) ?? 0) + row.awardedScore);
    }
  }
  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const summary = summarizeQuestionFacts(
    outcomes.map((row) => {
      const attempt = attemptById.get(row.attemptId);
      const maximum = attempt ? attempt.baseMaxScore - row.scoreValue : 0;
      return {
        correct: row.isCorrect,
        timedOut: row.timedOut,
        elapsedSeconds: row.elapsedSeconds ?? 0,
        selectedIndex: row.canonicalSelectedIndex,
        submitted: row.answerOrigin === 'submitted',
        restScore: row.questionKind === 'base'
          && attempt
          && row.awardedScore !== null
          && maximum > 0
          ? (100 * ((baseAwarded.get(row.attemptId) ?? 0) - row.awardedScore)) / maximum
          : null,
      };
    }),
    first.choiceCount,
    first.correctIndex,
    query.minSample,
  );
  return {
    ...item,
    bankRevision: query.bankRevision!,
    prompt: first.prompt,
    contextType: first.contextType,
    context: first.context,
    responseCount: summary.responseCount,
    choices: summary.choices,
  };
}

function candidateItem(
  attempt: AnalyticsAttemptRow,
  facts: readonly AnalyticsFactRow[],
): CandidateAnalyticsItemDto {
  const rows = facts.filter((row) => row.attemptId === attempt.id && isResolvedFact(row));
  const base = rows.filter((row) => row.questionKind === 'base');
  const additional = rows.filter((row) => row.questionKind === 'additional');
  return {
    attemptId: attempt.id,
    alias: adminCandidateAlias(attempt.id),
    candidateName: attempt.candidateName ?? null,
    completedAt: new Date(attempt.completedAt).toISOString(),
    score: attempt.score,
    accuracy: calculateAccuracy(attempt.correctCount, attempt.wrongCount),
    verdict: attempt.verdict,
    durationSeconds: attempt.durationSeconds,
    baseAnswered: base.length,
    baseCorrect: base.filter((row) => row.isCorrect).length,
    additionalAnswered: additional.length,
    additionalCorrect: additional.filter((row) => row.isCorrect).length,
    timeoutCount: rows.filter((row) => row.timedOut).length,
  };
}

export function buildCandidateList(
  query: ParsedAnalyticsQuery,
  attempts: readonly AnalyticsAttemptRow[],
  facts: readonly AnalyticsFactRow[],
  calibrationEnabled = true,
): AnalyticsListDto<CandidateAnalyticsItemDto> & { nextCursor: string | null } {
  const filteredAttempts = attempts.filter((attempt) => {
    if (!query.topic && !query.difficulty && query.questionKind === 'all') return true;
    return facts.some((row) => row.attemptId === attempt.id && factMatches(query, row));
  });
  const items = filteredAttempts
    .slice(query.cursorOffset, query.cursorOffset + query.limit)
    .map((attempt) => candidateItem(attempt, facts));
  const nextOffset = query.cursorOffset + items.length;
  return {
    cohort: cohortDto(query, attempts, facts, calibrationEnabled),
    items,
    nextCursor: nextOffset < filteredAttempts.length ? analyticsCursor(nextOffset) : null,
  };
}

function groupItems(
  query: ParsedAnalyticsQuery,
  facts: readonly AnalyticsFactRow[],
  key: (row: AnalyticsFactRow) => string,
) {
  const groups = new Map<string, AnalyticsFactRow[]>();
  for (const row of facts) {
    if (!factMatches(query, row) || !isExactOutcome(row)) continue;
    const groupKey = key(row);
    const rows = groups.get(groupKey) ?? [];
    rows.push(row);
    groups.set(groupKey, rows);
  }
  return [...groups]
    .map(([groupKey, rows]): GroupAnalyticsItemDto => {
      const times = rows.flatMap((row) => (
        row.answerOrigin === 'submitted'
          && row.canonicalSelectedIndex !== null
          && row.elapsedSeconds !== null
          ? [row.elapsedSeconds]
          : []
      ));
      const correct = rows.filter((row) => row.isCorrect).length;
      return {
        key: groupKey,
        kind: query.questionKind,
        sampleSize: rows.length,
        // These are observed facts, not calibration conclusions. Keep them visible
        // even for a small cohort and communicate uncertainty through reliability.
        successRate: roundedRate(correct, rows.length),
        timeoutRate: roundedRate(rows.filter((row) => row.timedOut).length, rows.length),
        medianSeconds: median(times),
        reliability: analyticsReliability(rows.length),
      };
    })
    .toSorted((left, right) => left.key.localeCompare(right.key, 'ru-RU'));
}

export function buildTopicList(
  query: ParsedAnalyticsQuery,
  attempts: readonly AnalyticsAttemptRow[],
  facts: readonly AnalyticsFactRow[],
  calibrationEnabled = true,
): AnalyticsListDto<GroupAnalyticsItemDto> {
  return {
    cohort: cohortDto(query, attempts, facts, calibrationEnabled),
    items: groupItems(query, facts, (row) => row.topic),
  };
}

export function buildDifficultyList(
  query: ParsedAnalyticsQuery,
  attempts: readonly AnalyticsAttemptRow[],
  facts: readonly AnalyticsFactRow[],
  calibrationEnabled = true,
): AnalyticsListDto<GroupAnalyticsItemDto> {
  return {
    cohort: cohortDto(query, attempts, facts, calibrationEnabled),
    items: groupItems(query, facts, (row) => row.difficulty),
  };
}

export function buildCandidatePrint(
  attempts: readonly AnalyticsAttemptRow[],
  facts: readonly AnalyticsFactRow[],
  attemptId: string,
): CandidatePrintDto | null {
  const attempt = attempts.find((candidate) => candidate.id === attemptId);
  if (!attempt) return null;
  const attemptFacts = facts.filter((row) => row.attemptId === attemptId);
  const candidate = candidateItem(attempt, attemptFacts);
  const insightFacts = attemptFacts.map((row) => ({
    questionId: row.questionId,
    questionKind: row.questionKind,
    topic: row.topic,
    dedupeKey: row.dedupeKey,
    scoreValue: row.scoreValue,
    assigned: true,
    presented: row.presentedAt !== null,
    resolved: isResolvedFact(row),
    correct: row.isCorrect,
    timedOut: row.timedOut,
    answerOrigin: row.answerOrigin,
    awardedScore: row.awardedScore ?? 0,
    elapsedSeconds: row.elapsedSeconds,
  }));
  const insights = buildCandidateInsights(insightFacts);
  const difficultyInsights = buildCandidateInsights(insightFacts.map((fact, index) => ({
    ...fact,
    topic: attemptFacts[index].difficulty,
  })));
  const mapGroup = (
    key: string,
    classification: CandidateDimensionPerformanceDto['classification'],
    base: CandidateTopicGroup,
    additional: CandidateTopicGroup,
  ): CandidateDimensionPerformanceDto => ({
    key,
    classification,
    base: {
      assigned: base.assignedCount,
      presented: base.presentedCount,
      resolved: base.resolvedCount,
      correct: base.correctCount,
      incorrect: base.incorrectCount,
      timedOut: base.timeoutCount,
      earned: base.earnedScore,
      max: base.maxEarnableScore,
      accuracy: base.accuracy,
      averageSubmittedSeconds: base.averageSubmittedSeconds,
    },
    additional: {
      assigned: additional.assignedCount,
      presented: additional.presentedCount,
      resolved: additional.resolvedCount,
      correct: additional.correctCount,
      incorrect: additional.incorrectCount,
      timedOut: additional.timeoutCount,
      earned: additional.earnedScore,
      max: additional.maxEarnableScore,
      accuracy: additional.accuracy,
      recovered: additional.earnedScore,
    },
  });
  const topics = insights.topics.map((topic) => mapGroup(
    topic.topic,
    topic.classification,
    topic.base,
    topic.additional,
  ));
  const difficulties = difficultyInsights.topics.map((difficulty) => mapGroup(
    difficulty.topic,
    difficulty.classification,
    difficulty.base,
    difficulty.additional,
  ));
  return {
    ...candidate,
    generatedAt: new Date(attempt.completedAt).toISOString(),
    statisticsCompleteness: attemptFacts.some(
      (row) => row.answerId !== null && !isResolvedFact(row),
    ) ? 'partial' : 'complete',
    topics,
    difficulties,
    interviewerRecommendations: interviewerRecommendations({
      candidate,
      weaknesses: insights.checkAreas.map((area) => ({
        topic: area.topic,
        dedupeKey: area.dedupeKey,
        lostScore: area.lostBaseScore,
        wrongCount: area.questionIds.length,
        timeoutCount: area.timeoutCount,
      })),
    }),
    questions: [],
  };
}

function overviewPeriod(
  rows: readonly AnalyticsOverviewAttemptRow[],
  from: number | null,
  to: number,
): AnalyticsOverviewPeriodDto {
  const windowRows = rows.filter((row) => row.eventAt < to && (from === null || row.eventAt >= from));
  const completed = windowRows.filter((row) => row.status === 'completed');
  const uniqueCandidates = new Set(windowRows.map((row) => row.candidateKey)).size;
  const accuracies = completed.map((row) => calculateAccuracy(row.correctCount, row.wrongCount));
  const selectionEligible = completed.filter((row) => (
    row.selectionVersion === 1 && Number.isFinite(row.coverageScore)
  ));
  const selectionSample = selectionEligible.filter((row) => Number.isFinite(row.shadowCoverageScore));
  const actualCoverage = selectionSample.map((row) => row.coverageScore!);
  const shadowCoverage = selectionSample.map((row) => row.shadowCoverageScore!);
  const fallbackOrNullCount = selectionEligible.length - selectionSample.length;
  const histogram = [
    { from: 0, to: 49 },
    { from: 50, to: 59 },
    { from: 60, to: 69 },
    { from: 70, to: 79 },
    { from: 80, to: 89 },
    { from: 90, to: 100 },
  ].map((bucket) => ({
    ...bucket,
    count: completed.filter((row) => row.score >= bucket.from && row.score <= bucket.to).length,
  }));
  return {
    from: iso(from),
    to: new Date(to).toISOString(),
    attempts: windowRows.length,
    completedAttempts: completed.length,
    abortedAttempts: windowRows.length - completed.length,
    uniqueCandidates,
    repeatAttempts: Math.max(0, windowRows.length - uniqueCandidates),
    meanScore: average(completed.map((row) => row.score)),
    medianScore: median(completed.map((row) => row.score)),
    meanAccuracy: average(accuracies),
    medianAccuracy: median(accuracies),
    meanDurationSeconds: average(completed.map((row) => row.durationSeconds)),
    medianDurationSeconds: median(completed.map((row) => row.durationSeconds)),
    verdicts: {
      PASS: completed.filter((row) => row.verdict === 'PASS').length,
      REVIEW: completed.filter((row) => row.verdict === 'REVIEW').length,
      FAIL: completed.filter((row) => row.verdict === 'FAIL').length,
    },
    scoreHistogram: histogram,
    selectionComparison: {
      eligibleAttempts: selectionEligible.length,
      sampleSize: selectionSample.length,
      actualCoverage: average(actualCoverage),
      shadowCoverage: average(shadowCoverage),
      delta: average(selectionSample.map((row) => row.shadowCoverageScore! - row.coverageScore!)),
      fallbackOrNullCount,
      fallbackOrNullRate: roundedRate(fallbackOrNullCount, selectionEligible.length),
    },
  };
}

export function buildOverview(
  query: ParsedAnalyticsQuery,
  attempts: readonly AnalyticsAttemptRow[],
  facts: readonly AnalyticsFactRow[],
  allRows: readonly AnalyticsOverviewAttemptRow[],
  now = Date.now(),
  calibrationEnabled = true,
): AnalyticsOverviewDto {
  const end = Math.min(query.toExclusiveMs ?? now, now);
  const allStart = null;
  const last30Start = end - 30 * DAY_MS;
  return {
    cohort: cohortDto(query, attempts, facts, calibrationEnabled),
    last30Days: overviewPeriod(allRows, last30Start, end),
    allTime: overviewPeriod(allRows, allStart, end),
  };
}

export function buildTrends(
  query: ParsedAnalyticsQuery,
  attempts: readonly AnalyticsAttemptRow[],
  facts: readonly AnalyticsFactRow[],
  calibrationEnabled = true,
): AnalyticsListDto<AnalyticsTrendItemDto> {
  const groups = new Map<string, AnalyticsAttemptRow[]>();
  for (const attempt of attempts) {
    const day = moscowDateFormatter.format(new Date(attempt.completedAt));
    const rows = groups.get(day) ?? [];
    rows.push(attempt);
    groups.set(day, rows);
  }
  const dimensions = (
    date: string,
    key: 'topic' | 'difficulty',
  ) => {
    const attemptIds = new Set((groups.get(date) ?? []).map((attempt) => attempt.id));
    const values = new Map<string, AnalyticsFactRow[]>();
    for (const fact of facts) {
      if (!attemptIds.has(fact.attemptId) || !factMatches(query, fact) || !isExactOutcome(fact)) {
        continue;
      }
      const dimensionKey = key === 'topic' ? fact.topic : fact.difficulty;
      const rows = values.get(dimensionKey) ?? [];
      rows.push(fact);
      values.set(dimensionKey, rows);
    }
    return [...values].map(([dimensionKey, rows]) => ({
      key: dimensionKey,
      outcomeCount: rows.length,
      successRate: roundedRate(rows.filter((row) => row.isCorrect).length, rows.length),
      timeoutRate: roundedRate(rows.filter((row) => row.timedOut).length, rows.length),
    })).toSorted((left, right) => left.key.localeCompare(right.key, 'ru'));
  };
  const items = [...groups].map(([date, rows]): AnalyticsTrendItemDto => ({
    date,
    attempts: rows.length,
    averageScore: average(rows.map((row) => row.score)),
    medianScore: median(rows.map((row) => row.score)),
    averageAccuracy: average(rows.map((row) => calculateAccuracy(row.correctCount, row.wrongCount))),
    passRate: roundedRate(rows.filter((row) => row.verdict === 'PASS').length, rows.length),
    averageDurationSeconds: average(rows.map((row) => row.durationSeconds)),
    medianDurationSeconds: median(rows.map((row) => row.durationSeconds)),
    verdicts: {
      PASS: rows.filter((row) => row.verdict === 'PASS').length,
      REVIEW: rows.filter((row) => row.verdict === 'REVIEW').length,
      FAIL: rows.filter((row) => row.verdict === 'FAIL').length,
    },
    topics: dimensions(date, 'topic'),
    difficulties: dimensions(date, 'difficulty'),
  })).toSorted((left, right) => left.date.localeCompare(right.date));
  return { cohort: cohortDto(query, attempts, facts, calibrationEnabled), items };
}

export function buildRevisions(
  query: ParsedAnalyticsQuery,
  attempts: readonly AnalyticsAttemptRow[],
  facts: readonly AnalyticsFactRow[],
  calibrationEnabled = true,
): AnalyticsListDto<AnalyticsRevisionItemDto> {
  const groups = new Map<string, AnalyticsAttemptRow[]>();
  for (const attempt of attempts) {
    const rows = groups.get(attempt.bankRevision) ?? [];
    rows.push(attempt);
    groups.set(attempt.bankRevision, rows);
  }
  const items = [...groups].map(([revision, rows]): AnalyticsRevisionItemDto => {
    const completed = rows.map((row) => row.completedAt);
    return {
      revision,
      attempts: rows.length,
      firstCompletedAt: new Date(Math.min(...completed)).toISOString(),
      lastCompletedAt: new Date(Math.max(...completed)).toISOString(),
      averageScore: average(rows.map((row) => row.score)),
      averageAccuracy: average(rows.map((row) => calculateAccuracy(row.correctCount, row.wrongCount))),
    };
  }).toSorted((left, right) => right.lastCompletedAt.localeCompare(left.lastCompletedAt));
  return { cohort: cohortDto(query, attempts, facts, calibrationEnabled), items };
}
