import { applyRuntimeRetention } from '@/lib/runtime-retention.ts';
import { database } from './runtime';

export async function maintainRuntimeRetention(now = Date.now()) {
  await applyRuntimeRetention(database(), now);
}
