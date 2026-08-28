import { GENERAL_TOPIC_PLAN, TEST_CONFIG, type Difficulty } from './test-config.ts';

export const READINESS_LEVELS = ['READY', 'WARNING', 'NOT READY'] as const;
export type ReadinessLevel = typeof READINESS_LEVELS[number];

export type ReadinessQuestion = {
  id: number;
  difficulty: Difficulty;
  topic: string;
  dedupeKey: string;
  active: boolean;
};

export type PoolReadiness = {
  active: number;
  unique: number;
  required: number;
  availableAfterWorstCase: number | null;
  reserveStatus: 'GOOD' | 'WARNING' | 'EMPTY' | 'UNAVAILABLE';
};

export type TopicDifficultyCell = {
  active: number;
  unique: number;
  availableAfterWorstCase: number | null;
  reserveStatus: PoolReadiness['reserveStatus'];
};

export type SelectorReadiness = {
  status: ReadinessLevel;
  baseFeasible: boolean;
  minimumReserveFeasible: boolean | null;
  reasonCodes: string[];
};

export type QuestionBankReadiness = {
  activeQuestions: number;
  uniqueDedupeGroups: number;
  difficulty: Record<Difficulty, PoolReadiness>;
  topics: Record<string, { active: number; unique: number; required: number | null }>;
  topicDifficulty: Record<string, Record<Difficulty, TopicDifficultyCell>>;
  unexpectedTopics: string[];
  legacy: SelectorReadiness;
  balanced: SelectorReadiness;
  warnings: string[];
};

type QuotaPlanResult = {
  feasible: boolean;
  maximumWeightedGroups: number;
};

type FlowEdge = {
  to: number;
  reverse: number;
  capacity: number;
  cost: number;
};

const REMEDIAL_WARNING_FLOOR = 2;

function addEdge(graph: FlowEdge[][], from: number, to: number, capacity: number, cost = 0) {
  const forward: FlowEdge = { to, reverse: graph[to].length, capacity, cost };
  const reverse: FlowEdge = { to: from, reverse: graph[from].length, capacity: 0, cost: -cost };
  graph[from].push(forward);
  graph[to].push(reverse);
}

/**
 * Exact quota feasibility for validated banks. Validation guarantees that a
 * dedupeKey belongs to one topic, while a concept may have variants at several
 * difficulty levels. The min-cost flow therefore enforces topic, difficulty
 * and global dedupe constraints simultaneously.
 */
