// Benchmark metadata extension: records every provider request payload (system prompt,
// tool schemas, model id, reasoning params) to the file named by OMP_BENCH_DUMP.
import { appendFileSync } from "node:fs";

export default function benchDump(pi: any) {
	const out = process.env.OMP_BENCH_DUMP;
	if (!out) return;
	pi.on("before_provider_request", async (event: any) => {
		try {
			appendFileSync(out, `${JSON.stringify(event.payload)}\n`);
		} catch {}
	});
}
