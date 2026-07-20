---
'storyfreeze': patch
---

Restore zero-configuration Chromium startup in root-run CI containers by disabling the browser sandbox by default. Explicit `browserLaunchOptions.chromiumSandbox` values continue to take precedence, and the sandbox can be enabled for hosted Storybooks in environments that support it.
