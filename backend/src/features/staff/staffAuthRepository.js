export function createStaffAuthRepository(pool) {
  return {
    async canonicalEmail(email) {
      return (
        await pool.query("SELECT lower(btrim($1::text)) AS email", [email])
      ).rows[0].email;
    },
    async consumeAttempt(bucket, limit) {
      const row = (
        await pool.query(
          `INSERT INTO staff_login_attempts(bucket,window_start,attempts)
        VALUES($1,clock_timestamp(),1) ON CONFLICT(bucket) DO UPDATE SET
        attempts=CASE WHEN staff_login_attempts.window_start<=EXCLUDED.window_start-interval '15 minutes' THEN 1 ELSE LEAST(staff_login_attempts.attempts+1,$2+1) END,
        window_start=CASE WHEN staff_login_attempts.window_start<=EXCLUDED.window_start-interval '15 minutes' THEN EXCLUDED.window_start ELSE staff_login_attempts.window_start END
        RETURNING attempts`,
          [bucket, limit],
        )
      ).rows[0];
      return row.attempts <= limit;
    },
    async pruneAttempts() {
      // Bounded cleanup of obsolete buckets, never active windows.
      await pool.query(
        "DELETE FROM staff_login_attempts WHERE bucket IN (SELECT bucket FROM staff_login_attempts WHERE window_start<clock_timestamp()-interval '1 day' LIMIT 100)",
      );
    },
    async credentials(email) {
      return (
        await pool.query(
          "SELECT id,password_hash,session_version FROM users WHERE login_email=lower(btrim($1))",
          [email],
        )
      ).rows[0];
    },
    async current(id, version, expiresAt = null) {
      return (
        await pool.query(
          `SELECT id,role,permitted_city_id,session_version,
        clock_timestamp() AS as_of, floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS now_ms
        FROM users WHERE id=$1 AND session_version=$2 AND is_enabled
        AND ((role='administrator' AND permitted_city_id IS NULL) OR (role='cashier' AND permitted_city_id IS NOT NULL))
        AND ($3::double precision IS NULL OR clock_timestamp()<to_timestamp($3/1000.0))`,
          [id, version, expiresAt],
        )
      ).rows[0];
    },
    async recordEvent(userId, event) {
      await pool.query(
        "INSERT INTO staff_auth_events(actor_user_id,event_type) VALUES($1,$2)",
        [userId, event],
      );
    },
  };
}
