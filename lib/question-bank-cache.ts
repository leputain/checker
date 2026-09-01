type CacheInvalidator = () => void;

const invalidators = new Set<CacheInvalidator>();

export function registerQuestionBankCacheInvalidator(invalidator: CacheInvalidator) {
  invalidators.add(invalidator);
  return () => invalidators.delete(invalidator);
}

export function invalidateQuestionBankCache() {
  for (const invalidate of invalidators) invalidate();
}
