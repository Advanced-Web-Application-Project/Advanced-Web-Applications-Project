export class SeatRequestError extends Error {}

const MAX_DATABASE_ID = 2147483647;

export function parseSeatQuery(query, { requireScreening = false } = {}) {
  const result = {};
  for (const name of ["screenId", "screeningId"]) {
    const value = query[name];
    const bracketed = Object.keys(query).some((key) =>
      key.startsWith(`${name}[`),
    );
    if (value === undefined && !bracketed) {
      if (name === "screenId" || requireScreening)
        throw new SeatRequestError(`${name} query parameter required`);
      continue;
    }
    if (
      bracketed ||
      typeof value !== "string" ||
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < 1 ||
      Number(value) > MAX_DATABASE_ID
    )
      throw new SeatRequestError(
        `${name} must be a positive integer between 1 and ${MAX_DATABASE_ID}`,
      );
    result[name] = Number(value);
  }
  return result;
}

export function summarizeAvailability(snapshot) {
  const seated = snapshot.seats.filter((seat) => !seat.is_wheelchair);
  const wheelchair = snapshot.seats.filter((seat) => seat.is_wheelchair);
  const complete =
    seated.length === snapshot.capacity &&
    wheelchair.length === snapshot.wheelchair_capacity;
  return {
    screen_id: snapshot.screen_id,
    screening_id: snapshot.screening_id,
    as_of: snapshot.as_of,
    inventory_complete: complete,
    seated: {
      total: snapshot.capacity,
      available: complete
        ? seated.filter((seat) => !seat.isBooked).length
        : null,
    },
    wheelchair: {
      total: snapshot.wheelchair_capacity,
      available: complete
        ? wheelchair.filter((seat) => !seat.isBooked).length
        : null,
    },
  };
}

export function createSeatsService(repository) {
  async function readScreening({ screenId, screeningId }) {
    const snapshot = await repository.findScreeningAvailability(
      screenId,
      screeningId,
    );
    if (!snapshot)
      throw new SeatRequestError("screeningId must belong to screenId");
    return snapshot;
  }
  return {
    async listSeats(query) {
      const ids = parseSeatQuery(query);
      if (ids.screeningId) return (await readScreening(ids)).seats;
      const seats = await repository.findSeats(ids.screenId);
      return seats.map((seat) => ({
        ...seat,
        isBooked: false,
        isReservedByCeo:
          (!seat.is_wheelchair && seat.seat_label === 1) ||
          Boolean(seat.is_ceo_reserved),
      }));
    },
    async getAvailability(query) {
      return summarizeAvailability(
        await readScreening(parseSeatQuery(query, { requireScreening: true })),
      );
    },
  };
}
