import type { NextConfig } from 'next';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.trim() ?? '';

if (basePath && !/^\/[a-z0-9][a-z0-9/_-]*$/i.test(basePath)) {
  throw new Error('NEXT_PUBLIC_BASE_PATH должен быть пустым или начинаться с /');
}

const nextConfig: NextConfig = {
  basePath: basePath || undefined,
};

export default nextConfig;
