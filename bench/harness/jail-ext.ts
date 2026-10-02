// Benchmark path jail: blocks any tool call whose path argument is not a plain
// relative path that resolves (after realpath) inside the session cwd.
import { realpathSync } from "node:fs";
import * as path from "node:path";

const ALLOWED = new Set(["read", "grep", "glob"]);

function collect(input: any): string[] {
	const out: string[] = [];
	for (const key of ["path", "paths", "pattern_path", "cwd", "dir", "glob", "patterns"]) {
		const v = input?.[key];
		if (typeof v === "string") out.push(v);
		else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") out.push(x);
	}
	return out;
}

function escapes(cwd: string, raw: string): string | null {
	const p = raw.trim();
	if (p === "") return null;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^www\./i.test(p)) return "URL or internal scheme";
	if (p.startsWith("~")) return "home-relative path";
	if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith("\\") || p.startsWith("/")) return "absolute path";
	if (p.split(/[\\/]/).includes("..")) return "parent traversal";
	// strip trailing :selector (line ranges, raw, archive members) before resolving
	const base = p.replace(/:.*$/, "").replace(/[*?[{].*$/, "");
	const root = realpathSync(cwd);
	let resolved = path.resolve(root, base);
	try {
		resolved = realpathSync(resolved);
	} catch {}
	const rel = path.relative(root.toLowerCase(), resolved.toLowerCase());
	if (rel.startsWith("..") || path.isAbsolute(rel)) return "resolves outside workspace";
	return null;
}

export default function benchJail(pi: any) {
	pi.on("tool_call", async (event: any, ctx: any) => {
		if (!ALLOWED.has(event.toolName)) {
			return { block: true, reason: `Tool ${event.toolName} is not permitted in this benchmark.` };
		}
		const cwd = ctx?.cwd ?? process.cwd();
		// path fields may carry delimited lists; check every token as well as the whole value
		const candidates = collect(event.input).flatMap(v => [v, ...v.split(/[\s,;|]+/)]);
		for (const p of candidates) {
			const why = escapes(cwd, p);
			if (why) return { block: true, reason: `Blocked by benchmark sandbox (${why}): only relative paths inside the workspace are readable.` };
		}
	});
}
