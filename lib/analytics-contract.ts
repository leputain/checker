import type { AttemptQuestionReviewDto } from './attempt-review.ts';

export const ANALYTICS_SAMPLE_GATES = [30, 50, 100] as const;
export const QUESTION_ANALYTICS_MODEL_VERSION = 2 as const;

export type AnalyticsSampleGate = (typeof ANALYTICS_SAMPLE_GATES)[number];
export type AnalyticsReliability = 'insufficient' | 'descriptive' | 'directional' | 'stable';
export type QuestionSampleStatus = 'insufficient' | 'early' | 'working' | 'stable';
export type QuestionAnalyticsSort =
  | 'priority'
  | 'timeout'
  | 'success'
  | 'sample'
  | 'lastPresented'
  | 'id';
export type AnalyticsSortDirection = 'asc' | 'desc';
export type AnalyticsQuestionKind = 'all' | 'base' | 'additional';
export type AnalyticsCandidatePolicy = 'latest' | 'all';
export type AnalyticsVerdict = 'PASS' | 'REVIEW' | 'FAIL';
export type AnalyticsQualityStatus = 'all' | 'needs_review' | 'healthy' | 'insufficient';
export type StatisticsCompleteness = 'complete' | 'partial';

export type AnalyticsCohortQuery = {
  from?: string;
  to?: string;
  bankRevision?: string;
  scoringVersion?: number;
  testConfigId?: string;
  testProfileId?: string;
  appVersion?: string;
  topic?: string;
  difficulty?: string;
  questionKind?: AnalyticsQuestionKind;
  qualityStatus?: AnalyticsQualityStatus;
  /** @deprecated Legacy presentation threshold; exact `observed` metrics are never gated. */
  minSample?: AnalyticsSampleGate;
  /** Full-bank server-side search. The API never returns answer choices or answer keys. */
  q?: string;
  minN?: number;
  sampleStatus?: QuestionSampleStatus | 'all';
  sort?: QuestionAnalyticsSort;
  direction?: AnalyticsSortDirection;
  candidatePolicy?: AnalyticsCandidatePolicy;
  cursor?: string;
  limit?: number;
  /** @deprecated Use bankRevision. */
  revision?: string;
  /** @deprecated Use questionKind. */
  kind?: AnalyticsQuestionKind;
};

export type AnalyticsCohortDto = {
  questionAnalyticsModelVersion: typeof QUESTION_ANALYTICS_MODEL_VERSION;
  from: string | null;
  to: string | null;
  bankRevision: string | null;
  scoringVersion: number;
  testConfigId: string;
  testProfileId: string;
  appVersion: string | null;
  topic: string | null;
  difficulty: string | null;
  questionKind: AnalyticsQuestionKind;
  qualityStatus: AnalyticsQualityStatus;
  minSample: AnalyticsSampleGate;
  candidatePolicy: AnalyticsCandidatePolicy;
  eligibleAttempts: number;
  eligibleAnswers: number;
  generatedAt: string;
  warnings: string[];
  statisticsCompleteness: StatisticsCompleteness;
  calibrationEnabled: boolean;
};

export type AdminSessionDto = {
  enabled: boolean;
  authenticated: boolean;
  expiresAt?: string;
  csrfToken?: string;
};

export type AdminApiErrorCode =
  | 'admin_disabled'
  | 'invalid_request'
  | 'unauthorized'
  | 'rate_limited'
  | 'csrf_invalid'
  | 'not_found'
  | 'bank_revision_conflict'
  | 'idempotency_conflict'
  | 'question_has_successor'
  | 'question_validation_failed'
  | 'question_bank_not_ready'
  | 'analytics_refresh_required'
  | 'analytics_unavailable';

export type AdminApiErrorDto = {
  error: AdminApiErrorCode;
};

export type AnalyticsOverviewDto = {
  cohort: AnalyticsCohortDto;
  last30Days: AnalyticsOverviewPeriodDto;
  allTime: AnalyticsOverviewPeriodDto;
};

export type AnalyticsSelectionComparisonDto = {
  eligibleAttempts: number;
  sampleSize: number;
  actualCoverage: number | null;
  shadowCoverage: number | null;
  delta: number | null;
  fallbackOrNullCount: number;
  fallbackOrNullRate: number | null;
};

export type AnalyticsOverviewPeriodDto = {
  from: string | null;
  to: string;
  attempts: number;
  completedAttempts: number;
  abortedAttempts: number;
  uniqueCandidates: number;
  repeatAttempts: number;
  meanScore: number | null;
  medianScore: number | null;
  meanAccuracy: number | null;
  medianAccuracy: number | null;
  meanDurationSeconds: number | null;
  medianDurationSeconds: number | null;
  verdicts: Record<AnalyticsVerdict, number>;
  scoreHistogram: Array<{ from: number; to: number; count: number }>;
  selectionComparison: AnalyticsSelectionComparisonDto;
};

export type QuestionRecommendationCode =
  | 'collect_more_data'
  | 'keep'
  | 'review_answer_key'
  | 'rewrite_question'
  | 'improve_distractors'
  | 'review_time_limit';

