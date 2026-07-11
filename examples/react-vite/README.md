# React/Vite compatibility fixture

This is StoryFreeze's React/Vite fixture. It targets the supported Storybook 10
line and deliberately uses npm because Storybook 10 does not support the
repository's current Yarn 1 toolchain.

The `.storybook-simple` config represents simple mode and also proves that
Storybook 10 can build the stories without the StoryFreeze addon. The default
config represents managed mode, enables the locally built StoryFreeze package,
and is exercised by `npm run test:known-failure`.

The current compatibility boundary is managed-mode detection. Storybook and
StoryFreeze complete the capture, but the managed config is detected as simple
mode because the Storybook 10 addon entry is not packaged yet. The xfail runner
rejects command failures, missing PNGs, and any unexpected diagnostic, and must
be updated as compatibility work advances to the next stage.

The fixture covers a docs entry, asynchronous rendering, local font and image
assets, a play function, screenshot parameters, viewports, variants, pointer
interactions, and console warning/error forwarding.
