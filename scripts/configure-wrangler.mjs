import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

function discoverDatabaseId() {
  const databaseName = process.env.CLOUDFLARE_D1_DATABASE_NAME?.trim() || "shared-fund-ledger";
  const databases = JSON.parse(execFileSync("npx", ["wrangler", "d1", "list", "--json"], { encoding: "utf8" }));
  const matches = databases.filter((database) => database.name === databaseName);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one D1 database named ${databaseName}, found ${matches.length}`);
  }
  return matches[0].uuid;
}

const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID?.trim() || discoverDatabaseId();
if (!databaseId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)) {
  throw new Error("CLOUDFLARE_D1_DATABASE_ID must be a D1 database UUID");
}

const template = await readFile(new URL("../wrangler.toml.example", import.meta.url), "utf8");
if (!template.includes("YOUR_D1_DATABASE_ID")) throw new Error("wrangler.toml.example is missing the database placeholder");
await writeFile(new URL("../wrangler.toml", import.meta.url), template.replace("YOUR_D1_DATABASE_ID", databaseId));
