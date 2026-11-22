export interface Env {
  DB: D1Database;
  HOUSEHOLD: DurableObjectNamespace;
  LIMITER: DurableObjectNamespace;
  ASSETS: Fetcher;
  PHOTOS?: R2Bucket;   // optional: photos are off until R2 is enabled
  EVENTS?: AnalyticsEngineDataset;
  ADMIN_MODE: string;
  PROTOCOL_VERSION: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ADMIN_EMAIL?: string;
  ADMIN_SETUP_CODE?: string;
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}
