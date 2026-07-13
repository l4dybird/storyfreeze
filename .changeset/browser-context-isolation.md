---
'storyfreeze': minor
---

Add opt-in Playwright browser-context isolation for parallel capture workers while keeping process isolation as the default. Reuse each worker's isolated context across viewport and device-emulation changes, while replacing it for retries and unhealthy recovery. Default the legacy fixed viewport delay to zero now that resource, metrics, and visual-commit waits provide explicit render-stability checks; users can still request an additional delay with `--viewport-delay`.
