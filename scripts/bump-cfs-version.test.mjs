import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nextReleaseVersion, parseArguments, parseReleaseDate, parseReleaseVersion } from "./bump-cfs-version.mjs";

const script = fileURLToPath(new URL("./bump-cfs-version.mjs", import.meta.url));
const fixtureRoot = process.env.CFS_VERSION_TEST_DIR || os.tmpdir();
mkdirSync(fixtureRoot, { recursive: true });

function fixture(version = "26.9.1", lockVersion = version, lockfileVersion = 3) {
  const root = mkdtempSync(path.join(fixtureRoot, "cfs-version-"));
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "synthetic-version-test", version, private: true, dependencies: { example: "1.0.0" } }, null, 2)}\n`);
  writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify({ name: "synthetic-version-test", version: lockVersion, lockfileVersion, packages: { "": { version: lockVersion }, "node_modules/example": { version: "1.0.0", integrity: "synthetic" } } }, null, 2)}\n`.replace(/\n/g, "\r\n"));
  return root;
}

function snapshot(root) {
  return ["package.json", "package-lock.json"].map((name) => readFileSync(path.join(root, name), "utf8"));
}

function cli(root, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
}

test("same month, next month, next year and first release", () => {
  assert.equal(nextReleaseVersion("26.9.1", "2026-09-16"), "26.9.2");
  assert.equal(nextReleaseVersion("26.9.2", "2026-10-01"), "26.10.1");
  assert.equal(nextReleaseVersion("26.12.9", "2027-01-01"), "27.1.1");
  assert.equal(nextReleaseVersion("0.1.0", "2026-09-16"), "26.9.1");
  assert.equal(nextReleaseVersion("26.9.1", "2026-09-01"), "26.9.2");
});

test("canonical release grammar and safe count", () => {
  assert.deepEqual(parseReleaseVersion("26.9.1"), { year: 26, month: 9, count: 1 });
  for (const version of ["0.1.0", "1.2.3", "06.9.1", "26.09.1", "26.9.0", "26.9.01", "26.13.1", "26.9.1-beta", "v26.9.1", "26.9.1 ", "26.9.9007199254740992", null]) {
    assert.equal(parseReleaseVersion(version), null, String(version));
  }
  assert.throws(() => nextReleaseVersion("26.9.9007199254740991", "2026-09-16"), /safe integer/);
  assert.equal(nextReleaseVersion("26.9.9007199254740991", "2026-10-01"), "26.10.1");
});

test("real dates, supported years and backward version dates", () => {
  assert.deepEqual(parseReleaseDate("2028-02-29"), { year: 28, month: 2 });
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-09-00", "2026-9-1", "2009-12-31", "2100-01-01", "2026-09-16extra", undefined]) {
    assert.throws(() => parseReleaseDate(date), undefined, String(date));
  }
  assert.throws(() => nextReleaseVersion("26.9.1", "2026-08-31"), /cannot precede/);
  assert.throws(() => nextReleaseVersion("27.1.1", "2026-12-31"), /cannot precede/);
  assert.throws(() => nextReleaseVersion("1.2.3", "2026-09-16"), /Current version/);
});

test("arguments reject unknown, duplicate and missing values; default uses local date", () => {
  assert.deepEqual(parseArguments([], new Date(2026, 8, 16, 23)), { dryRun: false, date: "2026-09-16" });
  assert.deepEqual(parseArguments(["--date", "2026-09-16", "--dry-run"]), { dryRun: true, date: "2026-09-16" });
  for (const args of [["--dryrun"], ["--date"], ["--date", "--dry-run"], ["--dry-run", "--dry-run"], ["--date", "2026-09-16", "--date", "2026-10-01"], ["unexpected"]]) {
    assert.throws(() => parseArguments(args), undefined, JSON.stringify(args));
  }
});

test("CLI dry-run reports acceptance examples and preserves exact package/lock bytes", () => {
  for (const [version, date, expected] of [["26.9.1", "2026-09-16", "26.9.2"], ["26.9.2", "2026-10-01", "26.10.1"], ["0.1.0", "2026-09-16", "26.9.1"]]) {
    const root = fixture(version);
    const before = snapshot(root);
    const result = cli(root, ["--dry-run", "--date", date]);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.ok(result.stdout.includes(`${version} -> ${expected}`), result.stdout);
    assert.deepEqual(snapshot(root), before);
  }
});

test("CLI write updates all three root versions, keeps dependency and newline style, repeats", () => {
  for (const lockfileVersion of [2, 3]) {
    const root = fixture("0.1.0", "0.1.0", lockfileVersion);
    const before = snapshot(root).map(JSON.parse);
    for (const [date, version] of [["2026-09-16", "26.9.1"], ["2026-09-16", "26.9.2"], ["2026-10-01", "26.10.1"]]) {
      const result = cli(root, ["--date", date]);
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const texts = snapshot(root);
      const [pkg, lock] = texts.map(JSON.parse);
      assert.equal(pkg.version, version);
      assert.equal(lock.version, version);
      assert.equal(lock.packages[""].version, version);
      assert.deepEqual(pkg.dependencies, before[0].dependencies);
      assert.deepEqual(lock.packages["node_modules/example"], before[1].packages["node_modules/example"]);
      assert.ok(!texts[0].includes("\r\n"));
      assert.ok(texts[1].includes("\r\n"));
      assert.ok(!texts[1].replace(/\r\n/g, "").includes("\n"));
      assert.deepEqual(readdirSync(root).sort(), ["package-lock.json", "package.json"]);
    }
  }
});

test("CLI handles a package without a lock and does not invent one", () => {
  const root = fixture();
  unlinkSync(path.join(root, "package-lock.json"));
  const result = cli(root, ["--date", "2026-09-16"]);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version, "26.9.2");
  assert.deepEqual(readdirSync(root), ["package.json"]);
});

test("CLI rejects malformed JSON and mismatched/missing lock package root without writing", () => {
  for (const invalidLock of [
    "{broken json",
    "null",
    JSON.stringify({ version: "26.9.1", lockfileVersion: 3 }),
    JSON.stringify({ version: "26.9.1", lockfileVersion: 3, packages: { "": { version: "26.8.1" } } }),
  ]) {
    const root = fixture();
    writeFileSync(path.join(root, "package-lock.json"), invalidLock);
    const before = snapshot(root);
    const result = cli(root, ["--date", "2026-09-16"]);
    assert.equal(result.status, 1, result.error?.message);
    assert.deepEqual(snapshot(root), before);
    assert.deepEqual(readdirSync(root).sort(), ["package-lock.json", "package.json"]);
  }
});

test("CLI rejects invalid inputs before either package changes", () => {
  for (const [version, lockVersion, lockfileVersion, args] of [
    ["26.9.1", "26.9.2", 3, []],
    ["26.9.1", "26.9.1", 1, []],
    ["invalid", "invalid", 3, []],
    ["26.9.9007199254740991", "26.9.9007199254740991", 3, []],
    ["26.10.1", "26.10.1", 3, []],
    ["26.9.1", "26.9.1", 3, ["--typo"]],
  ]) {
    const root = fixture(version, lockVersion, lockfileVersion);
    const before = snapshot(root);
    const result = cli(root, ["--date", "2026-09-16", ...args]);
    assert.equal(result.status, 1, result.error?.message);
    assert.match(result.stderr, /CFS version bump refused/);
    assert.deepEqual(snapshot(root), before);
  }
});