export type QuestionRecommendationDto = {
  code: QuestionRecommendationCode;
  label: string;
  reasons: string[];
};

export type QuestionAnalyticsItemDto = {
  questionId: number;
  /** Whitespace-normalized, server-truncated preview. Full text is available only in detail. */
  promptPreview: string;
  topic: string;
  difficulty: string;
  active: boolean;
  kind: Exclude<AnalyticsQuestionKind, 'all'> | 'all';
  assignedCount: number;
  presentedCount: number;
  outcomeCount: number;
  sampleSize: number;
  reliability: AnalyticsReliability;
  completionRate: number | null;
  successRate: number | null;
  timeoutRate: number | null;
  averageSeconds: number | null;
  medianSeconds: number | null;
  minSeconds: number | null;
  maxSeconds: number | null;
  lastPresentedAt: string | null;
  lastAnsweredAt: string | null;
  discrimination: number | null;
  base: QuestionKindSplitDto;
  additional: QuestionKindSplitDto;
  quality: QuestionQualityDto;
  qualityWarnings: QuestionQualityWarning[];
  recommendation: QuestionRecommendationDto | null;
  /** Exact observations. These fields are never hidden by statistical sample gates. */
  observed: QuestionObservedMetricsDto;
  sample: QuestionSampleDto;
  signals: QuestionAnalyticsSignalDto[];
};

export type QuestionObservedMetricsDto = {
  assignedCount: number;
  presentedCount: number;
  outcomeCount: number;
  submittedCount: number;
  correctCount: number;
  incorrectCount: number;
  timeoutCount: number;
  presentationRate: number | null;
  responseRate: number | null;
  completionRate: number | null;
  successRate: number | null;
  timeoutRate: number | null;
  timing: {
    sampleSize: number;
    averageSeconds: number | null;
    medianSeconds: number | null;
    minSeconds: number | null;
    maxSeconds: number | null;
  };
};

export type QuestionSampleDto = {
  n: number;
  status: QuestionSampleStatus;
  nextGate: AnalyticsSampleGate | null;
  remaining: number;
};

export type QuestionAnalyticsSignalCode =
  | 'sample_insufficient'
  | 'sample_early'
  | 'too_easy'
  | 'too_hard'
  | 'high_timeout'
  | 'slow'
  | 'negative_discrimination';

export type QuestionAnalyticsSignalDto = {
  code: QuestionAnalyticsSignalCode;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  explanation: string;
  observed: number | null;
  threshold: string | null;
};

export type AnalyticsBreakdownDto = {
  assigned: number;
  presented: number;
  resolved: number;
  correct: number;
  incorrect: number;
  timedOut: number;
  earned: number;
  max: number;
};

export type QuestionKindSplitDto = AnalyticsBreakdownDto & {
  successRate: number | null;
};

export type QuestionQualityStatus = 'good' | 'observe' | 'review' | 'insufficient' | 'disabled';
export type QuestionQualityWarning =
  | 'insufficient'
  | 'too_easy'
  | 'too_hard'
  | 'high_timeout'
  | 'slow'
  | 'negative_discrimination';

export type QuestionQualityComponent = {
  key: 'difficulty_fit' | 'timeout_health' | 'timing_consistency' | 'distractor' | 'discrimination';
  earned: number;
  max: number;
  available: boolean;
};

export type QuestionQualityDto = {
  enabled: boolean;
  earned: number | null;
  maxAvailable: number | null;
  partial: boolean;
  status: QuestionQualityStatus;
  critical: boolean;
  components: QuestionQualityComponent[];
};

export type QuestionChoiceAnalyticsDto = {
  canonicalIndex: number;
  selectedCount: number;
  selectedRate: number | null;
};

export type QuestionAnalyticsDetailDto = QuestionAnalyticsItemDto & {
  bankRevision: string;
  prompt: string;
  contextType: string | null;
  context: string | null;
  responseCount: number;
  choices: QuestionChoiceAnalyticsDto[];
  reviewHistory: QuestionReviewDto[];
};

export type QuestionReviewDecision =
  | 'keep'
  | 'observe'
  | 'disable_requested'
  | 'new_revision_required';

export type QuestionReviewDto = {
  id: number;
  revision: string;
  decision: QuestionReviewDecision;
  note: string | null;
  createdAt: string;
};

export type CreateQuestionReviewDto = {
  revision: string;
  decision: QuestionReviewDecision;
  note?: string | null;
};

export type CandidateAnalyticsItemDto = {
  attemptId: string;
  alias: string;
  candidateName: string | null;
  completedAt: string;
  score: number;
  accuracy: number;
  verdict: AnalyticsVerdict;
  durationSeconds: number;
  baseAnswered: number;
  baseCorrect: number;
  additionalAnswered: number;
  additionalCorrect: number;
  timeoutCount: number;
};

export type CandidatePrintDto = CandidateAnalyticsItemDto & {
  generatedAt: string;
  statisticsCompleteness: StatisticsCompleteness;
  topics: CandidateDimensionPerformanceDto[];
  difficulties: CandidateDimensionPerformanceDto[];
  interviewerRecommendations: InterviewerRecommendationDto[];
  questions: AttemptQuestionReviewDto[];
};

