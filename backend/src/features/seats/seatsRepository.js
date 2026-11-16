export function createSeatsRepository(pool) {
  return {
    async screeningBelongsToScreen(screeningId, screenId) {
      return (
        (
          await pool.query(
            "SELECT id FROM screenings WHERE id = $1 AND screen_id = $2",
            [screeningId, screenId],
          )
        ).rows.length > 0
      );
    },
    async findSeats(screenId) {
      return (
        await pool.query(
          "SELECT * FROM seats WHERE screen_id = $1 ORDER BY id ASC",
          [screenId],
        )
      ).rows;
    },
    async findTicketOccupancy(screeningId) {
      return (
        await pool.query(
          `SELECT tickets.seat_id, bookings.booking_type
        FROM tickets JOIN bookings ON tickets.booking_id = bookings.id
        WHERE bookings.screening_id = $1`,
          [screeningId],
        )
      ).rows;
    },
  };
}
