import "dotenv/config";
import { seedDemoPrices } from "./database/seed-demo-prices.js";
import { readDatabaseUrl, reportDatabaseError } from "./database/connection.js";
try {
  console.log(
    JSON.stringify(
      await seedDemoPrices({
        databaseUrl: readDatabaseUrl(),
        mode: process.env.RIO_DATABASE_MODE,
      }),
    ),
  );
} catch (error) {
  reportDatabaseError(error);
}