export type CandidatePerformanceClassification = 'strong' | 'normal' | 'review' | 'insufficient';

export type CandidateDimensionPerformanceDto = {
  key: string;
  classification: CandidatePerformanceClassification;
  base: AnalyticsBreakdownDto & {
    accuracy: number | null;
    averageSubmittedSeconds: number | null;
  };
  additional: AnalyticsBreakdownDto & {
    accuracy: number | null;
    recovered: number;
  };
};

export type InterviewerRecommendationDto = {
  code:
    | 'verify_fundamentals'
    | 'probe_weak_topic'
    | 'probe_advanced_reasoning'
    | 'clarify_time_management'
    | 'confirm_answer_stability';
  priority: 'high' | 'medium' | 'low';
  title: string;
  evidence: string;
};

export type GroupAnalyticsItemDto = {
  key: string;
  kind: Exclude<AnalyticsQuestionKind, 'all'> | 'all';
  sampleSize: number;
  successRate: number | null;
  timeoutRate: number | null;
  medianSeconds: number | null;
  reliability: AnalyticsReliability;
};

export type AnalyticsTrendItemDto = {
  date: string;
  attempts: number;
  averageScore: number | null;
  medianScore: number | null;
  averageAccuracy: number | null;
  passRate: number | null;
  averageDurationSeconds: number | null;
  medianDurationSeconds: number | null;
  verdicts: Record<AnalyticsVerdict, number>;
  topics: AnalyticsTrendDimensionDto[];
  difficulties: AnalyticsTrendDimensionDto[];
};

export type AnalyticsTrendDimensionDto = {
  key: string;
  outcomeCount: number;
  successRate: number | null;
  timeoutRate: number | null;
};

export type AnalyticsRevisionItemDto = {
  revision: string;
  attempts: number;
  firstCompletedAt: string;
  lastCompletedAt: string;
  averageScore: number | null;
  averageAccuracy: number | null;
};

export type AnalyticsRevisionComparisonSideDto = {
  revision: string;
  attempts: number;
  meanScore: number | null;
  medianScore: number | null;
  meanAccuracy: number | null;
  medianAccuracy: number | null;
  meanDurationSeconds: number | null;
  medianDurationSeconds: number | null;
  verdicts: Record<AnalyticsVerdict, number>;
};

export type AnalyticsRevisionComparisonDto = {
  cohort: AnalyticsCohortDto;
  left: AnalyticsRevisionComparisonSideDto;
  right: AnalyticsRevisionComparisonSideDto;
  deltas: {
    attempts: number;
    meanScore: number | null;
    medianScore: number | null;
    meanAccuracy: number | null;
    medianAccuracy: number | null;
    meanDurationSeconds: number | null;
    medianDurationSeconds: number | null;
    verdicts: Record<AnalyticsVerdict, number>;
  };
};

export type AnalyticsListDto<T> = {
  cohort: AnalyticsCohortDto;
  items: T[];
};

export type AnalyticsPagedListDto<T> = AnalyticsListDto<T> & {
  nextCursor: string | null;
};

export type QuestionAnalyticsSummaryDto = {
  total: number;
  review: number;
  observe: number;
  good: number;
  insufficient: number;
  disabled: number;
};

export type QuestionAnalyticsListDto = AnalyticsPagedListDto<QuestionAnalyticsItemDto> & {
  questionAnalyticsModelVersion: typeof QUESTION_ANALYTICS_MODEL_VERSION;
  totalCount: number;
  summary: QuestionAnalyticsSummaryDto;
};

export type AnalyticsExportFormat = 'csv' | 'json';

export type AnalyticsExportRowDto = {
  questionAnalyticsModelVersion: typeof QUESTION_ANALYTICS_MODEL_VERSION;
  questionId: number;
  topic: string;
  difficulty: string;
  kind: AnalyticsQuestionKind;
  assignedCount: number;
  presentedCount: number;
  outcomeCount: number;
  sampleSize: number;
  completionRate: number | null;
  successRate: number | null;
  timeoutRate: number | null;
  averageSeconds: number | null;
  medianSeconds: number | null;
  minSeconds: number | null;
  maxSeconds: number | null;
  discrimination: number | null;
  qualityScore: number | null;
  qualityMaxAvailable: number | null;
  qualityStatus: QuestionQualityStatus;
  qualityWarnings: QuestionQualityWarning[];
  reliability: AnalyticsReliability;
  recommendation: QuestionRecommendationCode | null;
  observedSubmittedCount: number;
  observedCorrectCount: number;
  observedIncorrectCount: number;
  observedTimeoutCount: number;
  observedPresentationRate: number | null;
  observedResponseRate: number | null;
  observedSuccessRate: number | null;
  observedTimeoutRate: number | null;
  sampleStatus: QuestionSampleStatus;
  nextSampleGate: AnalyticsSampleGate | null;
  signalCodes: QuestionAnalyticsSignalCode[];
};
