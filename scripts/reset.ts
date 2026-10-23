// Clear the World Model and past runs (keeps the model reply cache), for a
// clean demo recording.
//   npm run reset
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.ts";

for (const dir of ["world", "runs", "uploads"]) {
  fs.rmSync(path.join(config.dataDir, dir), { recursive: true, force: true });
  console.log(`Removed ${path.join(config.dataDir, dir)}`);
}
console.log("Restart the app if it is running.");
