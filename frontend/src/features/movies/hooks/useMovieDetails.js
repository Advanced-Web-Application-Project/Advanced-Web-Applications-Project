import { useEffect, useReducer, useState } from "react";
import { getMovie } from "../services/movieService.js";

export function useMovieDetails(filmId) {
  const [attempt, retry] = useReducer((n) => n + 1, 0);
  const [result, setResult] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    getMovie(filmId, { signal: controller.signal })
      .then((movie) => {
        if (!controller.signal.aborted) setResult({ filmId, attempt, movie });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResult({ filmId, attempt, error: true });
      });
    return () => controller.abort();
  }, [filmId, attempt]);
  const current = result?.filmId === filmId && result?.attempt === attempt;
  return {
    status: !current ? "loading" : result.error ? "error" : "ready",
    movie: current ? result.movie : null,
    retry,
  };
}
