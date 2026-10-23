// OTel, logger with redaction (doc 05 §5.3). OTel and Sentry arrive with F21-06.
export const workspace = '@parallelflow/observability' as const;

export { createLogger, REDACT_PATHS } from './logger.js';
export type { AccessLogEntry, Logger, LoggerOptions } from './logger.js';
