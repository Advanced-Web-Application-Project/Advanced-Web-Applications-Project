export function createBookingsRepository(pool) {
  return {
    async listBookings(screeningId) {
      return (
        await pool.query(
          `SELECT b.id AS booking_id,b.booking_type,b.status,b.expiry_time,
        sc.screening_time,f.title AS film_title,ARRAY_AGG(t.seat_id ORDER BY t.id) AS seat_id
        FROM bookings b JOIN screenings sc ON sc.id=b.screening_id JOIN films f ON f.id=sc.film_id
        LEFT JOIN tickets t ON t.booking_id=b.id ${screeningId === undefined ? "" : "WHERE b.screening_id=$1"}
        GROUP BY b.id,sc.screening_time,f.title ORDER BY b.id DESC`,
          screeningId === undefined ? [] : [screeningId],
        )
      ).rows;
    },
    async transaction(run) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '15s'");
        const transaction = {
          async lockRequestKey(hash) {
            await client.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1,62))",
              [hash],
            );
          },
          async findHoldByTokenHash(hash) {
            return (
              (
                await client.query(
                  "SELECT id,hold_request_fingerprint FROM bookings WHERE hold_token_hash=$1",
                  [hash],
                )
              ).rows[0] ?? null
            );
          },
          async isHoldActive(id) {
            return (
              (
                await client.query(
                  "SELECT expiry_time > clock_timestamp() AT TIME ZONE 'Europe/Helsinki' AS active FROM bookings WHERE id=$1",
                  [id],
                )
              ).rows[0]?.active === true
            );
          },
          async readHoldTickets(id) {
            return (
              await client.query(
                `SELECT seat_id AS "seatId",ticket_category AS category,amount_charged AS "amountCharged" FROM tickets WHERE booking_id=$1 ORDER BY id`,
                [id],
              )
            ).rows;
          },
          async lockScreening(id) {
            const reference = (
              await client.query(
                "SELECT screen_id FROM screenings WHERE id=$1",
                [id],
              )
            ).rows[0];
            if (!reference) return null;
            await client.query(
              "SELECT id FROM screens WHERE id=$1 FOR NO KEY UPDATE",
              [reference.screen_id],
            );
            return (
              (
                await client.query(
                  `SELECT id,screen_id,screening_time > statement_timestamp() AT TIME ZONE 'Europe/Helsinki' AS is_future
              FROM screenings WHERE id=$1 AND screen_id=$2 FOR NO KEY UPDATE`,
                  [id, reference.screen_id],
                )
              ).rows[0] ?? null
            );
          },
          async lockBooking(id) {
            const reference = (
              await client.query(
                "SELECT b.screening_id,sc.screen_id FROM bookings b JOIN screenings sc ON sc.id=b.screening_id WHERE b.id=$1",
                [id],
              )
            ).rows[0];
            if (!reference) return null;
            await client.query(
              "SELECT id FROM screens WHERE id=$1 FOR NO KEY UPDATE",
              [reference.screen_id],
            );
            await client.query(
              "SELECT id FROM screenings WHERE id=$1 FOR NO KEY UPDATE",
              [reference.screening_id],
            );
            return (
              (
                await client.query(
                  `SELECT *, expiry_time AT TIME ZONE 'Europe/Helsinki' AS expires_at
                   FROM bookings WHERE id=$1 FOR NO KEY UPDATE`,
                  [id],
                )
              ).rows[0] ?? null
            );
          },
          async readPrices() {
            return (
              await client.query(
                "SELECT id,category,amount_cents FROM prices WHERE category='adult' ORDER BY id FOR SHARE",
              )
            ).rows;
          },
          async insertHold(screeningId, email, hash, fingerprint = null) {
            return (
              await client.query(
                `INSERT INTO bookings (screening_id,guest_email,status,booking_time,expiry_time,hold_token_hash,hold_request_fingerprint)
              VALUES ($1,$2,'hold',statement_timestamp() AT TIME ZONE 'Europe/Helsinki',
                (statement_timestamp()+interval '5 minutes') AT TIME ZONE 'Europe/Helsinki',$3,$4)
              RETURNING id,screening_id,expiry_time AT TIME ZONE 'Europe/Helsinki' AS expires_at`,
                [screeningId, email, hash, fingerprint],
              )
            ).rows[0];
          },
          async insertTicket(bookingId, ticket) {
            await client.query(
              `INSERT INTO tickets (booking_id,seat_id,price_id,ticket_category,amount_charged)
            VALUES ($1,$2,$3,$4,$5)`,
              [
                bookingId,
                ticket.seatId,
                ticket.priceId,
                ticket.category,
                ticket.amountCharged,
              ],
            );
          },
          async expireHold(id) {
            await client.query(
              "UPDATE bookings SET status='expired' WHERE id=$1",
              [id],
            );
          },
        };
        const result = await run(client, transaction);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
