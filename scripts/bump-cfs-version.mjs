import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 2010–2099 keeps YY exactly two digits without semver's forbidden leading zero.
export function parseReleaseVersion(version) {
  if (typeof version !== "string") return null;
  const match = /^([1-9]\d)\.([1-9]|1[0-2])\.([1-9]\d*)$/.exec(version);
  if (!match) return null;
  const [, year, month, count] = match.map(Number);
  return Number.isSafeInteger(count) ? { year, month, count } : null;
}

export function parseReleaseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Date must be YYYY-MM-DD.");
  }
  const [year, month, day] = value.split("-").map(Number);
  if (year < 2010 || year > 2099) throw new Error("Release year must be between 2010 and 2099.");
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new Error("Date must be a valid calendar date.");
  }
  return { year: year % 100, month };
}

export function nextReleaseVersion(previous, date) {
  const target = parseReleaseDate(date);
  if (previous === "0.1.0") return `${target.year}.${target.month}.1`;
  const current = parseReleaseVersion(previous);
  if (!current) throw new Error("Current version must be YY.M.N or the initial version 0.1.0.");
  const difference = (target.year - current.year) * 12 + target.month - current.month;
  if (difference < 0) throw new Error("Release date cannot precede the current version's year and month.");
  if (difference === 0 && current.count === Number.MAX_SAFE_INTEGER) {
    throw new Error("Monthly release count would exceed the safe integer limit.");
  }
  return `${target.year}.${target.month}.${difference === 0 ? current.count + 1 : 1}`;
}

function localDate(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function parseArguments(args, now = new Date()) {
  let dryRun = false;
  let date;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--dry-run" && !dryRun) dryRun = true;
    else if (args[index] === "--date" && date === undefined) {
      date = args[++index];
      parseReleaseDate(date);
    } else throw new Error(`Unknown or duplicate argument: ${args[index]}`);
  }
  date ??= localDate(now);
  parseReleaseDate(date);
  return { dryRun, date };
}

function readJsonFile(root, name, optional = false) {
  const filename = path.join(root, name);
  let stat;
  try {
    stat = lstatSync(filename);
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} must be a regular file.`);
  const original = readFileSync(filename, "utf8");
  const json = JSON.parse(original);
  if (!json || Array.isArray(json) || typeof json !== "object") throw new Error(`${name} must contain a JSON object.`);
  return { filename, original, json, mode: stat.mode };
}

function serialize(file) {
  const newline = file.original.includes("\r\n") ? "\r\n" : "\n";
  const indent = file.original.match(/\n([\t ]+)"/)?.[1] ?? 2;
  const ending = /\r?\n$/.test(file.original) ? newline : "";
  return JSON.stringify(file.json, null, indent).replace(/\n/g, newline) + ending;
}

export function planVersionBump(root, date) {
  const pkg = readJsonFile(root, "package.json");
  const previous = pkg.json.version;
  const version = nextReleaseVersion(previous, date);
  const lock = readJsonFile(root, "package-lock.json", true);
  // npm ci reads these two root versions. Dependency package versions stay intact.
  if (lock) {
    if (![2, 3].includes(lock.json.lockfileVersion) || lock.json.version !== previous ||
        lock.json.packages?.[""]?.version !== previous) {
      throw new Error("package-lock.json must be v2/v3 with both root versions matching package.json; repair it before bumping.");
    }
    lock.json.version = version;
    lock.json.packages[""].version = version;
  }
  pkg.json.version = version;
  const files = [pkg, ...(lock ? [lock] : [])].map((file) => ({ ...file, updated: serialize(file) }));
  return { previous, version, files };
}

function writePlan(files) {
  const staged = [];
  const written = [];
  try {
    for (const file of files) {
      const temporary = `${file.filename}.${randomUUID()}.tmp`;
      staged.push({ ...file, temporary });
      writeFileSync(temporary, file.updated, { encoding: "utf8", flag: "wx", mode: file.mode });
    }
    for (const file of staged) {
      if (readFileSync(file.filename, "utf8") !== file.original) {
        throw new Error(`${path.basename(file.filename)} changed during the bump; retry after reviewing it.`);
      }
      renameSync(file.temporary, file.filename);
      written.push(file);
    }
  } catch (error) {
    // The pair cannot be crash-atomic. Normal I/O errors roll back our own writes;
    // interruption/inconsistent roots are detected by the next plan's validation.
    const recoveryErrors = [];
    for (const file of written.reverse()) {
      try {
        if (readFileSync(file.filename, "utf8") !== file.updated) {
          throw new Error(`${path.basename(file.filename)} changed again; automatic rollback refused.`);
        }
        writeFileSync(file.filename, file.original, "utf8");
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError.message);
      }
    }
    throw new Error([error.message, ...recoveryErrors].join(" "));
  } finally {
    for (const file of staged) {
      try { unlinkSync(file.temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}

export function run(args, root = process.cwd(), now = new Date()) {
  const { dryRun, date } = parseArguments(args, now);
  const plan = planVersionBump(root, date);
  if (!dryRun) writePlan(plan.files);
  return `${dryRun ? "[dry-run] " : ""}${plan.previous} -> ${plan.version} (${date}; ${plan.files.map((file) => path.basename(file.filename)).join(", ")})`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (error) {
    console.error(`CFS version bump refused: ${error.message}`);
    process.exitCode = 1;
  }
}
