export const MAX_DATABASE_ID = 2147483647;
const MAX_SELECTION_SIZE = 210;

export class SeatSelectionRequestError extends Error {}

function isDatabaseId(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_DATABASE_ID;
}

export function parseSelectionRequest(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) => !["screenId", "screeningId", "seatIds"].includes(key),
    )
  )
    throw new SeatSelectionRequestError(
      "Send an object containing only screenId, screeningId and seatIds",
    );
  for (const name of ["screenId", "screeningId"])
    if (!isDatabaseId(body[name]))
      throw new SeatSelectionRequestError(
        `${name} must be a JSON integer between 1 and ${MAX_DATABASE_ID}`,
      );
  if (
    !Array.isArray(body.seatIds) ||
    body.seatIds.length < 1 ||
    body.seatIds.length > MAX_SELECTION_SIZE ||
    Array.from(body.seatIds).some((id) => !isDatabaseId(id))
  )
    throw new SeatSelectionRequestError(
      `seatIds must contain 1–${MAX_SELECTION_SIZE} positive JSON integer IDs`,
    );
  if (new Set(body.seatIds).size !== body.seatIds.length)
    throw new SeatSelectionRequestError(
      "seatIds must not contain duplicate IDs",
    );
  return {
    screenId: body.screenId,
    screeningId: body.screeningId,
    seatIds: [...body.seatIds],
  };
}

function hasCompletePositions(snapshot) {
  if (
    ![100, 200].includes(snapshot.capacity) ||
    snapshot.wheelchair_capacity !== 10 ||
    snapshot.seats.length !== snapshot.capacity + 10
  )
    return false;
  const positions = new Set();
  const ids = new Set();
  for (const seat of snapshot.seats) {
    if (
      !isDatabaseId(seat.id) ||
      ids.has(seat.id) ||
      typeof seat.is_wheelchair !== "boolean" ||
      typeof seat.isBooked !== "boolean" ||
      !Number.isInteger(seat.physical_column) ||
      seat.physical_column < 1 ||
      seat.physical_column > 10
    )
      return false;
    if (
      seat.is_wheelchair
        ? seat.physical_row !== 0
        : !Number.isInteger(seat.physical_row) ||
          seat.physical_row < 1 ||
          seat.physical_row > snapshot.capacity / 10
    )
      return false;
    const key = `${seat.is_wheelchair}:${seat.physical_row}:${seat.physical_column}`;
    if (positions.has(key)) return false;
    positions.add(key);
    ids.add(seat.id);
  }
  return true;
}

export function findNewSeatGaps(seats, selectedIds) {
  const rows = new Map();
  for (const seat of seats) {
    if (seat.is_wheelchair) continue;
    if (!rows.has(seat.physical_row)) rows.set(seat.physical_row, []);
    rows.get(seat.physical_row).push(seat);
  }
  const gaps = [];
  for (const row of [...rows.values()].sort(
    (a, b) => a[0].physical_row - b[0].physical_row,
  )) {
    row.sort((a, b) => a.physical_column - b.physical_column);
    for (let index = 1; index < row.length - 1; index++) {
      const [left, place, right] = row.slice(index - 1, index + 2);
      const existed = !place.isBooked && left.isBooked && right.isBooked;
      const unavailable = (seat) => seat.isBooked || selectedIds.has(seat.id);
      if (
        !existed &&
        !unavailable(place) &&
        unavailable(left) &&
        unavailable(right)
      )
        gaps.push(place);
    }
  }
  return gaps;
}

// Pure reusable rules: the caller supplies a server-owned screening snapshot
// and IDs already checked by parseSelectionRequest.
// A later allocation service must obtain that snapshot and revalidate inside its transaction.
export function validateSeatSelection(snapshot, seatIds) {
  const result = {
    screen_id: snapshot.screen_id,
    screening_id: snapshot.screening_id,
    as_of: snapshot.as_of,
    seat_ids: [...seatIds],
    valid: false,
    errors: [],
  };
  if (!hasCompletePositions(snapshot)) {
    result.errors.push({
      code: "INVENTORY_INCOMPLETE",
      message:
        "The seating layout is incomplete. Please try another screening or retry later.",
    });
    return result;
  }
  const places = new Map(snapshot.seats.map((seat) => [seat.id, seat]));
  const unknown = seatIds.filter((id) => !places.has(id));
  const protectedIds = seatIds.filter((id) => places.get(id)?.isReservedByCeo);
  const occupied = seatIds.filter(
    (id) => places.get(id)?.isBooked && !places.get(id)?.isReservedByCeo,
  );
  if (unknown.length)
    result.errors.push({
      code: "SEATS_NOT_IN_SCREEN",
      message: "Some selected places do not belong to this screening's screen.",
      seat_ids: unknown,
    });
  if (protectedIds.length)
    result.errors.push({
      code: "CEO_RESERVED",
      message: "The CEO-reserved place is unavailable for this screening.",
      seat_ids: protectedIds,
    });
  if (occupied.length)
    result.errors.push({
      code: "SEATS_UNAVAILABLE",
      message:
        "Some selected places are no longer available. Please choose again.",
      seat_ids: occupied,
    });
  if (result.errors.length) return result;
  const gaps = findNewSeatGaps(snapshot.seats, new Set(seatIds));
  for (const gap of gaps)
    result.errors.push({
      code: "ISOLATED_SEAT_GAP",
      message: `This selection leaves seat ${gap.display_label} alone in row ${gap.row_label}. Choose an adjacent place or change the selection.`,
      seat_ids: [gap.id],
      row_label: gap.row_label,
    });
  result.valid = result.errors.length === 0;
  return result;
}
