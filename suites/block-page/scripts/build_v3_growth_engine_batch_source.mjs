#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateFile = path.resolve(root, process.argv[2] ?? ".state/v3-full-heading-state.json");
const outputFile = path.resolve(root, process.argv[3] ?? ".state/growth-engine-v3-full-ranking-source.json");
const state = JSON.parse(await readFile(stateFile, "utf8"));
const records = (state.records ?? []).filter((record) =>
  record.heading_status === "configured_verified" && record.page_url,
);

const allPlaced = new Map();
for (const record of state.records ?? []) {
  if (!record.page_url || !["existing_added", "added_new"].includes(record.status)) continue;
  if (!allPlaced.has(record.page_url)) allPlaced.set(record.page_url, []);
  allPlaced.get(record.page_url).push(record);
}

// Only include pages whose every placed block is already configured_verified.
// This avoids modifying unrelated blocks on partially configured pages.
const verifiedPages = [...new Set(records.map((record) => record.page_url))]
  .filter((url) => allPlaced.get(url)?.length > 0 &&
    allPlaced.get(url).every((record) => record.heading_status === "configured_verified"));
const pageByUrl = new Map(verifiedPages.map((url, index) => {
  const sample = records.find((record) => record.page_url === url);
  return [url, {
    number: index + 1,
    name: sample.page_name,
    path: new URL(url).pathname,
    publicUrl: url,
  }];
}));

const output = {
  version: 1,
  source: stateFile,
  selection: "configured_verified pages where every placed block is configured_verified",
  pages: verifiedPages.map((url) => pageByUrl.get(url)),
  records: records.filter((record) => pageByUrl.has(record.page_url)).map((record) => ({
    ...record,
    status: "added",
  })),
  generated_at: new Date().toISOString(),
};
await mkdir(path.dirname(outputFile), { recursive: true });
await writeFile(outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output: outputFile,
  pages: output.pages.length,
  records: output.records.length,
  pageLinks: output.pages.map((page) => page.publicUrl),
}, null, 2));
