# React/Vite compatibility fixture

This is StoryFreeze's React/Vite fixture. It targets the supported Storybook 10
line and is installed as part of the repository's pnpm workspace.

The `.storybook-simple` config represents simple mode and also proves that
Storybook 10 can build the stories without the StoryFreeze addon. The default
config represents managed mode. The E2E harness deploys the fixture to a temporary
directory, installs the locally packed StoryFreeze tarball there, and exercises it
with `pnpm run test:storybook10-e2e`.

The E2E gate builds the simple and managed static Storybooks once, then reuses the
managed preview server for the managed, filtering, sharding, and retry captures.
The simple capture retains an owned preview server to verify clean server
shutdown. The gate also verifies render/play and afterEach completion, variants,
viewports, retry behavior, and the expected PNG paths and dimensions. Storybook
loads the packaged preview annotations automatically from the addon entry.

The fixture covers a docs entry, asynchronous rendering, local font and image
assets, a play function, screenshot parameters, viewports, variants, pointer
interactions, console warning/error forwarding, and a managed capture that times
out once before succeeding on retry.
