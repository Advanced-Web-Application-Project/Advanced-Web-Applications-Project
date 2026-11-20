import "dotenv/config";
import { parseStaffCommand } from "../src/features/staff/staffProvisioningService.js";
import { StaffProvisioningError } from "../src/features/staff/staffProvisioningError.js";
import { auditStaff, manageStaff } from "./database/manage-staff.js";
import { readStaffPassword } from "./staff-password-prompt.js";
import { readDatabaseUrl, reportDatabaseError } from "./database/connection.js";

const usage = `Local staff management (no HTTP endpoints):
  npm run staff:manage -- audit
  npm run staff:manage -- provision --email <email> --role administrator
  npm run staff:manage -- provision --email <email> --role cashier --city Oulu
  npm run staff:manage -- reset-password --email <email>
  npm run staff:manage -- disable --email <email>
Writes require the explicit isolated local database target. Passwords are entered
in a hidden terminal prompt, never in arguments or environment variables.
Audit is read-only and reports IDs only. Provisioning reruns preserve credentials,
role, city and disabled state. Reset does not re-enable a disabled account.`;
try {
  const input = parseStaffCommand(process.argv.slice(2));
  if (input.action === "help") console.log(usage);
  else {
    const databaseUrl = readDatabaseUrl();
    const result =
      input.action === "audit"
        ? await auditStaff({ databaseUrl })
        : await manageStaff({
            databaseUrl,
            mode: process.env.RIO_DATABASE_MODE,
            input,
            readPassword: readStaffPassword,
          });
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  if (error instanceof StaffProvisioningError) {
    console.error(error.message);
    process.exitCode = 1;
  } else reportDatabaseError(error);
}
