export const ANALYTICS_AUTO_REFRESH_DEBOUNCE_MS = 30_000;
export const ANALYTICS_AUTO_REFRESH_COOLDOWN_MS = 3 * 60_000;
export const ANALYTICS_REFRESH_LEASE_MS = 2 * 60_000;
export const MAINTENANCE_REQUEST_TIMEOUT_MS = 60_000;

export type AnalyticsRefreshEligibility =
  | { eligible: true; nextEligibleAt: number }
  | { eligible: false; reason: 'fresh'; nextEligibleAt: null }
  | { eligible: false; reason: 'debounce' | 'cooldown'; nextEligibleAt: number };

export function analyticsAutoRefreshEligibility(input: {
  generation: number;
  builtGeneration: number;
  updatedAt: number;
  refreshAttemptedAt: number | null;
  now: number;
  debounceMs?: number;
  cooldownMs?: number;
}): AnalyticsRefreshEligibility {
  if (input.generation === input.builtGeneration) {
    return { eligible: false, reason: 'fresh', nextEligibleAt: null };
  }

  const debounceMs = input.debounceMs ?? ANALYTICS_AUTO_REFRESH_DEBOUNCE_MS;
  const cooldownMs = input.cooldownMs ?? ANALYTICS_AUTO_REFRESH_COOLDOWN_MS;
  const debounceUntil = input.updatedAt + debounceMs;
  const cooldownUntil = (input.refreshAttemptedAt ?? 0) + cooldownMs;
  const nextEligibleAt = Math.max(debounceUntil, cooldownUntil);
  if (input.now < debounceUntil) {
    return { eligible: false, reason: 'debounce', nextEligibleAt };
  }
  if (input.now < cooldownUntil) {
    return { eligible: false, reason: 'cooldown', nextEligibleAt };
  }
  return { eligible: true, nextEligibleAt };
}
