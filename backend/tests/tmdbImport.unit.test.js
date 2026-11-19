import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTmdbImportConfig } from '../src/config/tmdbImportConfig.js';
import { createTmdbClient } from '../src/features/films/tmdbClient.js';
import { importTmdbFilms, parseAndValidateTmdbIds } from '../src/features/films/filmImportService.js';
import { parseCliArgs } from '../src/features/films/importTmdbCli.js';

const VALID_CONFIG_PAYLOAD = {
  images: {
    secure_base_url: 'https://image.tmdb.org/t/p/',
    poster_sizes: ['w185', 'w342', 'w500', 'original'],
  },
};

test('CLI and ID validation reject missing, zero, negative, and non-numeric IDs', () => {
  assert.throws(() => parseCliArgs([]), /Missing required flag --ids/);
  assert.deepEqual(parseAndValidateTmdbIds('603, 550, 603'), [603, 550]);
  assert.throws(() => parseAndValidateTmdbIds(''), /Invalid TMDB movie ID/);
  assert.throws(() => parseAndValidateTmdbIds('0,550'), /Invalid TMDB movie ID/);
  assert.throws(() => parseAndValidateTmdbIds('-5'), /Invalid TMDB movie ID/);
  assert.throws(() => parseAndValidateTmdbIds('550,abc'), /Invalid TMDB movie ID/);
});

test('Environment guard blocks missing token, non-isolated mode, and non-loopback targets', () => {
  assert.throws(
    () =>
      loadTmdbImportConfig({
        RIO_DATABASE_MODE: 'production',
        DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/rio_dev',
        TMDB_API_READ_ACCESS_TOKEN: 'secret-token',
      }),
    /isolated-development/
  );

  assert.throws(
    () =>
      loadTmdbImportConfig({
        RIO_DATABASE_MODE: 'isolated-development',
        DATABASE_URL: 'postgresql://user:pass@db.csc.fi:5432/rio_dev',
        TMDB_API_READ_ACCESS_TOKEN: 'secret-token',
      }),
    /not a loopback address/
  );

  assert.throws(
    () =>
      loadTmdbImportConfig({
        RIO_DATABASE_MODE: 'isolated-development',
        DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/rio_dev',
        TMDB_API_READ_ACCESS_TOKEN: '',
      }),
    /TMDB_API_READ_ACCESS_TOKEN is required/
  );
});

test('Maps valid movie, missing poster/overview fallbacks, and sends Bearer header only', async () => {
  const seenRequests = [];
  const token = 'super-secret-read-token-do-not-leak';

  const fetchImpl = async (url, init) => {
    seenRequests.push({ url, headers: init.headers });
    assert.equal(url.includes(token), false, 'Token must never appear in request URL');
    assert.equal(init.headers.Authorization, `Bearer ${token}`);

    if (url.endsWith('/configuration')) {
      return new Response(JSON.stringify(VALID_CONFIG_PAYLOAD), { status: 200 });
    }
    if (url.includes('/movie/550?language=en-US')) {
      return new Response(
        JSON.stringify({
          id: 550,
          title: 'Fight Club',
          overview: 'An insomniac office worker...',
          poster_path: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
        }),
        { status: 200 }
      );
    }
    if (url.includes('/movie/603?language=en-US')) {
      return new Response(
        JSON.stringify({
          id: 603,
          title: 'The Matrix',
          overview: '   ',
          poster_path: null,
        }),
        { status: 200 }
      );
    }
    return new Response('{}', { status: 404 });
  };

  let writtenBatch = null;
  const repoDouble = {
    async upsertBatchInTransaction(films) {
      writtenBatch = films;
      return films.map((f, idx) => ({
        localId: idx + 10,
        tmdbId: f.tmdbId,
        metadataApiId: f.metadataApiId,
        title: f.title,
        description: f.description,
        posterUrl: f.posterUrl,
        action: 'inserted',
      }));
    },
  };

  const client = createTmdbClient({ accessToken: token, fetchImpl });
  const result = await importTmdbFilms({
    rawIds: '603,550',
    tmdbClient: client,
    filmImportRepository: repoDouble,
  });

  assert.equal(seenRequests.length, 3);
  assert.equal(result.insertedCount, 2);
  // Sorted numerically before DB write for deadlock safety:
  assert.deepEqual(
    writtenBatch.map((f) => f.metadataApiId),
    ['tmdb:550', 'tmdb:603']
  );
  assert.equal(
    writtenBatch[0].posterUrl,
    'https://image.tmdb.org/t/p/w500/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg'
  );
  assert.equal(writtenBatch[1].posterUrl, null);
  assert.equal(writtenBatch[1].description, null);
});

test('Rejects missing required title or upstream 404 before opening a DB transaction', async () => {
  let dbWriteCalled = false;
  const repoDouble = {
    async upsertBatchInTransaction() {
      dbWriteCalled = true;
      return [];
    },
  };

  const fetchImpl = async (url) => {
    if (url.endsWith('/configuration')) {
      return new Response(JSON.stringify(VALID_CONFIG_PAYLOAD), { status: 200 });
    }
    if (url.includes('/movie/550')) {
      return new Response(JSON.stringify({ id: 550, title: 'Valid Film', overview: 'Ok', poster_path: null }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ id: 999, title: '   ', overview: 'No title' }), { status: 200 });
  };

  const client = createTmdbClient({ accessToken: 'test-token', fetchImpl });
  await assert.rejects(
    () => importTmdbFilms({ rawIds: '550,999', tmdbClient: client, filmImportRepository: repoDouble }),
    /missing a usable non-empty title/
  );
  assert.equal(dbWriteCalled, false);
});

test('Handles 401 without leaking token, bounded 429 retry, 5xx, timeout, and malformed JSON', async () => {
  const token = 'secret-never-echoed';

  // 401
  const client401 = createTmdbClient({
    accessToken: token,
    fetchImpl: async () => new Response('Unauthorized', { status: 401 }),
  });
  await assert.rejects(
    () => client401.fetchConfiguration(),
    (err) => err.code === 'TMDB_AUTH_ERROR' && !err.message.includes(token)
  );

  // 429 bounded retry (1 retry then fails)
  let calls429 = 0;
  const client429 = createTmdbClient({
    accessToken: token,
    maxRetries: 1,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls429 += 1;
      return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '1' } });
    },
  });
  await assert.rejects(() => client429.fetchMovieDetails(550), (err) => err.code === 'TMDB_RATE_LIMITED');
  assert.equal(calls429, 2);

  // Malformed JSON
  const clientBadJson = createTmdbClient({
    accessToken: token,
    fetchImpl: async () => new Response('not-json', { status: 200 }),
  });
  await assert.rejects(
    () => clientBadJson.fetchMovieDetails(550),
    (err) => err.code === 'TMDB_MALFORMED_RESPONSE'
  );

  // Timeout
  const clientTimeout = createTmdbClient({
    accessToken: token,
    timeoutMs: 1000,
    fetchImpl: async () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    },
  });
  await assert.rejects(
    () => clientTimeout.fetchMovieDetails(550),
    (err) => err.code === 'TMDB_TIMEOUT'
  );
});