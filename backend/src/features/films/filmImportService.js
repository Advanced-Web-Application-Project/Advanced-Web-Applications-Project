import { FilmImportValidationError } from "./filmImportError.js";
import { extractImageConfig, mapTmdbMovieToFilm } from "./tmdbFilmMapper.js";

const POSITIVE_INT_PATTERN = /^[1-9]\d*$/;

export function parseAndValidateTmdbIds(rawIds) {
  const parts = Array.isArray(rawIds)
    ? rawIds.map((v) => String(v))
    : typeof rawIds === "string"
      ? rawIds.split(",")
      : [];

  if (parts.length === 0) {
    throw new FilmImportValidationError(
      "At least one positive integer TMDB movie ID is required (--ids <id1,id2>).",
    );
  }

  const seen = new Set();
  const validated = [];

  for (const rawPart of parts) {
    const token = rawPart.trim();
    if (!POSITIVE_INT_PATTERN.test(token)) {
      throw new FilmImportValidationError(
        "Invalid TMDB movie ID. Expected comma-separated positive integers.",
      );
    }

    const parsed = Number(token);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new FilmImportValidationError(
        "TMDB movie ID is outside the safe positive integer range.",
      );
    }

    if (!seen.has(parsed)) {
      seen.add(parsed);
      validated.push(parsed);
    }
  }

  return validated;
}

export async function importTmdbFilms({
  rawIds,
  tmdbClient,
  filmImportRepository,
}) {
  const requestedIds = parseAndValidateTmdbIds(rawIds);

  // 1. Fetch TMDB image configuration once per batch.
  const configPayload = await tmdbClient.fetchConfiguration();
  const imageConfig = extractImageConfig(configPayload);

  // 2. Fetch and validate ALL requested movies before opening a DB transaction.
  const mappedFilms = [];
  for (const tmdbId of requestedIds) {
    const moviePayload = await tmdbClient.fetchMovieDetails(tmdbId);
    mappedFilms.push(mapTmdbMovieToFilm(moviePayload, tmdbId, imageConfig));
  }

  // 3. Deterministic lock order prevents deadlocks across concurrent overlapping batches.
  const orderedForWrite = [...mappedFilms].sort((a, b) => a.tmdbId - b.tmdbId);

  // 4. Persist the entire batch inside one atomic transaction.
  const persisted =
    await filmImportRepository.upsertBatchInTransaction(orderedForWrite);

  return {
    language: "en-US",
    requestedCount: requestedIds.length,
    insertedCount: persisted.filter((r) => r.action === "inserted").length,
    updatedCount: persisted.filter((r) => r.action === "updated").length,
    films: persisted,
  };
}
