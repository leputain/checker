import type { QuestionKind } from './scoring.ts';

export type CandidateInsightFact = {
  questionId: number;
  questionKind: QuestionKind;
  topic: string;
  dedupeKey: string;
  scoreValue: number;
  assigned: boolean;
  presented: boolean;
  resolved: boolean;
  correct: boolean;
  timedOut: boolean;
  answerOrigin: string | null;
  awardedScore: number;
  elapsedSeconds: number | null;
};

export type TopicStrength = 'strong' | 'normal' | 'review' | 'insufficient';

export type CandidateTopicGroup = {
  assignedCount: number;
  presentedCount: number;
  resolvedCount: number;
  correctCount: number;
  incorrectCount: number;
  timeoutCount: number;
  earnedScore: number;
  maxEarnableScore: number;
  accuracy: number | null;
  averageSubmittedSeconds: number | null;
};

export type CandidateTopicInsight = {
  topic: string;
  classification: TopicStrength;
  base: CandidateTopicGroup;
  additional: CandidateTopicGroup;
};

export type InterviewCheckArea = {
  topic: string;
  dedupeKey: string;
  lostBaseScore: number;
  timeoutCount: number;
  questionIds: number[];
};

type MutableTopicGroup = Omit<CandidateTopicGroup, 'accuracy' | 'averageSubmittedSeconds'> & {
  submittedElapsedSeconds: number;
  submittedCount: number;
};

function emptyGroup(): MutableTopicGroup {
  return {
    assignedCount: 0,
    presentedCount: 0,
    resolvedCount: 0,
    correctCount: 0,
    incorrectCount: 0,
    timeoutCount: 0,
    earnedScore: 0,
    maxEarnableScore: 0,
    submittedElapsedSeconds: 0,
    submittedCount: 0,
  };
}

function finishGroup(group: MutableTopicGroup): CandidateTopicGroup {
  return {
    assignedCount: group.assignedCount,
    presentedCount: group.presentedCount,
    resolvedCount: group.resolvedCount,
    correctCount: group.correctCount,
    incorrectCount: group.incorrectCount,
    timeoutCount: group.timeoutCount,
    earnedScore: group.earnedScore,
    maxEarnableScore: group.maxEarnableScore,
    accuracy: group.resolvedCount > 0
      ? Math.round((group.correctCount * 1000) / group.resolvedCount) / 10
      : null,
    averageSubmittedSeconds: group.submittedCount > 0
      ? Math.round((group.submittedElapsedSeconds * 10) / group.submittedCount) / 10
      : null,
  };
}

function classify(group: CandidateTopicGroup): TopicStrength {
  if (group.resolvedCount < 3 || group.accuracy === null) return 'insufficient';
  if (group.accuracy >= 80) return 'strong';
  if (group.accuracy >= 50) return 'normal';
  return 'review';
}

export function buildCandidateInsights(facts: readonly CandidateInsightFact[]) {
  const groups = new Map<string, { base: MutableTopicGroup; additional: MutableTopicGroup }>();
  const checkAreaMap = new Map<string, InterviewCheckArea>();

  for (const fact of facts) {
    const topic = fact.topic.trim() || 'Без темы';
    const topicGroups = groups.get(topic) ?? { base: emptyGroup(), additional: emptyGroup() };
    groups.set(topic, topicGroups);
    const group = topicGroups[fact.questionKind];
    group.assignedCount += fact.assigned ? 1 : 0;
    group.presentedCount += fact.presented ? 1 : 0;
    group.resolvedCount += fact.resolved ? 1 : 0;
    group.correctCount += fact.resolved && fact.correct ? 1 : 0;
    group.incorrectCount += fact.resolved && !fact.correct && !fact.timedOut ? 1 : 0;
    group.timeoutCount += fact.resolved && fact.timedOut ? 1 : 0;
    group.earnedScore += fact.resolved ? Math.max(0, fact.awardedScore) : 0;
    group.maxEarnableScore += fact.assigned ? Math.max(0, fact.scoreValue) : 0;
    if (
      fact.resolved && fact.answerOrigin === 'submitted' && !fact.timedOut &&
      fact.elapsedSeconds !== null
    ) {
      group.submittedElapsedSeconds += Math.max(0, fact.elapsedSeconds);
      group.submittedCount += 1;
    }

    if (fact.questionKind !== 'base' || !fact.resolved || fact.correct) continue;
    const dedupeKey = fact.dedupeKey.trim() || `question:${fact.questionId}`;
    const key = `${topic}\u0000${dedupeKey}`;
    const current = checkAreaMap.get(key) ?? {
      topic,
      dedupeKey,
      lostBaseScore: 0,
      timeoutCount: 0,
      questionIds: [],
    };
    current.lostBaseScore += Math.max(0, fact.scoreValue - fact.awardedScore);
    current.timeoutCount += fact.timedOut ? 1 : 0;
    if (!current.questionIds.includes(fact.questionId)) current.questionIds.push(fact.questionId);
    checkAreaMap.set(key, current);
  }

  const topics = [...groups.entries()]
    .map(([topic, group]): CandidateTopicInsight => {
      const base = finishGroup(group.base);
      return { topic, base, additional: finishGroup(group.additional), classification: classify(base) };
    })
    .toSorted((left, right) => left.topic.localeCompare(right.topic, 'ru-RU'));

  const checkAreas = [...checkAreaMap.values()]
    .map((area) => ({ ...area, questionIds: area.questionIds.toSorted((a, b) => a - b) }))
    .toSorted((left, right) => (
      right.lostBaseScore - left.lostBaseScore ||
      right.timeoutCount - left.timeoutCount ||
      left.topic.localeCompare(right.topic, 'ru-RU') ||
      left.dedupeKey.localeCompare(right.dedupeKey)
    ))
    .slice(0, 5);

  const strongTopics = topics
    .filter((topic) => topic.classification === 'strong')
    .toSorted((left, right) => (
      (right.base.accuracy ?? 0) - (left.base.accuracy ?? 0) ||
      right.base.earnedScore - left.base.earnedScore ||
      left.topic.localeCompare(right.topic, 'ru-RU')
    ))
    .slice(0, 3)
    .map((topic) => topic.topic);
  const telegramCheckAreas = [...new Set(checkAreas.map((area) => area.topic))].slice(0, 3);

  return {
    topics,
    checkAreas,
    telegramProfile: { strongTopics, checkAreas: telegramCheckAreas },
  };
}
