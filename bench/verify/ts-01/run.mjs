#!/usr/bin/env node
// Runs the ts-01 proof suite against one variant.
//   node bench/verify/ts-01/run.mjs <variant-dir>
// <variant-dir> may be the case directory (…/cases/ts-01-v), its workspace/ or the src/ directory itself.
// Exit code 0 when every test passes, 1 when any test fails, 2 on usage errors.
// The last stdout line is `PAYDIRT_RESULT <json>` with the per-test outcome.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCES = ["tideloom-store.ts", "tideloom-handlers.ts", "tideloom-http.ts"];

function locateSrc(arg) {
  const base = resolve(arg);
  for (const candidate of [join(base, "workspace", "src"), join(base, "src"), base]) {
    if (SOURCES.every(name => existsSync(join(candidate, name)))) return candidate;
  }
  return null;
}

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node run.mjs <variant-dir>");
  process.exit(2);
}
const srcDir = locateSrc(arg);
if (!srcDir) {
  console.error(`run.mjs: no Tideloom sources (${SOURCES.join(", ")}) under ${resolve(arg)}`);
  process.exit(2);
}

const env = { ...process.env, PAYDIRT_VARIANT_SRC: srcDir };
delete env.NODE_ENV;
delete env.NODE_OPTIONS;

const child = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--disable-warning=ExperimentalWarning",
    "--test",
    "--test-reporter=tap",
    join(here, "tideloom.test.mjs"),
  ],
  { env, encoding: "utf8", cwd: here },
);

const stdout = child.stdout ?? "";
process.stdout.write(stdout);
if (child.stderr) process.stderr.write(child.stderr);

// top-level TAP points only (subtests are indented)
const tests = [];
for (const line of stdout.split(/\r?\n/)) {
  const m = /^(not ok|ok) \d+ - (.+?)\s*(?:#.*)?$/.exec(line);
  if (m) tests.push({ name: m[2], ok: m[1] === "ok" });
}
const failed = tests.filter(t => !t.ok).map(t => t.name);
const allPassed = child.status === 0 && tests.length > 0 && failed.length === 0;
console.log(
  `PAYDIRT_RESULT ${JSON.stringify({ pair: "ts-01", src: srcDir, passed: tests.filter(t => t.ok).map(t => t.name), failed, exit: allPassed ? 0 : 1 })}`,
);
process.exit(allPassed ? 0 : 1);
