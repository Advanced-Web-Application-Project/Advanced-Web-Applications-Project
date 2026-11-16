import "dotenv/config";
import { readDatabaseUrl, reportDatabaseError } from "./database/connection.js";
import { seedInventory } from "./database/seed-inventory.js";

try {
  console.log(
    JSON.stringify(
      await seedInventory({
        databaseUrl: readDatabaseUrl(),
        mode: process.env.RIO_DATABASE_MODE,
      }),
      null,
      2,
    ),
  );
} catch (error) {
  reportDatabaseError(error);
}
