// Regenerates test/Fixed.t.sol from test/Vulnerable.t.sol so the two proof files can only ever
// differ in the TollWeaver import path and the test contract name. With --check it verifies the
// committed Fixed.t.sol instead of writing it (exit 1 on drift).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "test/Vulnerable.t.sol"), "utf8");
const expected = source
	.replace('"../src/vulnerable/TollWeaver.sol"', '"../src/fixed/TollWeaver.sol"')
	.replace("contract VulnerableTest is Test {", "contract FixedTest is Test {");
if (expected === source) throw new Error("nothing was substituted");

const target = resolve(here, "test/Fixed.t.sol");
if (process.argv.includes("--check")) {
	const actual = readFileSync(target, "utf8");
	if (actual !== expected) {
		console.error("test/Fixed.t.sol has drifted from test/Vulnerable.t.sol");
		process.exit(1);
	}
	console.log("test/Fixed.t.sol matches test/Vulnerable.t.sol (import path and contract name aside)");
} else {
	writeFileSync(target, expected);
	console.log("wrote test/Fixed.t.sol");
}
