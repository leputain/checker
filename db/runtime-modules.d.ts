declare module 'cloudflare:workers' {
  export const env: Cloudflare.Env;
}

declare module '*.sql?raw' {
  const sql: string;
  export default sql;
}
