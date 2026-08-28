import type {
  AnalyticsReliability,
  AnalyticsSampleGate,
  CandidateAnalyticsItemDto,
  InterviewerRecommendationDto,
  QuestionQualityDto,
  QuestionQualityWarning,
  QuestionChoiceAnalyticsDto,
  QuestionRecommendationDto,
} from './analytics-contract.ts';

export type PointBiserialObservation = {
  correct: boolean;
  restScore: number;
};

export type QuestionAnalyticsFact = {
  correct: boolean;
  timedOut: boolean;
  elapsedSeconds: number;
  selectedIndex: number | null;
  restScore: number | null;
  submitted: boolean;
};

export const EXPECTED_SUCCESS_RANGES: Record<string, { min: number; max: number }> = {
  easy: { min: 75, max: 95 },
  medium: { min: 55, max: 80 },
  hard: { min: 30, max: 60 },
  expert: { min: 10, max: 40 },
};

export function roundedRate(numerator: number, denominator: number) {
  if (denominator <= 0) return null;
  return Math.round((1000 * numerator) / denominator) / 10;
}

export function median(values: readonly number[]) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 10) / 10;
}

export function analyticsReliability(sampleSize: number): AnalyticsReliability {
  if (sampleSize < 30) return 'insufficient';
  if (sampleSize < 50) return 'descriptive';
  if (sampleSize < 100) return 'directional';
  return 'stable';
}

export function pointBiserial(observations: readonly PointBiserialObservation[]) {
  const valid = observations.filter((item) => Number.isFinite(item.restScore));
  if (valid.length < 2) return null;
  const n = valid.length;
  let sumX = 0;
  let sumY = 0;
  let sumY2 = 0;
  let sumXY = 0;
  for (const observation of valid) {
    const x = observation.correct ? 1 : 0;
    const y = observation.restScore;
    sumX += x;
    sumY += y;
    sumY2 += y * y;
    sumXY += x * y;
  }
  return pointBiserialFromSums({ n, sumX, sumY, sumY2, sumXY });
}

export function pointBiserialFromSums(input: {
  n: number;
  sumX: number;
  sumY: number;
  sumY2: number;
  sumXY: number;
}) {
  const { n, sumX, sumY, sumY2, sumXY } = input;
  if (n < 2) return null;
  const xVariance = n * sumX - sumX * sumX;
  const yVariance = n * sumY2 - sumY * sumY;
  const denominator = Math.sqrt(xVariance * yVariance);
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const coefficient = (n * sumXY - sumX * sumY) / denominator;
  return Math.round(Math.max(-1, Math.min(1, coefficient)) * 1_000) / 1_000;
}

export function questionRecommendation(input: {
  sampleSize: number;
  correctRate: number | null;
  timeoutRate: number | null;
  discrimination: number | null;
  deadDistractors: number;
}): QuestionRecommendationDto {
  const reasons: string[] = [];
  if (input.sampleSize < 30) {
    return {
      code: 'collect_more_data',
      label: 'Накопить данные',
      reasons: [`Для первичной оценки нужно минимум 30 предъявлений; сейчас ${input.sampleSize}.`],
    };
  }
  if (input.sampleSize >= 50 && input.discrimination !== null && input.discrimination < 0) {
    reasons.push(`Отрицательная дискриминация: ${input.discrimination.toFixed(3)}.`);
    return { code: 'review_answer_key', label: 'Проверить ключ ответа', reasons };
  }
  if (input.timeoutRate !== null && input.timeoutRate >= 25) {
    reasons.push(`Таймауты: ${input.timeoutRate.toFixed(1)}%.`);
    return { code: 'review_time_limit', label: 'Проверить объём и лимит времени', reasons };
  }
  if (
    input.sampleSize >= 50 &&
    input.discrimination !== null &&
    input.discrimination < 0.1
  ) {
    reasons.push(`Слабая дискриминация: ${input.discrimination.toFixed(3)}.`);
    return { code: 'rewrite_question', label: 'Переформулировать вопрос', reasons };
  }
  if (input.sampleSize >= 50 && input.deadDistractors > 0) {
    reasons.push(`Неработающих дистракторов: ${input.deadDistractors}.`);
    return { code: 'improve_distractors', label: 'Усилить варианты ответа', reasons };
  }
  if (input.correctRate !== null && input.correctRate <= 30) {
    reasons.push(`Правильных ответов: ${input.correctRate.toFixed(1)}%.`);
    return { code: 'rewrite_question', label: 'Проверить сложность формулировки', reasons };
  }
  return {
    code: 'keep',
    label: 'Оставить без изменений',
    reasons: ['Статистически значимых сигналов для изменения не найдено.'],
  };
}

