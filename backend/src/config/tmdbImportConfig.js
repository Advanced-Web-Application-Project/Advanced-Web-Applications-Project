const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ALLOWED_ISOLATED_DB_NAMES = new Set(['rio_dev', 'rio_test']);

export const DEFAULT_TMDB_BASE_URL = 'https://api.themoviedb.org/3';
export const DEFAULT_TMDB_LANGUAGE = 'en-US';
export const DEFAULT_TMDB_TIMEOUT_MS = 8000;

/**
 * Replace this helper with your existing isolated-development target guard
 * from backend/src/config/ if already extracted into a shared module.
 */
export function assertIsolatedDevelopmentTarget(env = process.env) {
  const mode = (env.RIO_DATABASE_MODE || '').trim();
  if (mode !== 'isolated-development') {
    throw new Error(
      'Refusing database write: RIO_DATABASE_MODE must be set to "isolated-development".'
    );
  }

  const databaseUrl = (env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the postgres:// or postgresql:// scheme.');
  }

  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing database write: host "${host}" is not a loopback address (localhost, 127.0.0.1, ::1).`
    );
  }

  const dbName = parsed.pathname.replace(/^\/+/, '');
  if (!ALLOWED_ISOLATED_DB_NAMES.has(dbName)) {
    throw new Error(
      `Refusing database write: database "${dbName || '(empty)'}" is not an allowed isolated target (rio_dev or rio_test).`
    );
  }

  return { databaseUrl, host, dbName, mode };
}

export function loadTmdbImportConfig(env = process.env) {
  const dbTarget = assertIsolatedDevelopmentTarget(env);

  const accessToken = (env.TMDB_API_READ_ACCESS_TOKEN || '').trim();
  if (!accessToken) {
    throw new Error(
      'TMDB_API_READ_ACCESS_TOKEN is required in the server/local environment.'
    );
  }

  const rawTimeout = env.TMDB_TIMEOUT_MS;
  let timeoutMs = DEFAULT_TMDB_TIMEOUT_MS;
  if (rawTimeout !== undefined && String(rawTimeout).trim() !== '') {
    const parsedTimeout = Number(rawTimeout);
    if (!Number.isInteger(parsedTimeout) || parsedTimeout < 1000 || parsedTimeout > 30000) {
      throw new Error('TMDB_TIMEOUT_MS must be an integer between 1000 and 30000.');
    }
    timeoutMs = parsedTimeout;
  }

  const baseUrl = (env.TMDB_API_BASE_URL || DEFAULT_TMDB_BASE_URL).replace(/\/+$/, '');

  return {
    ...dbTarget,
    tmdb: {
      accessToken,
      baseUrl,
      language: DEFAULT_TMDB_LANGUAGE,
      timeoutMs,
    },
  };
}