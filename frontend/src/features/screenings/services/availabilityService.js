import { apiRequest } from "../../../shared/services/apiClient.js";

export async function getAvailability(screen, screening, { signal } = {}) {
  const data = await apiRequest(
    `/seats/availability?screenId=${screen.id}&screeningId=${screening.id}`,
    { signal, cache: "no-store" },
  );
  const complete = data?.inventory_complete;
  if (
    data?.screen_id !== screen.id ||
    data?.screening_id !== screening.id ||
    typeof complete !== "boolean" ||
    !Number.isFinite(Date.parse(data?.as_of)) ||
    data.seated?.total !== screen.capacity ||
    data.wheelchair?.total !== 10 ||
    ![data.seated, data.wheelchair].every((zone) =>
      complete
        ? Number.isInteger(zone.available) &&
          zone.available >= 0 &&
          zone.available <= zone.total
        : zone.available === null,
    )
  )
    throw new Error("Invalid availability response");
  return data;
}
