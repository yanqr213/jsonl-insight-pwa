import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const forbiddenSources = [
  "T" + "ODO",
  "FIX" + "ME",
  "<your-" + "repo-url>",
  "github.com/" + "example",
  "example" + ".com",
  "sk-[A-Za-z0-9_-]{12,}"
];
const forbidden = forbiddenSources.map((source) => new RegExp(source, source.startsWith("sk-") ? "" : "i"));

const ignoredDirs = new Set(["node_modules", ".git", "outputs", "work"]);
const ignoredFiles = new Set(["package-lock.json"]);

const files = [];
await collect(process.cwd());

let failed = false;
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(text)) {
      console.error(`Forbidden placeholder matched ${pattern} in ${file}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(`Placeholder check passed for ${files.length} files.`);

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoredDirs.has(entry.name) || ignoredFiles.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(fullPath);
    } else {
      files.push(fullPath);
    }
  }
}
