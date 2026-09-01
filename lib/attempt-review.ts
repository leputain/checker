import type { QuestionContextType } from './question-bank-validation.ts';
import type { Difficulty } from './test-config.ts';

export type AttemptQuestionReviewStatus = 'correct' | 'incorrect' | 'timeout' | 'unshown';

export type AttemptQuestionReviewDto = {
  questionId: number;
  ordinal: number;
  questionKind: 'base' | 'additional';
  scoreValue: number;
  topic: string;
  difficulty: Difficulty;
  prompt: string;
  contextType: QuestionContextType | null;
  context: string | null;
  status: AttemptQuestionReviewStatus;
  selectedAnswer: string | null;
  correctAnswer: string;
  elapsedSeconds: number | null;
  awardedScore: number;
  explanation: string;
};

export function reviewExplanation({
  topic,
  correctAnswer,
  selectedAnswer,
  timedOut,
  hasContext,
}: {
  topic: string;
  correctAnswer: string;
  selectedAnswer: string | null;
  timedOut: boolean;
  hasContext: boolean;
}) {
  const reason = hasContext
    ? 'Он согласуется с приведённым в вопросе контекстом'
    : `Он соответствует условию вопроса по теме «${topic}»`;
  if (timedOut) {
    return `Время ответа истекло. Верный вариант — «${correctAnswer}». ${reason}.`;
  }
  if (selectedAnswer) {
    return `Верный вариант — «${correctAnswer}». ${reason}; выбранный вариант «${selectedAnswer}» не выполняет указанное условие.`;
  }
  return `Верный вариант — «${correctAnswer}». ${reason}.`;
}
