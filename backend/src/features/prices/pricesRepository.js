const PRICE_FIELDS = "id, category, amount_cents, version, updated_at, updated_by_user_id, updated_by_email";

export function createPricesRepository(pool) {
    return {
        async listPrices(){
            const result = await pool.query(`
                SELECT ${PRICE_FIELDS} FROM public.prices ORDER BY id ASC
                `)
                return result.rows
        },
    

async transaction(run){
    const client = await pool.connect()
    try{
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '15s'");
        await client.query("SELECT pg_advisory_xact_lock(7420861)")

        const tx = {
            async findByCategoryForUpdate(category) {
                const result = await client.query(
                    `SELECT ${PRICE_FIELDS} FROM public.prices WHERE category = $1 FOR UPDATE`,
                    [category],
                )
                return result.rows[0] ?? null;
            },

            async upsertCategoryPrice(category, amountCents, actor = null){
               const actorUserId = actor?.userId ?? null;
            const actorEmail = actor?.email ?? null;
            const result = await client.query(
              `INSERT INTO public.prices (
                 category,
                 amount_cents,
                 version,
                 updated_at,
                 updated_by_user_id,
                 updated_by_email
               )
               VALUES ($1, $2, 1, NOW(), $3, $4)
               ON CONFLICT (category)
               DO UPDATE SET
                 amount_cents = EXCLUDED.amount_cents,
                 version = public.prices.version + 1,
                 updated_at = NOW(),
                 updated_by_user_id = COALESCE(EXCLUDED.updated_by_user_id, public.prices.updated_by_user_id),
                 updated_by_email = COALESCE(EXCLUDED.updated_by_email, public.prices.updated_by_email)
               RETURNING ${PRICE_FIELDS}`,
              [category, amountCents, actorUserId, actorEmail],
            );
            return result.rows[0];
          },
        };
        const data = await run(tx);
        await client.query("COMMIT")
        return data;
    } catch(error){
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    }finally{
        client.release();
    }
}
    }   
}