function solveQuotaPlan(
  questions: readonly ReadinessQuestion[],
  difficultyPlan: Readonly<Record<Difficulty, number>>,
  topicPlan: Readonly<Record<string, number>> | null,
  weightedKeys: ReadonlySet<string> = new Set(),
): QuotaPlanResult {
  const active = questions.filter((question) => question.active);
  const allowedTopics = topicPlan ? new Set(Object.keys(topicPlan)) : null;
  const grouped = new Map<string, { topic: string; difficulties: Set<Difficulty>; invalid: boolean }>();

  for (const question of active) {
    if (allowedTopics && !allowedTopics.has(question.topic)) continue;
    const existing = grouped.get(question.dedupeKey);
    if (!existing) {
      grouped.set(question.dedupeKey, {
        topic: topicPlan ? question.topic : '__all__',
        difficulties: new Set([question.difficulty]),
        invalid: false,
      });
      continue;
    }
    if (topicPlan && existing.topic !== question.topic) existing.invalid = true;
    existing.difficulties.add(question.difficulty);
  }

  // Cross-topic dedupe is rejected by the canonical validator. Treating it as
  // unavailable here is conservative and avoids reporting a false READY state
  // when the evaluator is called directly with unvalidated data.
  const groups = [...grouped.entries()].filter(([, group]) => !group.invalid);
  const topicEntries: [string, number][] = topicPlan
    ? Object.entries(topicPlan)
    : [['__all__', Object.values(difficultyPlan).reduce((sum, count) => sum + count, 0)]];
  const requiredFlow = Object.values(difficultyPlan).reduce((sum, count) => sum + count, 0);
  if (topicEntries.reduce((sum, [, count]) => sum + count, 0) !== requiredFlow) {
    return { feasible: false, maximumWeightedGroups: 0 };
  }

  const source = 0;
  const topicOffset = 1;
  const groupOffset = topicOffset + topicEntries.length;
  const difficultyOffset = groupOffset + groups.length;
  const sink = difficultyOffset + Object.keys(difficultyPlan).length;
  const graph: FlowEdge[][] = Array.from({ length: sink + 1 }, () => []);
  const topicNode = new Map(topicEntries.map(([topic], index) => [topic, topicOffset + index]));
  const difficultyEntries = Object.entries(difficultyPlan) as [Difficulty, number][];
  const difficultyNode = new Map(
    difficultyEntries.map(([difficulty], index) => [difficulty, difficultyOffset + index]),
  );

  topicEntries.forEach(([topic, quota]) => addEdge(graph, source, topicNode.get(topic)!, quota));
  groups.forEach(([key, group], index) => {
    const groupNode = groupOffset + index;
    addEdge(graph, topicNode.get(group.topic)!, groupNode, 1, weightedKeys.has(key) ? -1 : 0);
    for (const difficulty of group.difficulties) {
      addEdge(graph, groupNode, difficultyNode.get(difficulty)!, 1);
    }
  });
  for (const [difficulty, quota] of difficultyEntries) {
    addEdge(graph, difficultyNode.get(difficulty)!, sink, quota);
  }

  let flow = 0;
  let cost = 0;
  while (flow < requiredFlow) {
    const distance = Array<number>(graph.length).fill(Number.POSITIVE_INFINITY);
    const previousNode = Array<number>(graph.length).fill(-1);
    const previousEdge = Array<number>(graph.length).fill(-1);
    const inQueue = Array<boolean>(graph.length).fill(false);
    const queue = [source];
    distance[source] = 0;
    inQueue[source] = true;

    while (queue.length > 0) {
      const node = queue.shift()!;
      inQueue[node] = false;
      graph[node].forEach((edge, edgeIndex) => {
        if (edge.capacity <= 0 || distance[edge.to] <= distance[node] + edge.cost) return;
        distance[edge.to] = distance[node] + edge.cost;
        previousNode[edge.to] = node;
        previousEdge[edge.to] = edgeIndex;
        if (!inQueue[edge.to]) {
          queue.push(edge.to);
          inQueue[edge.to] = true;
        }
      });
    }

    if (previousNode[sink] < 0) break;
    let increment = requiredFlow - flow;
    for (let node = sink; node !== source; node = previousNode[node]) {
      increment = Math.min(increment, graph[previousNode[node]][previousEdge[node]].capacity);
    }
    for (let node = sink; node !== source; node = previousNode[node]) {
      const edge = graph[previousNode[node]][previousEdge[node]];
      edge.capacity -= increment;
      graph[node][edge.reverse].capacity += increment;
    }
    flow += increment;
    cost += increment * distance[sink];
  }

  return {
    feasible: flow === requiredFlow,
    maximumWeightedGroups: flow === requiredFlow ? -cost : 0,
  };
}

function reserveStatus(available: number | null): PoolReadiness['reserveStatus'] {
  if (available === null) return 'UNAVAILABLE';
  if (available === 0) return 'EMPTY';
  return available <= REMEDIAL_WARNING_FLOOR ? 'WARNING' : 'GOOD';
}

function activeKeys(
  questions: readonly ReadinessQuestion[],
  predicate: (question: ReadinessQuestion) => boolean,
) {
  return new Set(questions.filter((question) => question.active && predicate(question))
    .map((question) => question.dedupeKey));
}

