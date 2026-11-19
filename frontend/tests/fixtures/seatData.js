import { generateScreenInventory } from "../../../database/seeds/inventory.js";
export function seatData(capacity = 100, screenId = 11, booked = []) {
  return generateScreenInventory(capacity).map((place, index) => ({
    ...place,
    id: screenId * 1000 + index + 1,
    screen_id: screenId,
    isBooked:
      place.is_ceo_reserved || booked.map(String).includes(place.display_label),
    isReservedByCeo: place.is_ceo_reserved,
  }));
}
export const response = (data, status = 200, error) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () =>
    error ? { success: false, error } : { success: true, data },
});
export function selectionResponse(request, valid = true, errors = []) {
  return {
    screen_id: request.screenId,
    screening_id: request.screeningId,
    as_of: new Date().toISOString(),
    seat_ids: request.seatIds,
    valid,
    errors,
  };
}
export function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
