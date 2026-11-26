const PRICE_FIELDS =
  "p.id, p.category, p.amount_cents, p.version, p.updated_at, p.updated_by_user_id, u.email AS updated_by_email";

export function createPricesRepository(pool) {
  return {
    async listPrices() {
      return (
        await pool.query(`SELECT ${PRICE_FIELDS} FROM public.prices p
        LEFT JOIN public.users u ON u.id=p.updated_by_user_id
        WHERE p.is_current AND p.category='adult' ORDER BY p.id`)
      ).rows;
    },
    async transaction(run) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '15s'");
        await client.query("SELECT pg_advisory_xact_lock(7420861)");
        const tx = {
          async findByCategoryForUpdate(category) {
            return (
              (
                await client.query(
                  `SELECT id,category,amount_cents,version FROM public.prices
              WHERE category=$1 AND is_current FOR UPDATE`,
                  [category],
                )
              ).rows[0] ?? null
            );
          },
          async upsertCategoryPrice(category, amountCents, actor) {
            const result = await client.query(
              `INSERT INTO public.prices(category,amount_cents,updated_by_user_id)
              VALUES($1,$2,$3)
              ON CONFLICT(category) WHERE is_current DO UPDATE SET
                amount_cents=EXCLUDED.amount_cents, version=prices.version+1,
                updated_at=statement_timestamp(), updated_by_user_id=EXCLUDED.updated_by_user_id,
                updated_by_email=NULL
              RETURNING id,category,amount_cents,version,updated_at,updated_by_user_id`,
              [category, amountCents, actor.userId],
            );
            const email = await client.query(
              "SELECT email FROM public.users WHERE id=$1",
              [actor.userId],
            );
            return {
              ...result.rows[0],
              updated_by_email: email.rows[0]?.email ?? null,
            };
          },
        };
        const result = await run(tx);
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
