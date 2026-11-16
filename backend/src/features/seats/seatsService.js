export class SeatRequestError extends Error {}

export function createSeatsService(repository) {
  return {
    async listSeats({ screenId, screeningId }) {
      if (!screenId)
        throw new SeatRequestError("screenId query parameter required");
      if (
        screeningId &&
        !(await repository.screeningBelongsToScreen(screeningId, screenId))
      ) {
        throw new SeatRequestError("screeningId must belong to screenId");
      }
      const seats = await repository.findSeats(screenId);
      const occupancy = screeningId
        ? await repository.findTicketOccupancy(screeningId)
        : [];
      const bookedIds = new Set(occupancy.map((row) => row.seat_id));
      const ceoIds = new Set(
        occupancy
          .filter((row) => row.booking_type === "ceo")
          .map((row) => row.seat_id),
      );
      return seats.map((seat) => ({
        ...seat,
        isBooked: bookedIds.has(seat.id),
        isReservedByCeo: screeningId
          ? ceoIds.has(seat.id)
          : (!seat.is_wheelchair && seat.seat_label === 1) ||
            Boolean(seat.is_ceo_reserved),
      }));
    },
  };
}
