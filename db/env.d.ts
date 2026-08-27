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
  }
}

declare module '*.sql?raw' {
  const sql: string;
  export default sql;
}
