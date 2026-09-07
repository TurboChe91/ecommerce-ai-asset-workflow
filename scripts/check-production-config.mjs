import { readFile } from "node:fs/promises";

const configUrl = new URL("../wrangler.jsonc", import.meta.url);
const config = JSON.parse(await readFile(configUrl, "utf8"));
const failures = [];

if (
  config.vars?.TEAM_DOMAIN === "https://your-team.cloudflareaccess.com" ||
  !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/i.test(config.vars?.TEAM_DOMAIN || "")
) {
  failures.push("TEAM_DOMAIN must be replaced with a real https://<team>.cloudflareaccess.com URL");
}
if (!config.vars?.POLICY_AUD || config.vars.POLICY_AUD === "REPLACE_ME") {
  failures.push("POLICY_AUD must be set to a Cloudflare Access Application Audience");
}
if (config.d1_databases?.some((database) => database.database_id === "00000000-0000-0000-0000-000000000000")) {
  failures.push("D1 database_id must be replaced before deployment");
}

if (failures.length) {
  console.error("Deployment blocked: production configuration is incomplete.\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Production configuration check passed.");
}
