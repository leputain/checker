import type { Verdict } from './scoring.ts';

export type LeaderboardPeriod = 'today' | 'all';

export type RankedLeaderboardEntry = {
  alias: string;
  verdict: Verdict;
  score: number;
  baseMaxScore: number;
  accuracy: number;
  wrongCount: number;
  durationSeconds: number;
  completedAt: string;
};

export type CandidateLeaderboardEntry = RankedLeaderboardEntry & {
  candidateKey: string;
};

const MOSCOW_TIME_ZONE = 'Europe/Moscow';
const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: MOSCOW_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function dateTimeParts(timestamp: number) {
  const parts = Object.fromEntries(
    dateTimeFormatter
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function zonedMidnightMs(year: number, month: number, day: number) {
  const desiredWallTime = Date.UTC(year, month - 1, day);
  let timestamp = desiredWallTime;
  // Two passes account for a possible offset transition near the target date.
  for (let pass = 0; pass < 2; pass += 1) {
    const actual = dateTimeParts(timestamp);
    const actualWallTime = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    timestamp += desiredWallTime - actualWallTime;
  }
  return timestamp;
}

export function moscowDayBounds(nowMs = Date.now()) {
  const current = dateTimeParts(nowMs);
  const nextDate = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  return {
    startMs: zonedMidnightMs(current.year, current.month, current.day),
    endMs: zonedMidnightMs(
      nextDate.getUTCFullYear(),
      nextDate.getUTCMonth() + 1,
      nextDate.getUTCDate(),
    ),
  };
}

const verdictRank: Record<Verdict, number> = {
  PASS: 0,
  REVIEW: 1,
  FAIL: 2,
};

export function compareLeaderboardEntries(
  left: RankedLeaderboardEntry,
  right: RankedLeaderboardEntry,
) {
  return verdictRank[left.verdict] - verdictRank[right.verdict]
    || right.score - left.score
    || left.wrongCount - right.wrongCount
    || left.durationSeconds - right.durationSeconds
    || Date.parse(left.completedAt) - Date.parse(right.completedAt);
}

export function selectBestLeaderboardEntries(
  entries: readonly CandidateLeaderboardEntry[],
  limit = 20,
) {
  const bestByCandidate = new Map<string, CandidateLeaderboardEntry>();
  for (const entry of entries) {
    const current = bestByCandidate.get(entry.candidateKey);
    if (!current || compareLeaderboardEntries(entry, current) < 0) {
      bestByCandidate.set(entry.candidateKey, entry);
    }
  }
  return [...bestByCandidate.values()]
    .sort(compareLeaderboardEntries)
    .slice(0, limit)
    .map((entry): RankedLeaderboardEntry => ({
      alias: entry.alias,
      verdict: entry.verdict,
      score: entry.score,
      baseMaxScore: entry.baseMaxScore,
      accuracy: entry.accuracy,
      wrongCount: entry.wrongCount,
      durationSeconds: entry.durationSeconds,
      completedAt: entry.completedAt,
    }));
}
