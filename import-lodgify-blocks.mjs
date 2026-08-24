import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncLodgifyData } from "./lodgify-sync.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, "data");
const reservationsPath = path.join(dataDir, "reservations.json");
const apiKey = process.env.LODGIFY_API_KEY;
const iCalUrl = process.env.LODGIFY_ICAL_URL;
const syncMonths = Number(process.env.LODGIFY_SYNC_MONTHS || 12);

if (!apiKey && !iCalUrl) {
  console.error("Set LODGIFY_API_KEY or LODGIFY_ICAL_URL before running this import.");
  process.exit(1);
}

const store = JSON.parse(await readFile(reservationsPath, "utf8"));
const result = await syncLodgifyData(store, {
  apiKey,
  months: syncMonths,
  apiBaseUrl: process.env.LODGIFY_API_BASE_URL,
  propertyId: process.env.LODGIFY_PROPERTY_ID,
  roomTypeId: process.env.LODGIFY_ROOM_TYPE_ID,
  iCalUrl
});

await writeFile(reservationsPath, `${JSON.stringify(result.store, null, 2)}\n`);

console.log(`Imported ${result.importedBookings} Lodgify booking ${result.importedBookings === 1 ? "summary" : "summaries"}.`);
console.log(`Synced ${result.availabilityBlocks} Lodgify availability block${result.availabilityBlocks === 1 ? "" : "s"}.`);
for (const warning of result.warnings || []) {
  console.warn(`Warning: ${warning}`);
}
