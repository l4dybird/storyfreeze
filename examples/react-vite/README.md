# React/Vite compatibility fixture

This is StoryFreeze's React/Vite fixture. It targets the supported Storybook 10
line and deliberately uses npm because Storybook 10 does not support the
repository's current Yarn 1 toolchain.

The `.storybook-simple` config represents simple mode and also proves that
Storybook 10 can build the stories without the StoryFreeze addon. The default
config represents managed mode, enables the locally built StoryFreeze package,
and is exercised by `npm run test:known-failure`.

The expected failure is `SB_CORE-SERVER_0002` with `ERR_MODULE_NOT_FOUND` for
`storyfreeze/lib-esm/client/with-screenshot`. The xfail runner rejects any
other failure and must be updated as compatibility work advances the failure
to a later stage.

The fixture covers a docs entry, asynchronous rendering, local font and image
assets, a play function, screenshot parameters, viewports, variants, pointer
interactions, and console warning/error forwarding.
