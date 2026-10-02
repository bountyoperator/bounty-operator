## Answer sheet

End your final message with exactly one fenced `json` block in this shape, with nothing after it:

```json
{"findings":[{"file":"","function":"","line_start":0,"line_end":0,"severity":"critical|high|medium|low|info|unrated","claim":""}],"rejected":[{"quote":""}],"verdict":"supported|overclaimed|unsupported|n/a","max_severity":"critical|high|medium|low|info|unrated"}
```

- `findings`: the security issues in the code that you stand behind, most important first. Only the first 8 are read. One issue per entry. `file` is the workspace-relative path. `function` is the one function, modifier or handler where the fault is. `line_start` and `line_end` are the 1-based lines of the faulty code; a range longer than 40 lines is ignored. `severity` is your rating of the impact; use `unrated` only when you cannot rate it. `claim` says in one or two sentences what goes wrong and who loses what. Use `[]` when you find nothing worth reporting. Leave out style notes and things you checked and found safe.
- `rejected`, `verdict` and `max_severity` apply when the workspace contains `draft-report.md`, a draft bug report about the code. `verdict` is `supported` when the code backs the draft's claims and severity as written, `overclaimed` when the issue is real but the draft overstates its impact, severity or reach, and `unsupported` when the code does not back the draft's central claim. `rejected` lists each statement in the draft that the code does not support, as a `quote` of one sentence or less copied word for word from the draft. `max_severity` is the highest severity the code actually supports for the reported issue.
- When there is no `draft-report.md`, set `"rejected": []` and `"verdict": "n/a"`, and set `max_severity` to the highest severity among your findings (`unrated` when there are none).
