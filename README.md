# StoryFreeze

> [!IMPORTANT]
> StoryFreeze is an independent project based on
> [huuyafwww/storycapture](https://github.com/huuyafwww/storycapture), which was
> originally forked from [reg-viz/storycap](https://github.com/reg-viz/storycap).
> It is not an official successor to either project.

StoryFreeze captures Storybook 10 stories with Playwright while preserving the
established Storycapture output contract where it remains applicable. The
package and CLI use the `storyfreeze` name and require Node.js 22 or newer.

[storybook]: https://github.com/storybooks/storybook
[playwright]: https://playwright.dev/

The base package was created to support v9 of storybook with [storycap](https://github.com/reg-viz/storycap).
Special thanks to the author of the [storycap](https://github.com/reg-viz/storycap).

[![npm](https://img.shields.io/npm/v/storyfreeze.svg?style=flat-square)](https://www.npmjs.com/package/storyfreeze)

> A [Storybook][storybook] Addon, Save the screenshot image of your stories :camera: via Chromium.

StoryFreeze crawls your Storybook and takes screenshot images.
It is primarily responsible for image generation necessary for Visual Testing such as [reg-suit](https://github.com/reg-viz/reg-suit).

<!-- toc -->

- [Features](#features)
- [Install](#install)
- [Getting Started](#getting-started)
  - [Setup Storybook](#setup-storybook)
  - [Setup your stories(optional)](#setup-your-storiesoptional)
  - [Run `storyfreeze` Command](#run-storyfreeze-command)
- [API](#api)
  - [`withScreenshot`](#withscreenshot)
  - [type `ScreenshotOptions`](#type-screenshotoptions)
  - [type `Variants`](#type-variants)
  - [Supporting option types](#supporting-option-types)
  - [type `Viewport`](#type-viewport)
  - [function `isScreenshot`](#function-isscreenshot)
- [Command Line Options](#command-line-options)
- [Multiple PNGs from 1 story](#multiple-pngs-from-1-story)
  - [Basic usage](#basic-usage)
  - [Variants composition](#variants-composition)
  - [Persistent Preview capture sessions](#persistent-preview-capture-sessions)
  - [Parallelisation across multiple computers](#parallelisation-across-multiple-computers)
- [Tips](#tips)
  - [Run with Docker](#run-with-docker)
  - [Full control the screenshot timing](#full-control-the-screenshot-timing)
    - [Example 1](#example-1)
    - [Example 2](#example-2)
- [Chromium version](#chromium-version)
- [Storybook compatibility](#storybook-compatibility)
  - [Storybook versions](#storybook-versions)
  - [UI frameworks](#ui-frameworks)
- [How it works](#how-it-works)
- [Contributing](#contributing)
- [License](#license)

<!-- tocstop -->

## Features

- :camera: Take screenshots of each story via [Playwright][playwright].
- :zap: Persistent Preview capture with parallel workers and sharding.
- :package: Fail-fast validation through the StoryFreeze addon.
- :rocket: Provide flexible screenshot shooting options.
- :tada: Framework-neutral preview and capture protocol.

## Install

StoryFreeze requires Node.js 22 or newer and Storybook 10. The package is
ESM-only: use `import` or dynamic `import()`. CommonJS `require('storyfreeze')`
is not supported.

```sh
$ npm install storyfreeze
$ npx playwright-core@1.61.1 install chromium
```

Browser installation is explicit; installing StoryFreeze does not automatically download Playwright Chromium. See [Chromium version](#chromium-version) for browser discovery details.

## Getting Started

StoryFreeze captures a static or hosted Storybook 10 that has the StoryFreeze
addon installed. Build and serve Storybook before starting the CLI:

```sh
$ storybook build -o storybook-static
$ npx vite preview --outDir storybook-static --port 9001
$ npx storyfreeze http://localhost:9001
```

The static server must preserve the query string on `iframe.html`. If you use
`serve`, disable its clean URL redirects:

```json
{
  "cleanUrls": false
}
```

StoryFreeze stops before capturing when a redirect removes the story or request
query parameters.

StoryFreeze can also crawl an already hosted Storybook:

```sh
$ storyfreeze https://next--storybookjs.netlify.app/vue-kitchen-sink/
```

### Setup Storybook

First, add `storyfreeze` to your Storybook config file:

```js
/* .storybook/main.js */

module.exports = {
  stories: ['../src/**/*.stories.@(js|mdx)'],
  addons: [
    '@storybook/addon-actions',
    '@storybook/addon-links',
    'storyfreeze', // <-- Add storyfreeze
  ],
};
```

The addon automatically registers StoryFreeze's preview hooks. Configure capture
behavior with the `screenshot` parameter; do not register the decorator manually.

For Storybook viewport globals, the addon also adds a namespaced viewport-key tag
to `index.json` when the value can be determined statically. StoryFreeze uses the
tag only as a scheduling hint so stories that select the same viewport stay on
adjacent workers; the preview runtime remains authoritative for the actual width,
height, and device settings.

After runtime discovery, width, height, and orientation changes are applied to the
current page and settled before capture. Mobile, touch, and device-scale changes
keep the fresh-navigation boundary.

Direct literals and local object spreads are supported:

```js
const desktop = { globals: { viewport: { value: 'desktop' } } };

export const Account_PC = {
  ...desktop,
};
```

Imported helpers, function results, and other dynamic values are not guessed and
continue through runtime viewport discovery.

```js
/* .storybook/preview.js */

export const parameters = {
  // Global parameter is optional.
  screenshot: {
    // Put global screenshot parameters(e.g. viewport)
  },
};
```

> [!NOTE]
> You can set configuration of screenshot with `addParameters` and `screenshot` key.

#### Setup your stories(optional)

And you can overwrite the global screenshot options in specific stories file via `parameters`.

```js
import React from 'react';
import MyComponent from './MyComponent';

export default {
  title: 'MyComponent',
  component: MyComponent,
  parameters: {
    screenshot: {
      delay: 200,
    },
  },
};

export const Normal = {};

export const Small = {
  args: {
    text: 'small',
  },
  parameters: {
    screenshot: {
      viewport: 'iPhone 5',
    },
  },
};
```

#### Run `storyfreeze` Command

```sh
$ npx start-storybook -p 9009
$ npx storyfreeze http://localhost:9009
```

## API

### `withScreenshot`

The Storybook decorator used by the addon to notify StoryFreeze. Storybook 10
loads it automatically from `storyfreeze/preview`; applications should configure
`parameters.screenshot` instead of registering this decorator manually.

### type `ScreenshotOptions`

`ScreenshotOptions` is available as the value of the `screenshot` parameter.

```ts
interface ScreenshotOptions {
  delay?: number; // default 0 msec
  waitAssets?: boolean; // default true
  waitFor?: string | (() => Promise<unknown>); // default ""
  fullPage?: boolean; // default true
  hover?: string; // default ""
  focus?: string; // default ""
  click?: string; // default ""
  skip?: boolean; // default false
  viewport?: Viewport | string;
  viewports?: string[] | { [variantName]: Viewport | string };
  variants?: Variants;
  defaultVariantSuffix?: string;
  reset?: (context: StorySessionResetContext) => void | Promise<void>;
  waitImages?: boolean; // default true
  omitBackground?: boolean; // default false
  captureBeyondViewport?: boolean; // default true
  clip?: { x: number; y: number; width: number; height: number } | null; // default null
}
```

- `delay`: Waiting time [msec] before capturing.
- `waitAssets`: If set true, StoryFreeze waits until all resources requested by the story, such as `<img>` or CSS background images, are finished.
- `waitFor` : If you set a function to return `Promise`, StoryFreeze waits the promise is resolved. You can also set a name of global function that returns `Promise`.
- `fullPage`: If set true, StoryFreeze captures the entire page of stories.
- `focus`: If set a valid CSS selector string, StoryFreeze captures after focusing the element matched by the selector.
- `hover`: If set a valid CSS selector string, StoryFreeze captures after hovering the element matched by the selector.
- `click`: If set a valid CSS selector string, StoryFreeze captures after clicking the element matched by the selector.
- `skip`: If set true, StoryFreeze cancels capturing corresponding stories.
- `viewport`, `viewports`: See type `Viewport` section below.
- `variants`: See type `Variants` section below.
- `defaultVariantSuffix`: If set, StoryFreeze appends this suffix to the default capture filename.
- `reset`: Runs after each non-default variant capture. A rejected callback fails that capture; StoryFreeze remounts the story before the next variant.
- `waitImages`: Deprecated. Use `waitAssets`. If set true, StoryFreeze waits until `<img>` in the story are loaded.
- `omitBackground`: If set true, StoryFreeze omits the background of the page allowing for transparent screenshots. Note the storybook theme will need to be transparent as well.
- `captureBeyondViewport`: If set true, StoryFreeze captures beyond the viewport through the Chromium screenshot protocol. The default is true for the Playwright Chromium runtime.
- `clip`: If set, StoryFreeze captures only the portion of the screen bounded by x/y/width/height.

### type `Variants`

`Variants` is used to generate [multiple PNGs from 1 story](#multiple-pngs-from-1-story).

```ts
type Variants = {
  [variantName: string]: {
    extends?: string | string[]; // default: ""
    delay?: number;
    waitAssets?: boolean;
    waitFor?: string | (() => Promise<unknown>);
    fullPage?: boolean;
    hover?: string;
    focus?: string;
    click?: string;
    skip?: boolean;
    viewport?: Viewport | string;
    waitImages?: boolean;
    omitBackground?: boolean;
    captureBeyondViewport?: boolean;
    clip?: { x: number; y: number; width: number; height: number } | null;
  };
};
```

- `extends`: If set other variant's name(or an array of names of them), this variant extends the other variant options. And this variant generates a PNG file with suffix such as `_${parentVariantName}_${thisVariantName}`.

### Supporting option types

The package root also exports `ScreenshotOptionFragments`,
`ScreenshotOptionFragmentsForVariant`, and `StorySessionResetContext` for typed
configuration helpers. The fragment types contain the shared fields shown
above. The reset context identifies the active story and variant:

```ts
interface StorySessionResetContext {
  storyId: string;
  variantId: string;
}
```

### type `Viewport`

`Viewport` is StoryFreeze's browser-neutral Chromium viewport interface.

```ts
type Viewport = {
  width: number; // default: 800
  height: number; // default: 600
  deviceScaleFactor?: number; // default: 1
  isMobile?: boolean; // default: false
  hasTouch?: boolean; // default: false
  isLandscape?: boolean; // default: false
};
```

> [!NOTE]
> The `viewport` and `viewports` fields also accept the fixed Chromium device names documented by StoryFreeze, such as `iPad` and `iPhone 5`.
>
> When a story sets neither `viewport` nor `viewports`, StoryFreeze resolves a viewport from Storybook's viewport addon globals instead, using `globals.viewport` (or `storyGlobals.viewport`) together with the matching entry in `parameters.viewport.options`. The resolution order is: explicit `parameters.screenshot.viewport` (or `viewports`) > Storybook viewport globals > the CLI's `--viewport` default. Only a single viewport is injected this way, so it never adds a filename suffix.

`Viewport` values are available in `viewports` field such as:

```js
addParameters({
  screenshot: {
    viewports: {
      large: {
        width: 1024,
        height: 768,
      },
      small: {
        width: 375,
        height: 668,
      },
      xsmall: {
        width: 320,
        height: 568,
      },
    },
  },
});
```

### function `isScreenshot`

```typescript
function isScreenshot(): boolean;
```

Returns whether current process runs in StoryFreeze browser. It's useful to change your stories' behavior only in StoryFreeze (e.g. disable JavaScript animation).

## Command Line Options

<!-- inject:clihelp -->
```txt
storyfreeze (storyfreeze v0.2.0-rc.3)
USAGE:
  storyfreeze <OPTIONS> [<storybook-url>]

ARGUMENTS:
  storybook-url           Storybook URL.

OPTIONS:
  -h, --help                                                   Display this help message
  -v, --version                                                Display this version
  -o, --out-dir [out-dir]                                      Output directory. (default: __screenshots__)
  -p, --parallel [parallel]                                    Maximum number of capture workers. (default: 4)
  -f, --flat                                                   Flatten output filename. (default: false)
  -i, --include <include>                                      Including stories name rule.
  -e, --exclude <exclude>                                      Excluding stories name rule.
  --delay <delay>                                              Waiting time [msec] before screenshot for each story. (default: 0)
  -V, --viewport <viewport>                                    Viewport. (default: 800x600)
  --disable-css-animation                                      Disable CSS animation and transition. (default: true)
  --no-disable-css-animation                                   Negatable of --disable-css-animation
  --disable-wait-assets                                        Disable waiting for requested assets. (default: false)
  --silent                                                     Suppress StoryFreeze output. (default: false)
  --verbose                                                    Enable verbose StoryFreeze output. (default: false)
  --forward-console-logs                                       Forward in-page console logs to the user's console. (default: false)
  --shard [shard]                                              The sharding options for this run. In the format <shardNumber>/<totalShards>. <shardNumber> is a number between 1 and <totalShards>. <totalShards> is the total number of computers working. (default: 1/1)
  --capture-timeout [capture-timeout]                          Timeout [msec] for capturing a story. (default: 5000)
  --capture-max-retry-count [capture-max-retry-count]          Number of times to retry capture. (default: 3)
  -C, --chromium-channel [chromium-channel]                    Channel to search local Chromium. (default: *, choices: canary | stable | *)
  --chromium-path <chromium-path>                              Executable Chromium path. (default: )
  --browser-launch-options <browser-launch-options>            JSON string of browser launch options. (default: {"chromiumSandbox":false})

EXAMPLES:
  storyfreeze http://localhost:9009
  storyfreeze http://localhost:9009 -V 1024x768 -V 320x568
  storyfreeze http://localhost:9009 -i "some-kind/a-story"
  storyfreeze http://example.com/your-storybook -e "**/default" -V iPad
```
<!-- endinject -->

## Multiple PNGs from 1 story

By default, storyfreeze generates 1 screenshot image from 1 story. Use `variants` if you want multiple PNGs(e.g. viewports, element's states variation, etc...) for 1 story.

### Basic usage

For example:

```js
import React from 'react';
import MyButton from './MyButton';

export default {
  title: 'MyButton',
  component: MyButton,
};

export const Normal = {
  parameters: {
    screenshot: {
      variants: {
        hovered: {
          hover: 'button.my-button',
        },
      },
    },
  },
};
```

The above configuration generates 2 PNGs:

- `MyButton/normal.png`
- `MyButton/normal_hovered.png`

The variant key, `hovered` in the above example, is used as suffix of the generated PNG file name. And the almost all `ScreenshotOptions` fields are available as fields of variant value.

**Note:** `variants` itself and `viewports` are prohibited as variant's field.

### Variants composition

You can composite multiple variants via `extends` field.

```js
export const Normal = {
  parameters: {
    screenshot: {
      variants: {
        small: {
          viewport: 'iPhone 5',
        },
        hovered: {
          extends: 'small',
          hover: 'button.my-button',
        },
      },
    },
  },
};
```

The above example generates the following:

- `MyButton/normal.png` (default
- `MyButton/normal_small.png` (derived from the `small` variant
- `MyButton/normal_hovered.png` (derived from the `hovered` variant
- `MyButton/normal_small_hovered.png` (derived from the `hovered` and `small` variant

> [!NOTE]
> You can extend some viewports with keys of `viewports` option because the `viewports` field is expanded to variants internally.

### Persistent Preview capture sessions

Each capture worker opens the managed Preview once, switches stories through
Storybook's event channel, and keeps request and story state correlated inside
that page:

```sh
$ npx storyfreeze http://localhost:9009
```

The addon and managed Preview protocol are required. A missing or incompatible
addon is an error and never falls back to capturing an unverified page.

Width and height changes use a live viewport update. Crossing a mobile, touch, or
DPR boundary recreates the worker context and remounts the story. Every variant
is rendered through Storybook's remount boundary. A failed worker context is
closed before its capture enters the existing retry path, and terminal failure
stops new queue assignments.

Each process-isolated worker recycles its context after 128 captures or after a
session fault. This safety boundary is intentionally not configurable.

Applications may also use a reset hook to clean up timers, listeners, or other
state they own after a non-default variant:

```js
export const Toggle = {
  parameters: {
    screenshot: {
      variants: {
        clicked: { click: 'button' },
      },
      reset: async ({ storyId, variantId }) => {
        // Restore component-owned state to the state after Storybook play completed.
      },
    },
  },
};
```

The reset hook must settle within the capture timeout. A rejected hook is a
capture failure. StoryFreeze uses a Storybook remount for component state
isolation; the hook remains useful for application-owned state outside that
render lifecycle.

### Parallelisation across multiple computers

To process more stories in parallel across multiple computers, the `shard` argument can be used.

The `shard` argument is a string of the format: `<shardNumber>/<totalShards>`. `<shardNumber>` is a number between 1 and `<totalShards>`, inclusive. `<totalShards>` is the total number of computers running the execution.

For example, a run with `--shard 1/1` would be considered the default behaviour on a single computer. Two computers each running `--shard 1/2` and `--shard 2/2` respectively would split the stories across two computers.

Stories are distributed across shards in a round robin fashion when ordered by their ID. If a series of stories 'close together' are slower to screenshot than others, they should be distributed evenly.

## Tips

### Run with Docker

Use [regviz/node-xcb](https://cloud.docker.com/u/regviz/repository/docker/regviz/node-xcb).

Or create your Docker base image such as:

```text
FROM node:22

RUN apt-get update -y \
    && apt-get install -yq \
    ca-certificates \
    fonts-liberation \
    git \
    libayatana-appindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils
```

### Full control the screenshot timing

Sometimes you may want to full-manage the timing of performing screenshot.
Use the `waitFor` option if you think so. This parameter accepts function returning `Promise` or name of function should points a global function to return `Promise`.

#### Example 1

For example, you can wait for specific HTML elements appearance with `screen` function provided `@storybook/test` package. It's useful when the elements are rendered lazy.

```js
/* MyComponent.stories.js */

import { screen } from '@storybook/test';

export const MyStory = {
  screenshot: {
    waitFor: async () => {
      await screen.findByRole('link');
    },
  },
};
```

#### Example 2

Another example, the following setting tells storyfreeze to wait for resolving of `fontLoading`:

```html
<!-- ./storybook/preview-head.html -->
<link rel="preload" href="/some-heavy-asset.woff" as="font" onload="this.setAttribute('loaded', 'loaded')" />
<script>
  function fontLoading() {
    const loaded = () => !!document.querySelector('link[rel="preload"][loaded="loaded"]');
    if (loaded()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const id = setInterval(() => {
        if (!loaded()) return;
        clearInterval(id);
        resolve();
      }, 50);
    });
  }
</script>
```

```js
/* .storybook/preview.js */

export const parameters = {
  screenshot: {
    waitFor: 'fontLoading',
  },
};
```

## Chromium version

StoryFreeze uses Playwright. Install the Chromium revision matched to StoryFreeze's `playwright-core` dependency:

```sh
$ npx playwright-core@1.61.1 install chromium
$ npx storyfreeze http://localhost:9009
```

Browser installation is explicit; installing StoryFreeze does not automatically download Playwright Chromium.

StoryFreeze resolves an explicit `--chromium-path` or `--chromium-channel` first. Without either override, it searches Chromium in the following order:

1. The explicitly installed Playwright Chromium revision
1. Canary Chrome installed locally
1. Stable Chrome installed locally

You can change search channel with `--chromium-channel` option or set executable Chromium file path with `--chromium-path` option.

Use `--browser-launch-options '<json>'` for Playwright Chromium launch options.
An explicit `--chromium-path` takes precedence over `executablePath` in the
JSON.

StoryFreeze is intended to capture Storybooks that you control and trust.
Chromium's sandbox is disabled by default so the CLI works in root-run and
restricted CI containers without additional configuration. Do not use this
default to capture an untrusted Storybook.

Enable the Chromium sandbox explicitly when the execution environment supports
it, especially when capturing a hosted Storybook:

```sh
$ npx storyfreeze --browser-launch-options '{"chromiumSandbox":true}' https://storybook.example.com
```

Sandboxed Chromium generally needs to run as a non-root user in Linux
containers. StoryFreeze does not add `--disable-dev-shm-usage` by default; add
container-specific launch arguments only when that environment requires them.

Capture workers use separate browser processes. `--parallel` controls the
maximum worker count and defaults to four; StoryFreeze never increases it
automatically.

## Storybook compatibility

### Storybook versions

The package peer range is Storybook `^10.0.0`. The release gate uses the current
Storybook 10 React/Vite fixture for complete managed static E2E. The
packed preset is also load-checked with Storybook 10.0 and 10.4 so the viewport
indexer fallback remains compatible with releases that do not export
`STORY_FILE_TEST_REGEXP`.

- Managed mode:
  - [x] Storybook 10.x

See also packages in `examples` directory.

### UI frameworks

The addon integration is UI-framework neutral. React + Vite is the blocking
release fixture; other Storybook 10 framework integrations are supported by the
same preview protocol but are not separate release-gate fixtures.

## How it works

StoryFreeze accesses the launched page using [Playwright][playwright]. It supports process, context, hybrid, and statically selected auto worker topologies.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT © huuyafwww](./LICENSE)
