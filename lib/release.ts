import { appPath } from './app-path.ts';

export const APP_RELEASE = '1.2.0';

export function releaseAssetPath(path: string) {
  return `${appPath(path)}?v=${APP_RELEASE}`;
}
