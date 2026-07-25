---
'storyfreeze': minor
---

Generate viewport-profile hints from `parameters.screenshot.viewport` and `parameters.screenshot.viewports` so workers can keep matching emulation settings together. Balance intact viewport-profile groups across worker lanes by estimated capture cost, and balance multi-machine shards with versioned static cost hints by default. Add `--shard-strategy round-robin` for the legacy 0.2 shard assignment.
