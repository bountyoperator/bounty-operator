# Report Editor Prompt

Edit the report so it reads like a human security researcher wrote it.

Keep:

- root cause
- affected code and commit
- exact attack path
- PoC command and output
- impact
- fix

Remove:

- private platform URLs
- local machine paths
- internal notes
- tool bragging
- unsupported certainty
- generic filler
- claims not proven by the PoC

Style:

- direct
- short paragraphs
- concrete nouns
- no hype
- no broad claims
- no hidden assumptions

Output:

1. cleaned report
2. list of removed risky claims
3. questions that still need evidence
