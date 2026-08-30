import type { QuestionContextType } from './question-bank-validation.ts';
import type { Difficulty } from './test-config.ts';

export type QuestionAdminStatusFilter = 'all' | 'active' | 'inactive';
export type QuestionAdminSort = 'id' | 'topic' | 'difficulty' | 'status';
export type QuestionAdminDirection = 'asc' | 'desc';
export type QuestionBankEventType = 'created' | 'revised' | 'activated' | 'deactivated';

export type QuestionAdminItemDto = {
  id: number;
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
    total: number;
    active: number;
    inactive: number;
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
  | 'question_bank_not_ready';

export type QuestionAdminErrorDto = {
  error: QuestionAdminErrorCode | 'invalid_request' | 'not_found';
  issues?: string[];
};