export function summarizeQuestionFacts(
  facts: readonly QuestionAnalyticsFact[],
  choiceCount: number,
  correctIndex: number,
  minSample: AnalyticsSampleGate,
) {
  const sampleSize = facts.length;
  const responseFacts = facts.filter((fact) => fact.submitted && fact.selectedIndex !== null);
  const correctCount = facts.filter((fact) => fact.correct).length;
  const timeoutCount = facts.filter((fact) => fact.timedOut).length;
  const choiceCounts = new Array<number>(choiceCount).fill(0);
  for (const fact of responseFacts) {
    if (fact.selectedIndex! >= 0 && fact.selectedIndex! < choiceCounts.length) {
      choiceCounts[fact.selectedIndex!] += 1;
    }
  }
  const sufficientlySampled = sampleSize >= minSample;
  const discrimination = sampleSize >= 100
    ? pointBiserial(facts.flatMap((fact) => fact.restScore === null
      ? []
      : [{ correct: fact.correct, restScore: fact.restScore }]))
    : null;
  const choiceAnalytics: QuestionChoiceAnalyticsDto[] = choiceCounts.map((selectedCount, index) => {
    const selectedRate = roundedRate(choiceCounts[index], responseFacts.length);
    return {
      canonicalIndex: index,
      selectedCount,
      selectedRate,
    };
  });
  const distractorRates = choiceAnalytics
    .filter((choice) => choice.canonicalIndex !== correctIndex)
    .map((choice) => choice.selectedRate);
  const functioningDistractorCount = sampleSize < 50
    ? 0
    : distractorRates.filter((rate) => rate !== null && rate >= 5).length;
  const deadDistractors = sampleSize < 50
    ? 0
    : distractorRates.length - functioningDistractorCount;
  const successRate = sufficientlySampled ? roundedRate(correctCount, sampleSize) : null;
  const timeoutRate = sufficientlySampled ? roundedRate(timeoutCount, sampleSize) : null;
  const medianSeconds = sufficientlySampled
    ? median(responseFacts.map((fact) => fact.elapsedSeconds))
    : null;
  return {
    sampleSize,
    responseCount: responseFacts.length,
    successRate,
    timeoutRate,
    medianSeconds,
    discrimination,
    reliability: analyticsReliability(sampleSize),
    choices: choiceAnalytics,
    functioningDistractorCount,
    distractorCount: distractorRates.length,
    deadDistractors,
    recommendation: questionRecommendation({
      sampleSize,
      correctRate: roundedRate(correctCount, sampleSize),
      timeoutRate: roundedRate(timeoutCount, sampleSize),
      discrimination,
      deadDistractors,
    }),
  };
}

function boundedPoints(value: number, max: number) {
  return Math.max(0, Math.min(max, Math.round(value * 10) / 10));
}

