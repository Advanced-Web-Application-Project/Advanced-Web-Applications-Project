// Aggregate reads reuse the same authoritative booking_blocks_place predicate as
// customer seat snapshots. No allocation/expiry writes or independent hold rules.
export function createStaffScreeningsRepository(pool) {
  return {
    async listStaffScreenings(filters, permittedCity) {
      const { cityId, screenId, dateFrom, dateTo } = filters;
      const result = await pool.query(
        `
      WITH clock AS (
        SELECT statement_timestamp() AS as_of,
          statement_timestamp() AT TIME ZONE 'Europe/Helsinki' AS local_now
      ), selected AS (
        SELECT sc.id, sc.film_id, f.title AS film_title, sc.screening_time AT TIME ZONE 'Europe/Helsinki' AS screening_time,
          s.id AS screen_id, s.city_id, c.name AS city_name, s.capacity, s.wheelchair_capacity
        FROM screenings sc JOIN screens s ON s.id=sc.screen_id
        JOIN cities c ON c.id=s.city_id JOIN films f ON f.id=sc.film_id
        WHERE ($1::integer IS NULL OR s.city_id=$1)
          AND ($2::integer IS NULL OR s.city_id=$2)
          AND ($3::integer IS NULL OR s.id=$3)
          AND sc.screening_time >= $4::date
          AND sc.screening_time < $5::date + interval '1 day'
        ORDER BY sc.screening_time,sc.id LIMIT 501
      ), counted AS (
        SELECT sc.*, clock.as_of, inv.* FROM selected sc CROSS JOIN clock
        CROSS JOIN LATERAL (
          SELECT count(*) FILTER (WHERE NOT is_wheelchair)::int AS seated_count,
            count(*) FILTER (WHERE is_wheelchair)::int AS wheelchair_count,
            count(*) FILTER (WHERE NOT is_wheelchair AND NOT is_booked)::int AS seated_available,
            count(*) FILTER (WHERE is_wheelchair AND NOT is_booked)::int AS wheelchair_available
          FROM (
            SELECT seat.is_wheelchair, EXISTS (
              SELECT 1 FROM tickets t JOIN bookings b ON b.id=t.booking_id
              WHERE t.seat_id=seat.id AND b.screening_id=sc.id
                AND public.booking_blocks_place(b.booking_type,b.status,b.expiry_time,clock.local_now)
            ) AS is_booked FROM seats seat WHERE seat.screen_id=sc.screen_id
          ) places
        ) inv
        ORDER BY sc.screening_time,sc.id LIMIT 500
      )
      SELECT clock.as_of,
        (SELECT count(*)>500 FROM selected) AS truncated,
        COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM cities c
          WHERE ($1::integer IS NULL OR c.id=$1)), '[]'::jsonb) AS cities,
        COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM screens s
          WHERE ($1::integer IS NULL OR s.city_id=$1)), '[]'::jsonb) AS screens,
        COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.screening_time,x.id) FROM counted x), '[]'::jsonb) AS screenings
      FROM clock`,
        [permittedCity, cityId ?? null, screenId ?? null, dateFrom, dateTo],
      );
      const data = result.rows[0];
      return {
        ...data,
        screenings: data.screenings.map((row) => {
          const complete =
            row.seated_count === row.capacity &&
            row.wheelchair_count === row.wheelchair_capacity;
          return {
            id: row.id,
            film_id: row.film_id,
            film_title: row.film_title,
            screening_time: new Date(row.screening_time).toISOString(),
            screen_id: row.screen_id,
            city_id: row.city_id,
            city_name: row.city_name,
            availability: {
              as_of: data.as_of,
              inventory_complete: complete,
              seated: {
                total: row.capacity,
                available: complete ? row.seated_available : null,
              },
              wheelchair: {
                total: row.wheelchair_capacity,
                available: complete ? row.wheelchair_available : null,
              },
            },
          };
        }),
      };
    },
  };
}
