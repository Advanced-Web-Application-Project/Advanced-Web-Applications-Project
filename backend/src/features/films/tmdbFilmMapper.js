import { FilmImportValidationError } from "./filmImportError.js";
export const PREFERRED_POSTER_SIZES = ["w500", "w780", "w342", "original"];

export function formatProviderId(tmdbId) {
  return `tmdb:${tmdbId}`;
}

export function extractImageConfig(configPayload) {
  const images = configPayload?.images;
  const secureBaseUrl =
    typeof images?.secure_base_url === "string"
      ? images.secure_base_url.trim()
      : "";
  const posterSizes = Array.isArray(images?.poster_sizes)
    ? images.poster_sizes.filter(
        (s) => typeof s === "string" && /^(w[1-9]\d*|original)$/.test(s),
      )
    : [];

  try {
    const url = new URL(secureBaseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new FilmImportValidationError(
      "TMDB configuration is missing a valid HTTPS images.secure_base_url.",
    );
  }

  if (posterSizes.length === 0) {
    throw new FilmImportValidationError(
      "TMDB configuration is missing images.poster_sizes.",
    );
  }

  const posterSize =
    PREFERRED_POSTER_SIZES.find((size) => posterSizes.includes(size)) ||
    posterSizes[posterSizes.length - 1];

  return {
    secureBaseUrl: secureBaseUrl.endsWith("/")
      ? secureBaseUrl
      : `${secureBaseUrl}/`,
    posterSize,
  };
}

export function buildPosterUrl(posterPath, imageConfig) {
  if (posterPath === null || posterPath === undefined) {
    return null;
  }
  if (typeof posterPath !== "string") {
    throw new FilmImportValidationError(
      "TMDB poster_path must be a string or null.",
    );
  }

  const trimmed = posterPath.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(trimmed)) {
    throw new FilmImportValidationError(
      "TMDB poster_path is malformed (expected a single absolute image path).",
    );
  }

  return `${imageConfig.secureBaseUrl}${imageConfig.posterSize}${trimmed}`;
}

export function mapTmdbMovieToFilm(moviePayload, expectedTmdbId, imageConfig) {
  if (
    !moviePayload ||
    typeof moviePayload !== "object" ||
    Array.isArray(moviePayload)
  ) {
    throw new FilmImportValidationError(
      `TMDB movie ${expectedTmdbId} payload is malformed.`,
    );
  }

  if (
    !Number.isSafeInteger(moviePayload.id) ||
    moviePayload.id !== expectedTmdbId
  ) {
    throw new FilmImportValidationError(
      `TMDB payload ID mismatch or missing ID for requested movie ${expectedTmdbId}.`,
    );
  }

  const rawTitle = moviePayload.title;
  if (typeof rawTitle !== "string" || rawTitle.trim().length === 0) {
    throw new FilmImportValidationError(
      `TMDB movie ${expectedTmdbId} is missing a usable non-empty title.`,
    );
  }

  if ([...rawTitle.trim()].length > 255 || rawTitle.includes("\0")) {
    throw new FilmImportValidationError(
      `TMDB movie ${expectedTmdbId} title exceeds 255 characters or contains a null byte.`,
    );
  }

  let description = null;
  if (moviePayload.overview !== null && moviePayload.overview !== undefined) {
    if (typeof moviePayload.overview !== "string") {
      throw new FilmImportValidationError(
        `TMDB movie ${expectedTmdbId} overview must be a string or null.`,
      );
    }
    if (moviePayload.overview.includes("\0")) {
      throw new FilmImportValidationError(
        `TMDB movie ${expectedTmdbId} overview contains a null byte.`,
      );
    }
    const trimmedOverview = moviePayload.overview.trim();
    description = trimmedOverview.length > 0 ? trimmedOverview : null;
  }

  const posterUrl = buildPosterUrl(moviePayload.poster_path, imageConfig);

  return {
    tmdbId: expectedTmdbId,
    metadataApiId: formatProviderId(expectedTmdbId),
    title: rawTitle.trim(),
    description,
    posterUrl,
  };
}
