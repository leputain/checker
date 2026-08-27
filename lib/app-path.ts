const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH?.trim() ?? '';

export const appBasePath = configuredBasePath.replace(/\/$/, '');

export function appPath(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${appBasePath}${normalizedPath}`;
}
