import { useId } from "react";
import { useMovieDetails } from "../hooks/useMovieDetails.js";

export default function MovieDetails({ filmId }) {
  const { status, movie, retry } = useMovieDetails(filmId);
  const id = useId();
  return (
    <section className="movie-details selection-summary" aria-labelledby={id}>
      <h3 id={id}>Movie details</h3>
      {status === "loading" && <p role="status">Loading movie details…</p>}
      {status === "error" && (
        <>
          <p role="alert">
            We couldn’t load movie details. You can still choose a showtime.
          </p>
          <button type="button" className="retry-button" onClick={retry}>
            Retry movie details
          </button>
        </>
      )}
      {status === "ready" && (
        <>
          <h4>{movie.title}</h4>
          <p className="movie-description">
            {movie.description?.trim() ||
              "No description is available for this movie yet."}
          </p>
        </>
      )}
    </section>
  );
}
