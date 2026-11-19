export const PREFERRED_POSTER_SIZES = ['w500', 'w780', 'w342', 'original'];

export function formatProviderId(tmdbId) {
  return `tmdb:${tmdbId}`;
}

export function extractImageConfig(configPayload) {
  const images = configPayload?.images;
  const secureBaseUrl = typeof images?.secure_base_url === 'string'
    ? images.secure_base_url.trim()
    : '';
  const posterSizes = Array.isArray(images?.poster_sizes)
    ? images.poster_sizes.filter((s) => typeof s === 'string' && s.trim().length > 0)
    : [];

  if (!secureBaseUrl || !secureBaseUrl.startsWith('https://')) {
    throw new Error('TMDB configuration is missing a valid HTTPS images.secure_base_url.');
  }

  if (posterSizes.length === 0) {
    throw new Error('TMDB configuration is missing images.poster_sizes.');
  }

  const posterSize =
    PREFERRED_POSTER_SIZES.find((size) => posterSizes.includes(size)) ||
    posterSizes[posterSizes.length - 1];

  return {
    secureBaseUrl: secureBaseUrl.endsWith('/') ? secureBaseUrl : `${secureBaseUrl}/`,
    posterSize,
  };
}

export function buildPosterUrl(posterPath, imageConfig) {
  if (posterPath === null || posterPath === undefined) {
    return null;
  }
  if (typeof posterPath !== 'string') {
    throw new Error('TMDB poster_path must be a string or null.');
  }

  const trimmed = posterPath.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.startsWith('/')) {
    throw new Error(`TMDB poster_path "${trimmed}" is malformed (expected leading "/").`);
  }

  return `${imageConfig.secureBaseUrl}${imageConfig.posterSize}${trimmed}`;
}

export function mapTmdbMovieToFilm(moviePayload, expectedTmdbId, imageConfig) {
  if (!moviePayload || typeof moviePayload !== 'object' || Array.isArray(moviePayload)) {
    throw new Error(`TMDB movie ${expectedTmdbId} payload is malformed.`);
  }

  if (moviePayload.id !== undefined && Number(moviePayload.id) !== expectedTmdbId) {
    throw new Error(
      `TMDB payload ID mismatch: requested ${expectedTmdbId}, received ${moviePayload.id}.`
    );
  }

  const rawTitle = moviePayload.title;
  if (typeof rawTitle !== 'string' || rawTitle.trim().length === 0) {
    throw new Error(`TMDB movie ${expectedTmdbId} is missing a usable non-empty title.`);
  }

  let description = null;
  if (moviePayload.overview !== null && moviePayload.overview !== undefined) {
    if (typeof moviePayload.overview !== 'string') {
      throw new Error(`TMDB movie ${expectedTmdbId} overview must be a string or null.`);
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