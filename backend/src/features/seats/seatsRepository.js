export function createSeatsRepository(pool) {
  return {
    async findSeats(screenId) {
      return (
        await pool.query(
          "SELECT * FROM seats WHERE screen_id = $1 ORDER BY id ASC",
          [screenId],
        )
      ).rows;
    },
    async findScreeningAvailability(screenId, screeningId) {
      // One statement uses one snapshot and one database clock for metadata,
      // ticket states and places. Reads never mutate booking/expiry history.
      const result = await pool.query(
        `
        WITH clock AS (
          SELECT statement_timestamp() AS as_of,
            statement_timestamp() AT TIME ZONE 'Europe/Helsinki' AS local_now
        ), listing AS (
          SELECT sc.id AS screening_id, s.id AS screen_id,
            s.capacity, s.wheelchair_capacity
          FROM public.screenings sc JOIN public.screens s ON s.id = sc.screen_id
          WHERE s.id = $1 AND sc.id = $2
        ), active AS (
          SELECT DISTINCT t.seat_id, b.booking_type
          FROM listing l JOIN public.bookings b ON b.screening_id = l.screening_id
          JOIN public.tickets t ON t.booking_id = b.id CROSS JOIN clock
          WHERE public.booking_blocks_place(b.booking_type,b.status,b.expiry_time,clock.local_now)
        )
        SELECT l.screen_id, l.screening_id, l.capacity, l.wheelchair_capacity, clock.as_of,
          COALESCE((SELECT jsonb_agg(to_jsonb(s) || jsonb_build_object(
            'isBooked', EXISTS (SELECT 1 FROM active a WHERE a.seat_id = s.id),
            'isReservedByCeo', EXISTS (SELECT 1 FROM active a WHERE a.seat_id = s.id AND a.booking_type = 'ceo')
          ) ORDER BY s.id) FROM public.seats s WHERE s.screen_id = l.screen_id), '[]'::jsonb) AS seats
        FROM listing l CROSS JOIN clock
      `,
        [screenId, screeningId],
      );
      return result.rows[0] ?? null;
    },
  };
}
