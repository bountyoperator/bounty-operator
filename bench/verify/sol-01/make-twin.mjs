// Regenerates the derived halves of the sol-01 proof project so the twins can only differ in the patch:
//   src/fixed/*          = src/vulnerable/* with the two conversion helpers replaced
//   test/Fixed.t.sol     = test/Vulnerable.t.sol with the import path and the contract name swapped
// With --check nothing is written; the script exits 1 if a derived file has drifted.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes("--check");
const read = p => readFileSync(resolve(here, p), "utf8");

const BEFORE = `    function _sharesFor(uint256 assets, bool roundUp) internal view returns (uint256) {
        uint256 supply = totalSupply;
        if (supply == 0) return assets;
        return QuayMath.mulDiv(assets, supply, totalAssets(), roundUp);
    }

    function _assetsFor(uint256 shares, bool roundUp) internal view returns (uint256) {
        uint256 supply = totalSupply;
        if (supply == 0) return shares;
        return QuayMath.mulDiv(shares, totalAssets(), supply, roundUp);
    }
`;
const AFTER = `    function _sharesFor(uint256 assets, bool roundUp) internal view returns (uint256) {
        uint256 supply = totalSupply + 1_000_000;
        uint256 held = totalAssets() + 1;
        return QuayMath.mulDiv(assets, supply, held, roundUp);
    }

    function _assetsFor(uint256 shares, bool roundUp) internal view returns (uint256) {
        uint256 supply = totalSupply + 1_000_000;
        uint256 held = totalAssets() + 1;
        return QuayMath.mulDiv(shares, held, supply, roundUp);
    }
`;

function swap(text, from, to, what) {
	if (text.split(from).length !== 2) throw new Error(`${what}: expected exactly one occurrence`);
	return text.replace(from, to);
}

const outputs = {
	"src/fixed/AsterQuay.sol": swap(read("src/vulnerable/AsterQuay.sol"), BEFORE, AFTER, "conversion helpers"),
	"src/fixed/QuayTools.sol": read("src/vulnerable/QuayTools.sol"),
	"test/Fixed.t.sol": swap(
		swap(read("test/Vulnerable.t.sol"), '"../src/vulnerable/AsterQuay.sol"', '"../src/fixed/AsterQuay.sol"', "import path"),
		"contract VulnerableTest is Test {",
		"contract FixedTest is Test {",
		"contract name",
	),
};

let drift = 0;
for (const [rel, text] of Object.entries(outputs)) {
	if (text.includes("\r")) throw new Error(`${rel}: CR line ending`);
	const target = resolve(here, rel);
	if (check) {
		let actual = null;
		try { actual = readFileSync(target, "utf8"); } catch {}
		if (actual !== text) { drift++; console.error(`drift: ${rel}`); }
	} else {
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, text);
		console.log(`wrote ${rel}`);
	}
}
if (check) {
	if (drift) process.exit(1);
	console.log("derived files match (patch, import path and contract name aside)");
}
