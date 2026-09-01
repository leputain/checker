import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';
const localStatePath = process.env.CANDIDATE_CHECK_STATE_PATH ?? '.wrangler/state';

const localBindingConfig = {
  main: 'vinext/server/app-router-entry',
  compatibility_flags: ['nodejs_compat'],
  secrets: {
    required: [
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
      'MAINTENANCE_TOKEN',
      'ADMIN_PIN_HASH',
      'ADMIN_PIN_SALT',
      'ADMIN_SESSION_SECRET',
    ],
  },
  vars: {
    TELEGRAM_ENABLED: process.env.TELEGRAM_ENABLED ?? '1',
    TELEGRAM_REQUIRED: process.env.TELEGRAM_REQUIRED ?? '1',
    TELEGRAM_CONFIG_STATUS: process.env.TELEGRAM_CONFIG_STATUS ?? 'missing',
    ADMIN_CONFIG_STATUS: process.env.ADMIN_CONFIG_STATUS ?? 'missing',
    ADMIN_PIN_ITERATIONS: process.env.ADMIN_PIN_ITERATIONS ?? '210000',
    ANALYTICS_ENABLED: process.env.ANALYTICS_ENABLED ?? '1',
    BALANCED_SELECTION_ENABLED: process.env.BALANCED_SELECTION_ENABLED ?? '0',
    BALANCED_SELECTION_SHADOW: process.env.BALANCED_SELECTION_SHADOW ?? '1',
    CALIBRATION_ENABLED: process.env.CALIBRATION_ENABLED ?? '1',
    ANALYTICS_EXPORT_ENABLED: process.env.ANALYTICS_EXPORT_ENABLED ?? '1',
    SECURITY_CHALLENGE_ENABLED: process.env.SECURITY_CHALLENGE_ENABLED ?? '0',
  },
  d1_databases: [
    {
      binding: 'DB',
      database_name: 'candidate-check-local',
      database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
    },
  ],
  r2_buckets: [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    preview: {
      allowedHosts: ['hub.themuha.cc'],
    },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: localBindingConfig,
        persistState: { path: localStatePath },
      }),
    ],
  };
});
