# React/Vite compatibility fixture

This is StoryFreeze's React/Vite fixture. It targets the supported Storybook 10
line and deliberately uses npm because Storybook 10 does not support the
repository's current Yarn 1 toolchain.

The `.storybook-simple` config represents simple mode and also proves that
Storybook 10 can build the stories without the StoryFreeze addon. The default
config represents managed mode, enables the locally built StoryFreeze package,
and is exercised by `npm run test:preview-protocol`.

The preview protocol runner verifies simple and managed mode detection and,
for managed mode, render/play and afterEach completion, variants and viewports.
It also verifies exact expected PNG paths and clean server shutdown. Visual
content gating and static capture remain part of the later E2E gate. The preview
annotations are imported manually until addon packaging loads them automatically.

The fixture covers a docs entry, asynchronous rendering, local font and image
assets, a play function, screenshot parameters, viewports, variants, pointer
interactions, and console warning/error forwarding.
