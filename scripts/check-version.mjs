#!/usr/bin/env node
/**
 * usage: node scripts/check-version.mjs
 *
 * Asserts that package.json and package-lock.json name the same version.
 *
 * `npm ci` does not: it reconciles dependencies against the lock and never
 * looks at the root package's own version, so the two drifted from 0.1.0 to
 * 0.1.5 here with CI green throughout. The lock is not published -- npm keeps
 * it out of the tarball -- so nothing a consumer installs was ever wrong; the
 * point is that the lock should describe the commit it sits in.
 *
 * The lock records the version twice, at the top level and again under
 * `packages[""]`, and `npm version` writes both. Checking only one would miss
 * a hand-edit to the other.
 *
 * Node rather than shell: comparing two JSON strings in bash means quoting
 * `npm pkg get` output against a `node -p` of the lock, which is easy to get
 * subtly wrong and reads like a puzzle.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const read = (name) => {
  const file = path.join(root, name);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`could not read ${name}: ${err.message}`);
    process.exit(2);
  }
};

const pkg = read("package.json");
const lock = read("package-lock.json");

const want = pkg.version;
if (!want) {
  console.error("package.json has no version");
  process.exit(2);
}

const found = [
  ["package-lock.json version", lock.version],
  ['package-lock.json packages[""].version', lock.packages?.[""]?.version],
];

const wrong = found.filter(([, got]) => got !== want);
if (wrong.length) {
  console.error(`package.json says ${want}, but:`);
  for (const [where, got] of wrong) console.error(`  ${where} says ${got ?? "nothing"}`);
  console.error("");
  console.error("Use `npm version <patch|minor|major>`, which writes both files, rather than");
  console.error("editing the version by hand. To repair a drift already committed:");
  console.error(`  npm version ${want} --no-git-tag-version --allow-same-version`);
  process.exit(1);
}

console.log(`package.json and package-lock.json agree on ${want}`);
