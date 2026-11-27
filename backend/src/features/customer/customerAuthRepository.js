export function createCustomerAuthRepository(pool) {
  return {
    async canonicalEmail(email) {
      return (
        await pool.query("SELECT lower(btrim($1::text)) AS email", [email])
      ).rows[0].email;
    },
    async consumeAttempt(bucket, limit) {
      const row = (
        await pool.query(
          `INSERT INTO customer_login_attempts(bucket,window_start,attempts)
        VALUES($1,clock_timestamp(),1) ON CONFLICT(bucket) DO UPDATE SET
        attempts=CASE WHEN customer_login_attempts.window_start<=EXCLUDED.window_start-interval '15 minutes' THEN 1 ELSE LEAST(customer_login_attempts.attempts+1,$2+1) END,
        window_start=CASE WHEN customer_login_attempts.window_start<=EXCLUDED.window_start-interval '15 minutes' THEN EXCLUDED.window_start ELSE customer_login_attempts.window_start END
        RETURNING attempts`,
          [bucket, limit],
        )
      ).rows[0];
      return row.attempts <= limit;
    },
    async pruneAttempts() {
      await pool.query(
        "DELETE FROM customer_login_attempts WHERE bucket IN (SELECT bucket FROM customer_login_attempts WHERE window_start<clock_timestamp()-interval '1 day' LIMIT 100)",
      );
    },
    async credentials(email) {
      return (
        await pool.query(
          "SELECT id,password_hash,session_version FROM users WHERE login_email=lower(btrim($1)) AND role='customer' AND permitted_city_id IS NULL",
          [email],
        )
      ).rows[0];
    },
    async register(email, passwordHash) {
      return (
        await pool.query(
          `INSERT INTO users(role,email,password_hash)
          VALUES('customer',$1,$2)
          RETURNING id,login_email,session_version,
          floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS now_ms`,
          [email, passwordHash],
        )
      ).rows[0];
    },
    async current(id, version, expiresAt = null) {
      return (
        await pool.query(
          `SELECT id,login_email,session_version,
        floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS now_ms
        FROM users WHERE id=$1 AND role='customer' AND permitted_city_id IS NULL
        AND session_version=$2 AND is_enabled
        AND ($3::double precision IS NULL OR clock_timestamp()<to_timestamp($3/1000.0))`,
          [id, version, expiresAt],
        )
      ).rows[0];
    },
  };
}
