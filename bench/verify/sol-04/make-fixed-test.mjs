// Generates test/Fixed.t.sol from test/Vulnerable.t.sol: same test bodies, the only
// differences are the source import path and the test contract's name.
// Usage: node make-fixed-test.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "test", "Vulnerable.t.sol"), "utf8").replace(/\r\n/g, "\n");

function swap(text, from, to) {
	const n = text.split(from).length - 1;
	if (n !== 1) throw new Error(`expected exactly one "${from}", found ${n}`);
	return text.replace(from, to);
}

let out = swap(src, '"../src/vulnerable/Cinderloom.sol"', '"../src/fixed/Cinderloom.sol"');
out = swap(out, "contract VulnerableTest is Test {", "contract FixedTest is Test {");
out = swap(
	out,
	"// Paydirt proof, pair sol-04. This file is the single source of the test bodies:\n// test/Fixed.t.sol is generated from it by make-fixed-test.mjs (import path and\n// contract name only), so both variants are checked by identical assertions.\n",
	"// Paydirt proof, pair sol-04. GENERATED from test/Vulnerable.t.sol by make-fixed-test.mjs\n// (import path and contract name only). Do not edit by hand.\n",
);
writeFileSync(resolve(here, "test", "Vulnerable.t.sol"), src);
writeFileSync(resolve(here, "test", "Fixed.t.sol"), out);
console.log("wrote test/Fixed.t.sol");
