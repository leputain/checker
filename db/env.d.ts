import type {
  D1Database as WorkerD1Database,
  D1PreparedStatement as WorkerD1PreparedStatement,
  D1Result as WorkerD1Result,
} from '@cloudflare/workers-types';

// Import Worker interfaces as module types. Loading all Worker globals together
// with @types/node shadows Node's Buffer APIs in scripts and browser tests.
declare global {
  type D1Database = WorkerD1Database;
  type D1PreparedStatement = WorkerD1PreparedStatement;
  type D1Result<T = unknown> = WorkerD1Result<T>;
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TELEGRAM_BOT_TOKEN?: string;
      TELEGRAM_CHAT_ID?: string;
      TELEGRAM_ENABLED?: string;
      TELEGRAM_REQUIRED?: string;
      TELEGRAM_REPORT_MODE?: string;
      TELEGRAM_CONFIG_STATUS?: string;
      MAINTENANCE_TOKEN?: string;
      ADMIN_CONFIG_STATUS?: string;
      ADMIN_PIN_HASH?: string;
      ADMIN_PIN_SALT?: string;
      ADMIN_PIN_ITERATIONS?: string;
      ADMIN_SESSION_SECRET?: string;
      ANALYTICS_ENABLED?: string;
      BALANCED_SELECTION_ENABLED?: string;
      BALANCED_SELECTION_SHADOW?: string;
      CALIBRATION_ENABLED?: string;
      ANALYTICS_EXPORT_ENABLED?: string;
      SECURITY_CHALLENGE_ENABLED?: string;
    }
  }
}
