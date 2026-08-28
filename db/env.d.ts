declare namespace Cloudflare {
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
  }
}

declare module '*.sql?raw' {
  const sql: string;
  export default sql;
}