export function evaluateQuestionBankReadiness(
  questions: readonly ReadinessQuestion[],
): QuestionBankReadiness {
  const active = questions.filter((question) => question.active);
  const topicPlan = GENERAL_TOPIC_PLAN as Readonly<Record<string, number>>;
  const baseLegacy = solveQuotaPlan(active, TEST_CONFIG.plan, null);
  const reservePlan = Object.fromEntries(
    Object.entries(TEST_CONFIG.plan).map(([difficulty, count]) => [difficulty, count + 1]),
  ) as Record<Difficulty, number>;
  const reserveLegacy = solveQuotaPlan(active, reservePlan, null);
  const baseBalanced = solveQuotaPlan(active, TEST_CONFIG.plan, topicPlan);

  const difficulty = Object.fromEntries(
    (Object.keys(TEST_CONFIG.plan) as Difficulty[]).map((level) => {
      const pool = active.filter((question) => question.difficulty === level);
      const keys = activeKeys(active, (question) => question.difficulty === level);
      const worstCase = baseLegacy.feasible
        ? solveQuotaPlan(active, TEST_CONFIG.plan, null, keys)
        : null;
      const available = worstCase?.feasible
        ? Math.max(0, keys.size - worstCase.maximumWeightedGroups)
        : null;
      return [level, {
        active: pool.length,
        unique: keys.size,
        required: TEST_CONFIG.plan[level],
        availableAfterWorstCase: available,
        reserveStatus: reserveStatus(available),
      }];
    }),
  ) as Record<Difficulty, PoolReadiness>;

  const allTopics = [...new Set(active.map((question) => question.topic))]
    .sort((left, right) => left.localeCompare(right, 'ru-RU'));
  const topics = Object.fromEntries(allTopics.map((topic) => {
    const topicQuestions = active.filter((question) => question.topic === topic);
    return [topic, {
      active: topicQuestions.length,
      unique: new Set(topicQuestions.map((question) => question.dedupeKey)).size,
      required: topic in topicPlan ? topicPlan[topic] : null,
    }];
  }));

  const matrixTopics = [...new Set([...Object.keys(topicPlan), ...allTopics])];
  const topicDifficulty = Object.fromEntries(matrixTopics.map((topic) => [
    topic,
    Object.fromEntries((Object.keys(TEST_CONFIG.plan) as Difficulty[]).map((level) => {
      const cellQuestions = active.filter(
        (question) => question.topic === topic && question.difficulty === level,
      );
      const keys = new Set(cellQuestions.map((question) => question.dedupeKey));
      const worstCase = baseBalanced.feasible && topic in topicPlan && keys.size > 0
        ? solveQuotaPlan(active, TEST_CONFIG.plan, topicPlan, keys)
        : null;
      const available = worstCase?.feasible
        ? Math.max(0, keys.size - worstCase.maximumWeightedGroups)
        : null;
      return [level, {
        active: cellQuestions.length,
        unique: keys.size,
        availableAfterWorstCase: available,
        reserveStatus: reserveStatus(available),
      }];
    })),
  ])) as Record<string, Record<Difficulty, TopicDifficultyCell>>;

  const unexpectedTopics = allTopics.filter((topic) => !(topic in topicPlan));
  const warnings: string[] = [];
  const legacyReasons: string[] = [];
  if (!baseLegacy.feasible) legacyReasons.push('base_plan_infeasible');
  if (!reserveLegacy.feasible) legacyReasons.push('minimum_remedial_reserve_infeasible');
  const legacyReserveLow = Object.entries(difficulty)
    .filter(([, pool]) => pool.reserveStatus !== 'GOOD')
    .map(([level]) => level);
  if (legacyReserveLow.length > 0) warnings.push(`legacy_low_remedial_reserve:${legacyReserveLow.join(',')}`);

  const balancedReasons: string[] = [];
  if (!baseBalanced.feasible) balancedReasons.push('topic_difficulty_dedupe_plan_infeasible');
  const balancedLowCells = Object.entries(topicDifficulty).flatMap(([topic, row]) => (
    topic in topicPlan
      ? (Object.entries(row) as [Difficulty, TopicDifficultyCell][])
          .filter(([, cell]) => cell.unique > 0 && cell.reserveStatus !== 'GOOD')
          .map(([level]) => `${topic}/${level}`)
      : []
  ));
  if (balancedLowCells.length > 0) {
    warnings.push(`balanced_low_remedial_reserve:${balancedLowCells.join(',')}`);
  }
  if (unexpectedTopics.length > 0) warnings.push(`unexpected_topics:${unexpectedTopics.join(',')}`);

  const legacyStatus: ReadinessLevel = !baseLegacy.feasible || !reserveLegacy.feasible
    ? 'NOT READY'
    : legacyReserveLow.length > 0 ? 'WARNING' : 'READY';
  const balancedStatus: ReadinessLevel = !baseBalanced.feasible
    ? 'NOT READY'
    : balancedLowCells.length > 0 ? 'WARNING' : 'READY';

  return {
    activeQuestions: active.length,
    uniqueDedupeGroups: new Set(active.map((question) => question.dedupeKey)).size,
    difficulty,
    topics,
    topicDifficulty,
    unexpectedTopics,
    legacy: {
      status: legacyStatus,
      baseFeasible: baseLegacy.feasible,
      minimumReserveFeasible: reserveLegacy.feasible,
      reasonCodes: legacyReasons,
    },
    balanced: {
      status: balancedStatus,
      baseFeasible: baseBalanced.feasible,
      minimumReserveFeasible: null,
      reasonCodes: balancedReasons,
    },
    warnings,
  };
}
