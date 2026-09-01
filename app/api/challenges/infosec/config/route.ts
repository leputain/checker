import { env } from 'cloudflare:workers';
import { readFeatureFlags } from '@/lib/feature-flags.ts';
import { SECURITY_CHALLENGE_CONFIG } from '@/lib/security-challenge-config.ts';
import { challengeJson } from '@/lib/security-challenge-http.ts';
import { securityChallengePoolSnapshot } from '@/db/security-challenge.ts';

export async function GET() {
  const enabled = readFeatureFlags(env).securityChallenge;
  if (!enabled) return challengeJson({ enabled: false });
  try {
    const snapshot = await securityChallengePoolSnapshot();
    return challengeJson({
      enabled: true,
      ready: true,
      totalTimeSeconds: SECURITY_CHALLENGE_CONFIG.totalTimeSeconds,
      questionTimeSeconds: SECURITY_CHALLENGE_CONFIG.questionTimeSeconds,
      minimumRankedQuestions: SECURITY_CHALLENGE_CONFIG.minimumRankedQuestions,
      poolSize: snapshot.questionIds.length,
    });
  } catch {
    console.error('security_challenge_config_failed');
    return challengeJson({ enabled: true, ready: false }, { status: 503 });
  }
}
