const isId = (value) =>
  Number.isInteger(value) && value > 0 && value <= 2147483647;
export const isUnavailable = (place) => place.isBooked || place.isReservedByCeo;

// Display server geometry and labels; never reconstruct snake numbering or gap rules.
export function readSeatLayout(places, screenId, capacity) {
  if (!Array.isArray(places)) throw new Error("Unexpected seat data");
  if (places.length === 0) return { rows: [], wheelchairs: [], places: [] };
  if (![100, 200].includes(capacity) || places.length !== capacity + 10)
    throw new Error("Incomplete seat layout");
  const ids = new Set(),
    positions = new Set(),
    rows = new Map();
  for (const place of places) {
    const key = `${place.physical_row}:${place.physical_column}`;
    if (
      !isId(place.id) ||
      ids.has(place.id) ||
      positions.has(key) ||
      place.screen_id !== screenId ||
      typeof place.is_wheelchair !== "boolean" ||
      typeof place.isBooked !== "boolean" ||
      typeof place.isReservedByCeo !== "boolean" ||
      typeof place.display_label !== "string" ||
      !place.display_label.trim() ||
      !Number.isInteger(place.row_label) ||
      !Number.isInteger(place.physical_column) ||
      place.physical_column < 1 ||
      place.physical_column > 10 ||
      (place.is_wheelchair
        ? place.physical_row !== 0
        : !Number.isInteger(place.physical_row) ||
          place.physical_row < 1 ||
          place.physical_row > capacity / 10)
    )
      throw new Error("Incomplete seat layout");
    ids.add(place.id);
    positions.add(key);
    if (!place.is_wheelchair) {
      if (!rows.has(place.physical_row))
        rows.set(place.physical_row, {
          physicalRow: place.physical_row,
          label: place.row_label,
          places: [],
        });
      if (rows.get(place.physical_row).label !== place.row_label)
        throw new Error("Inconsistent row labels");
      rows.get(place.physical_row).places.push(place);
    }
  }
  const byColumn = (a, b) => a.physical_column - b.physical_column;
  return {
    places: [...places],
    rows: [...rows.values()]
      .sort((a, b) => b.physicalRow - a.physicalRow)
      .map((row) => ({ ...row, places: row.places.sort(byColumn) })),
    wheelchairs: places.filter((p) => p.is_wheelchair).sort(byColumn),
  };
}

export function readSelectionResult(
  result,
  { screenId, screeningId, seatIds },
) {
  if (
    !result ||
    result.screen_id !== screenId ||
    result.screening_id !== screeningId ||
    !Number.isFinite(Date.parse(result.as_of)) ||
    typeof result.valid !== "boolean" ||
    !Array.isArray(result.seat_ids) ||
    result.seat_ids.length !== seatIds.length ||
    new Set(result.seat_ids).size !== seatIds.length ||
    result.seat_ids.some((id) => !seatIds.includes(id)) ||
    !Array.isArray(result.errors) ||
    result.errors.some(
      (error) =>
        !error ||
        typeof error.message !== "string" ||
        typeof error.code !== "string",
    ) ||
    (result.valid ? result.errors.length !== 0 : result.errors.length === 0)
  )
    throw new Error("Unexpected validation response");
  return result;
}
