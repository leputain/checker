export type CandidateCheckFeatureFlags = {
  analytics: boolean;
  balancedSelection: boolean;
  balancedSelectionShadow: boolean;
  calibration: boolean;
  analyticsExport: boolean;
};

function enabled(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return value === '1' || value.toLocaleLowerCase('en-US') === 'true';
}

export function readFeatureFlags(environment: Partial<Cloudflare.Env>): CandidateCheckFeatureFlags {
  return {
    analytics: enabled(environment.ANALYTICS_ENABLED, true),
    balancedSelection: enabled(environment.BALANCED_SELECTION_ENABLED, false),
    balancedSelectionShadow: enabled(environment.BALANCED_SELECTION_SHADOW, true),
    calibration: enabled(environment.CALIBRATION_ENABLED, true),
    analyticsExport: enabled(environment.ANALYTICS_EXPORT_ENABLED, true),
  };
}
