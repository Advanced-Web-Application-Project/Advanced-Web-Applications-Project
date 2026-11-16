import "dotenv/config";
import { readDatabaseUrl } from "./database/connection.js";
import { verifyInventory } from "./database/verify-inventory.js";

try {
  console.log(
    JSON.stringify(
      await verifyInventory({
        databaseUrl: readDatabaseUrl(),
        baseUrl:
          process.env.API_BASE_URL ||
          `http://localhost:${process.env.PORT || 3000}`,
      }),
      null,
      2,
    ),
  );
} catch {
  console.error(
    "Inventory verification failed. Check browsing fixtures, inventory migration/seed, API_BASE_URL and the running backend.",
  );
  process.exitCode = 1;
}
