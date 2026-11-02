// Test environment. Integration tests need a real PostgreSQL and Redis:
//   TEST_DATABASE_URL (default postgresql://postgres:postgres@localhost:5432/commentflow_test)
//   TEST_REDIS_URL    (default redis://localhost:6379/15)
// The test database is wiped and re-migrated by the integration suites.
process.env.NODE_ENV = "test";
process.env.APP_URL = "http://localhost:3000";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/commentflow_test";
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";
process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef0123456789";
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.DEMO_MODE = "true";
process.env.ALLOW_REGISTRATION = "true";
process.env.ALLOWED_EMAILS = "";
process.env.INSTAGRAM_APP_ID = "1234567890";
process.env.INSTAGRAM_APP_SECRET = "test-instagram-app-secret";
process.env.FACEBOOK_APP_SECRET = "";
process.env.WEBHOOK_VERIFY_TOKEN = "verify-me-please";
process.env.PRIVATE_REPLY_HOURLY_LIMIT = "750";
process.env.DM_HOURLY_LIMIT = "200";
process.env.PUBLIC_REPLY_HOURLY_LIMIT = "200";
