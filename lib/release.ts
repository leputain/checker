import { appPath } from '@/lib/app-path.ts';

export const APP_RELEASE = '0.5.1';

export function releaseAssetPath(path: string) {
  return `${appPath(path)}?v=${APP_RELEASE}`;
}
