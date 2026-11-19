import { apiRequest } from "../../../shared/services/apiClient.js";
import { readSeatLayout, readSelectionResult } from "../utils/seatLayout.js";

export async function getSeatLayout(
  screenId,
  screeningId,
  capacity,
  { signal } = {},
) {
  const query = new URLSearchParams({
    screenId: String(screenId),
    screeningId: String(screeningId),
  });
  return readSeatLayout(
    await apiRequest(`/seats?${query}`, { signal, cache: "no-store" }),
    screenId,
    capacity,
  );
}
export async function validateSelection(request, { signal } = {}) {
  return readSelectionResult(
    await apiRequest("/seats/validate", {
      method: "POST",
      body: request,
      signal,
      cache: "no-store",
    }),
    request,
  );
}
