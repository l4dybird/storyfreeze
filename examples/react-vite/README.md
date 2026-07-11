# React/Vite compatibility fixture

This is StoryFreeze's React/Vite fixture. It targets the supported Storybook 10
line and deliberately uses npm because Storybook 10 does not support the
repository's current Yarn 1 toolchain.

The `.storybook-simple` config represents simple mode and also proves that
Storybook 10 can build the stories without the StoryFreeze addon. The default
config represents managed mode, installs the locally packed StoryFreeze tarball,
and is exercised by `npm run test:storybook10-e2e`.

The E2E gate runs simple and managed modes against both development and static
servers. It verifies render/play and afterEach completion, filtering, sharding,
variants, viewports, retry behavior, expected PNG paths and dimensions, and clean
server shutdown. Storybook loads the packaged preview annotations automatically
from the addon entry.

The fixture covers a docs entry, asynchronous rendering, local font and image
assets, a play function, screenshot parameters, viewports, variants, pointer
interactions, console warning/error forwarding, and a managed capture that times
out once before succeeding on retry.
