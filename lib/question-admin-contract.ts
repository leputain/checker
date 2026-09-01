import type { QuestionContextType } from './question-bank-validation.ts';
import type { Difficulty } from './test-config.ts';

export type QuestionAdminLifecycleStatus = 'active' | 'archived' | 'superseded';
export type QuestionAdminStatusFilter =
  | 'all'
  | QuestionAdminLifecycleStatus
  /** Backward-compatible alias for archived current leaf questions. */
  | 'inactive';
export type QuestionAdminRevisionFilter = 'current' | 'all' | 'historical';
export type QuestionAdminQualityStatus =
  | 'good'
  | 'observe'
  | 'review'
  | 'insufficient'
  | 'disabled';
export type QuestionAdminQualityFilter =
  | 'all'
  | QuestionAdminQualityStatus
  | 'needs_review';
export type QuestionAdminSort =
  | 'id'
  | 'topic'
  | 'difficulty'
  | 'status'
  | 'quality'
  | 'usage'
  | 'revision';
export type QuestionAdminDirection = 'asc' | 'desc';
export type QuestionBankEventType = 'created' | 'revised' | 'activated' | 'deactivated';

export type QuestionCategoryDto = {
  id: number;
  name: string;
  normalizedName: string;
  selectionKey: string;
  active: boolean;
  activeQuestionCount: number;
  inactiveQuestionCount: number;
  difficultyCounts: Record<Difficulty, number>;
};

export type QuestionCategoryListDto = {
  items: QuestionCategoryDto[];
  currentBankRevision: string;
};

export type QuestionReplacementDto = {
  previousQuestionId: number;
  questionId: number;
};

export type QuestionBankBatchPatchDto = {
  topic?: string;
  difficulty?: Difficulty;
  active?: boolean;
};

export type QuestionBankBatchOperationDto = {
  questionId: number;
  patch: QuestionBankBatchPatchDto;
};

export type QuestionBankBatchRequestDto = {
  questionIds: number[];
  patch: QuestionBankBatchPatchDto;
  expectedBankRevision: string;
  idempotencyKey: string;
  note?: string;
};

export type QuestionBankBatchMutationDto = {
  changedCount: number;
  unchangedCount: number;
  replacements: QuestionReplacementDto[];
  currentBankRevision: string;
  readiness: QuestionBankReadinessDto;
};

export type QuestionCategoryMutationDto = {
  category: QuestionCategoryDto;
  changedQuestionCount: number;
  replacements: QuestionReplacementDto[];
  currentBankRevision: string;
  readiness: QuestionBankReadinessDto;
};

export type QuestionCategoryRenameRequestDto = {
  name: string;
  expectedCategoryName: string;
  expectedBankRevision: string;
  idempotencyKey: string;
  note?: string;
};

export type QuestionCategoryMergeRequestDto = {
  targetCategoryId: number;
  expectedCategoryName: string;
  expectedBankRevision: string;
  idempotencyKey: string;
  note?: string;
};

export type QuestionBankChangeSetStatus = 'draft' | 'published' | 'discarded';

export type QuestionBankChangeSetItemDto = {
  id: number;
  questionId: number;
  patch: QuestionBankBatchPatchDto;
  createdAt: number;
};

export type QuestionBankChangeSetDto = {
  id: string;
  title: string;
  note: string | null;
  status: QuestionBankChangeSetStatus;
  baseBankRevision: string;
  publishedBankRevision: string | null;
  operationCount: number;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
};

export type QuestionBankChangeSetListDto = {
  items: QuestionBankChangeSetDto[];
  currentBankRevision: string;
};

export type QuestionBankChangeSetDetailDto = {
  changeSet: QuestionBankChangeSetDto;
  operations: QuestionBankChangeSetItemDto[];
  currentBankRevision: string;
};

export type QuestionBankChangeSetUpdateRequestDto = {
  operations: QuestionBankBatchOperationDto[];
  expectedBankRevision: string;
  expectedChangeSetUpdatedAt: number;
  idempotencyKey: string;
  note?: string;
};

export type QuestionBankChangeSetTransitionRequestDto = {
  expectedBankRevision: string;
  expectedChangeSetUpdatedAt: number;
  idempotencyKey: string;
  note?: string;
};

export type QuestionBankChangeSetPreviewDto = QuestionBankChangeSetDetailDto & {
  changedCount: number;
  unchangedCount: number;
  replacements: Array<{ previousQuestionId: number; proposedQuestionId: number }>;
  readiness: QuestionBankReadinessDto;
  coverage: QuestionBankCoverageDto;
};

export type QuestionImportDraftDto = {
  /** Existing leaf id to revise. Omit for a new question. */
  id?: number;
  topic: string;
  difficulty: Difficulty;
  prompt: string;
  contextType?: QuestionContextType | null;
  context?: string | null;
  choices: string[];
  correctIndex: number;
  dedupeKey: string;
  active?: boolean;
};

