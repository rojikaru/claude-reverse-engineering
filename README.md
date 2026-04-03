# claude-reverse-engineering

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

The pipeline now writes page-level checkpoint state to `page_states.json`, harvested IDs to `graph-api.jsonl`, and final results to `ads.jsonl`.

This project was created using `bun init` in bun v1.3.10. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