export function questionQuality(input: {
  difficulty: string;
  sampleSize: number;
  successRate: number | null;
  timeoutRate: number | null;
  medianSeconds: number | null;
  peerMedianSeconds: number | null;
  functioningDistractors: number;
  distractorCount: number;
  discrimination: number | null;
}) {
  const warnings: QuestionQualityWarning[] = [];
  if (input.sampleSize < 50) warnings.push('insufficient');
  const expected = EXPECTED_SUCCESS_RANGES[input.difficulty];
  if (input.sampleSize >= 30 && input.successRate !== null && expected) {
    if (input.successRate > expected.max) warnings.push('too_easy');
    if (input.successRate < expected.min) warnings.push('too_hard');
  }
  if (input.sampleSize >= 30 && (input.timeoutRate ?? 0) >= 25) warnings.push('high_timeout');
  if (
    input.sampleSize >= 30 &&
    input.medianSeconds !== null &&
    input.peerMedianSeconds !== null &&
    input.medianSeconds >= input.peerMedianSeconds * 1.5
  ) warnings.push('slow');
  if (input.sampleSize >= 100 && input.discrimination !== null && input.discrimination < 0) {
    warnings.push('negative_discrimination');
  }

  const components: QuestionQualityDto['components'] = [];
  const qualityAvailable = input.sampleSize >= 50;
  let difficultyPoints = 0;
  if (qualityAvailable && expected && input.successRate !== null) {
    if (input.successRate >= expected.min && input.successRate <= expected.max) {
      difficultyPoints = 30;
    } else {
      const distance = input.successRate < expected.min
        ? expected.min - input.successRate
        : input.successRate - expected.max;
      difficultyPoints = boundedPoints(30 * (1 - distance / 30), 30);
    }
  }
  components.push({
    key: 'difficulty_fit',
    earned: difficultyPoints,
    max: 30,
    available: qualityAvailable && Boolean(expected) && input.successRate !== null,
  });

  const timeoutAvailable = qualityAvailable && input.timeoutRate !== null;
  const timeoutPoints = !timeoutAvailable
    ? 0
    : input.timeoutRate! < 10 ? 20 : input.timeoutRate! < 25 ? 10 : 0;
  components.push({ key: 'timeout_health', earned: timeoutPoints, max: 20, available: timeoutAvailable });

  const timingAvailable = qualityAvailable
    && input.medianSeconds !== null
    && input.peerMedianSeconds !== null;
  const timingPoints = timingAvailable && input.medianSeconds! < input.peerMedianSeconds! * 1.5
    ? 10
    : 0;
  components.push({ key: 'timing_consistency', earned: timingPoints, max: 10, available: timingAvailable });

  const distractorAvailable = qualityAvailable && input.distractorCount > 0;
  const distractorPoints = distractorAvailable
    ? boundedPoints(20 * input.functioningDistractors / input.distractorCount, 20)
    : 0;
  components.push({ key: 'distractor', earned: distractorPoints, max: 20, available: distractorAvailable });

  const discriminationAvailable = input.sampleSize >= 100 && input.discrimination !== null;
  const discriminationPoints = !discriminationAvailable
    ? 0
    : input.discrimination! >= 0.2 ? 20
      : input.discrimination! >= 0.1 ? 10
        : input.discrimination! >= 0 ? 5 : 0;
  components.push({
    key: 'discrimination',
    earned: discriminationPoints,
    max: 20,
    available: discriminationAvailable,
  });

  const earned = components.reduce((total, component) => (
    total + (component.available ? component.earned : 0)
  ), 0);
  const maxAvailable = components.reduce((total, component) => (
    total + (component.available ? component.max : 0)
  ), 0);
  const critical = input.sampleSize >= 100
    && input.discrimination !== null
    && input.discrimination < 0
    || input.sampleSize >= 50 && (input.timeoutRate ?? 0) >= 40;
  const status: QuestionQualityDto['status'] = input.sampleSize < 50
    ? 'insufficient'
    : critical || earned < 50 ? 'review'
      : earned < 75 ? 'observe' : 'good';
  return {
    quality: {
      enabled: true,
      earned,
      maxAvailable,
      partial: maxAvailable < 100,
      status,
      critical,
      components,
    } satisfies QuestionQualityDto,
    warnings,
  };
}

function priorityRank(priority: InterviewerRecommendationDto['priority']) {
  return priority === 'high' ? 0 : priority === 'medium' ? 1 : 2;
}

export type InterviewerWeakness = {
  topic: string;
  dedupeKey: string;
  lostScore: number;
  wrongCount: number;
  timeoutCount: number;
};

export function interviewerRecommendations(input: {
  candidate: CandidateAnalyticsItemDto;
  weaknesses: readonly InterviewerWeakness[];
}): InterviewerRecommendationDto[] {
  return input.weaknesses
    .filter((weakness) => weakness.lostScore > 0 || weakness.timeoutCount > 0)
    .toSorted((left, right) => right.lostScore - left.lostScore
      || right.timeoutCount - left.timeoutCount
      || left.topic.localeCompare(right.topic, 'ru-RU')
      || left.dedupeKey.localeCompare(right.dedupeKey))
    .slice(0, 5)
    .map((weakness): InterviewerRecommendationDto => ({
      code: weakness.timeoutCount > weakness.wrongCount / 2
        ? 'clarify_time_management'
        : input.candidate.verdict === 'FAIL' ? 'verify_fundamentals' : 'probe_weak_topic',
      priority: weakness.lostScore >= 10 || weakness.timeoutCount >= 2 ? 'high' : 'medium',
      title: `Уточнить тему «${weakness.topic}»`,
      evidence: `Потеряно ${weakness.lostScore} базовых баллов; ошибок ${weakness.wrongCount}, таймаутов ${weakness.timeoutCount}.`,
    }))
    .toSorted((left, right) => priorityRank(left.priority) - priorityRank(right.priority)
      || left.title.localeCompare(right.title, 'ru-RU'));
}

function csvCell(value: string | number | null) {
  if (value === null) return '';
  let text = String(value);
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  return /[;"\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function semicolonCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
) {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(';'));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
