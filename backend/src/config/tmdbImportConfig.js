import {
  assertIsolatedDevelopment,
  DatabaseCommandError,
  readDatabaseUrl,
} from "../../scripts/database/connection.js";

export const DEFAULT_TMDB_BASE_URL = "https://api.themoviedb.org/3";
export const DEFAULT_TMDB_LANGUAGE = "en-US";
export const DEFAULT_TMDB_TIMEOUT_MS = 8000;

export function loadTmdbImportConfig(env = process.env) {
  const databaseUrl = readDatabaseUrl(env);
  const dbName = assertIsolatedDevelopment(databaseUrl, env.RIO_DATABASE_MODE);

  const accessToken = (env.TMDB_API_READ_ACCESS_TOKEN || "").trim();
  if (!accessToken) {
    throw new DatabaseCommandError(
      "TMDB_API_READ_ACCESS_TOKEN is required in the server/local environment.",
    );
  }

  const rawTimeout = env.TMDB_TIMEOUT_MS;
  let timeoutMs = DEFAULT_TMDB_TIMEOUT_MS;
  if (rawTimeout !== undefined && String(rawTimeout).trim() !== "") {
    const parsedTimeout = Number(rawTimeout);
    if (
      !Number.isInteger(parsedTimeout) ||
      parsedTimeout < 1000 ||
      parsedTimeout > 30000
    ) {
      throw new DatabaseCommandError(
        "TMDB_TIMEOUT_MS must be an integer between 1000 and 30000.",
      );
    }
    timeoutMs = parsedTimeout;
  }

  // The CLI always sends credentials to the official HTTPS API. Tests inject fetch.
  if (
    env.TMDB_API_BASE_URL &&
    env.TMDB_API_BASE_URL !== DEFAULT_TMDB_BASE_URL
  ) {
    throw new DatabaseCommandError(
      "TMDB_API_BASE_URL overrides are not supported by this CLI.",
    );
  }
  const baseUrl = DEFAULT_TMDB_BASE_URL;

  return {
    databaseUrl,
    dbName,
    tmdb: {
      accessToken,
      baseUrl,
      language: DEFAULT_TMDB_LANGUAGE,
      timeoutMs,
    },
  };
}
