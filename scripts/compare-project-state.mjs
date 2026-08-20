import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  throw new Error("Usage: node scripts/compare-project-state.mjs <before.json> <after.json>");
}

function projectsFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.projects)) return value.projects;
  throw new Error("JSON payload does not contain a projects array.");
}

function summary(projects) {
  return projects
    .map((project) => ({ id: String(project.id || ""), name: String(project.name || "") }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const [beforeRaw, afterRaw] = await Promise.all([readFile(beforePath, "utf8"), readFile(afterPath, "utf8")]);
const before = projectsFrom(JSON.parse(beforeRaw.replace(/^\uFEFF/, "")));
const after = projectsFrom(JSON.parse(afterRaw.replace(/^\uFEFF/, "")));
const beforeSummary = summary(before);
const afterSummary = summary(after);
const result = {
  beforeCount: before.length,
  afterCount: after.length,
  beforeProjectHash: digest(beforeSummary),
  afterProjectHash: digest(afterSummary),
  sameProjectIdsAndNames: JSON.stringify(beforeSummary) === JSON.stringify(afterSummary),
};
console.log(JSON.stringify(result, null, 2));
if (!result.sameProjectIdsAndNames) process.exitCode = 1;
