/**
 * Operator tool: force-disarm the live L3 arm so auto:cycle can re-arm.
 * Usage: npx tsx scripts/disarm-session.ts
 */
import { closeDatabase, migrate, openDatabase } from "../src/storage/db/client.js";
import { disarmSession } from "../src/automation/armSession.js";

const db = openDatabase();
migrate(db);
const status = disarmSession(db);
console.log(JSON.stringify(status, null, 2));
closeDatabase(db);
