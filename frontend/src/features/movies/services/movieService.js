import { apiGet } from "../../../shared/services/apiClient.js";

export async function getMovie(id, { signal } = {}) {
  const movie = await apiGet(`/films/${id}`, { signal });
  if (
    !movie ||
    movie.id !== id ||
    typeof movie.title !== "string" ||
    !movie.title.trim() ||
    (movie.description !== null && typeof movie.description !== "string")
  )
    throw new Error("Unexpected movie data");
  return { id: movie.id, title: movie.title, description: movie.description };
}
