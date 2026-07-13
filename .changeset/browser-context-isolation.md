---
'storyfreeze': minor
---

Add opt-in Playwright browser-context isolation for parallel capture workers while keeping process isolation as the default. Reuse each worker's isolated context across viewport and device-emulation changes, while replacing it for retries and unhealthy recovery.