export type QuestionImportDiffItemDto = {
  sourceIndex: number;
  sourceId: number | null;
  matchedQuestionId: number | null;
  action: 'added' | 'revised' | 'unchanged' | 'invalid';
  issues: string[];
  changedFields: string[];
};

export type QuestionImportPreviewDto = {
  expectedBankRevision: string;
  previewToken: string;
  summary: { added: number; revised: number; unchanged: number; invalid: number };
  items: QuestionImportDiffItemDto[];
  readiness: QuestionBankReadinessDto | null;
};

export type QuestionImportApplyDto = QuestionBankBatchMutationDto & {
  importSummary: QuestionImportPreviewDto['summary'];
};

export type QuestionBankExportDto = {
  schemaVersion: 1;
  bankRevision: string;
  exportedAt: string;
  questions: QuestionImportDraftDto[];
};

export type QuestionCategoryCoverageDto = {
  categoryId: number;
  name: string;
  counts: Record<Difficulty, number> & { total: number };
  requiredTotal: number;
  status: 'enough' | 'deficit' | 'unused';
  deficits: string[];
};

export type QuestionBankCoverageDto = {
  currentBankRevision: string;
  ready: boolean;
  issues: string[];
  warnings: string[];
  categories: QuestionCategoryCoverageDto[];
};

export type QuestionQualityQueueItemDto = {
  questionId: number;
  topic: string;
  difficulty: Difficulty;
  qualityStatus: 'good' | 'observe' | 'review' | 'insufficient' | 'disabled';
  warnings: string[];
  editorHref: string;
  analyticsHref: string;
};

export type QuestionQualityQueueDto = {
  currentBankRevision: string;
  items: QuestionQualityQueueItemDto[];
  totalCount: number;
};

export type QuestionAdminItemDto = {
  id: number;
  categoryId: number | null;
  difficulty: Difficulty;
  topic: string;
  prompt: string;
  promptPreview: string;
  contextType: QuestionContextType | null;
  context: string | null;
  choices: string[];
  active: boolean;
  weight: number;
  dedupeKey: string;
  predecessorId: number | null;
  successorId: number | null;
  usageCount: number;
  lifecycleStatus: QuestionAdminLifecycleStatus;
  currentRevisionMember: boolean;
  introducedBankRevision: string | null;
  introducedAt: number | null;
  /** Populated for quality-filtered/sorted catalog requests; null otherwise. */
  qualityStatus: QuestionAdminQualityStatus | null;
};

export type QuestionAdminDetailDto = QuestionAdminItemDto & {
  correctIndex: number;
  contentHash: string;
};

export type QuestionBankHistoryEventDto = {
  id: number;
  eventType: QuestionBankEventType;
  questionId: number;
  predecessorId: number | null;
  successorId: number | null;
  bankRevision: string;
  createdAt: number;
  note: string | null;
};

export type QuestionBankReadinessDto = {
  ready: boolean;
  issues: string[];
  warnings: string[];
};

export type QuestionAdminListDto = {
  items: QuestionAdminItemDto[];
  totalCount: number;
  nextCursor: string | null;
  currentBankRevision: string;
  topics: string[];
  bankCounts: {
    /** Current leaf questions only: active + archived. */
    total: number;
    active: number;
    /** Backward-compatible alias/count for archived current leaf questions. */
    inactive: number;
    archived: number;
    superseded: number;
    allRevisions: number;
  };
  readiness: QuestionBankReadinessDto;
};

export type QuestionAdminHistoryDto = {
  items: QuestionBankHistoryEventDto[];
  lineage: QuestionAdminItemDto[];
  currentBankRevision: string;
};

export type QuestionAdminDetailResponseDto = {
  question: QuestionAdminDetailDto;
  currentBankRevision: string;
  history: QuestionBankHistoryEventDto[];
  lineage: QuestionAdminItemDto[];
};

export type QuestionAdminDraftDto = {
  topic: string;
  difficulty: Difficulty;
  prompt: string;
  contextType?: QuestionContextType | null;
  context?: string | null;
  choices: string[];
  correctIndex: number;
  dedupeKey: string;
  active?: boolean;
  note?: string;
  expectedBankRevision: string;
  idempotencyKey: string;
};

export type QuestionAdminToggleDto = {
  active: boolean;
  note?: string;
  expectedBankRevision: string;
  idempotencyKey: string;
};

export type QuestionAdminMutationDto = {
  question: QuestionAdminDetailDto;
  previousQuestionId: number | null;
  currentBankRevision: string;
  readiness: QuestionBankReadinessDto;
};

export type QuestionAdminErrorCode =
  | 'bank_revision_conflict'
  | 'idempotency_conflict'
  | 'question_has_successor'
  | 'question_validation_failed'
  | 'question_bank_not_ready'
  | 'category_conflict'
  | 'change_set_conflict'
  | 'import_preview_conflict'
  | 'mutation_too_large'
  | 'analytics_refresh_required'
  | 'catalog_snapshot_conflict';

export type QuestionAdminErrorDto = {
  error: QuestionAdminErrorCode | 'invalid_request' | 'not_found';
  issues?: string[];
};
