# StoryFreeze

> [!IMPORTANT]
> StoryFreeze is an independent project based on
> [huuyafwww/storycapture](https://github.com/huuyafwww/storycapture), which was
> originally forked from [reg-viz/storycap](https://github.com/reg-viz/storycap).
> It is not an official successor to either project.

StoryFreeze currently preserves the behavior of the Storycapture 9 baseline
while it is being migrated to Storybook 10. The package and CLI use the
`storyfreeze` name.

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
  - [Managed mode](#managed-mode)
    - [Setup Storybook](#setup-storybook)
    - [Setup your stories(optional)](#setup-your-storiesoptional)
    - [Run `storyfreeze` Command](#run-storyfreeze-command)
- [API](#api)
  - [`withScreenshot`](#withscreenshot)
  - [type `ScreenshotOptions`](#type-screenshotoptions)
  - [type `Variants`](#type-variants)
  - [type `Viewport`](#type-viewport)
  - [function `isScreenshot`](#function-isscreenshot)
- [Command Line Options](#command-line-options)
- [Multiple PNGs from 1 story](#multiple-pngs-from-1-story)
  - [Basic usage](#basic-usage)
  - [Variants composition](#variants-composition)
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
- :zap: Extremely fast.
- :package: Zero configuration.
- :rocket: Provide flexible screenshot shooting options.
- :tada: Independent of any UI framework(React, Angular, Vue, etc...)

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

StoryFreeze runs with 2 modes. One is "simple" and another is "managed".
The default `--mode auto` detects the StoryFreeze preview marker. Use
`--mode managed` in CI when the addon is required, so a missing or incompatible
addon fails the run instead of falling back to simple mode. `--mode simple`
explicitly disables addon detection.

With the simple mode, you don't need to configure your Storybook. All you need is give Storybook's URL, such as:

```sh
$ npx storyfreeze http://localhost:9001
```

You can launch your server via `--server-cmd` option.

```sh
$ storyfreeze --server-cmd "start-storybook -p 9001" http://localhost:9001
```

Of course, you can use pre-built Storybook:

```sh
$ build-storybook -o dist-storybook
$ storyfreeze --server-cmd "npx http-server dist-storybook -p 9001" http://localhost:9001
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

Also, StoryFreeze can crawls built and hosted Storybook pages:

```sh
$ storyfreeze https://next--storybookjs.netlify.app/vue-kitchen-sink/
```

### Managed mode

#### Setup Storybook

If you want to control how stories are captured (timing or size or etc...), use managed mode.

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

Or you can exec with one-liner via `--server-cmd` option:

```sh
$ npx storyfreeze http://localhost:9009 --server-cmd "start-storybook -p 9009"
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
  delay?: number;                           // default 0 msec
  waitAssets?: boolean;                     // default true
  waitFor?: string | () => Promise<void>;   // default ""
  fullPage?: boolean;                       // default true
  hover?: string;                           // default ""
  focus?: string;                           // default ""
  click?: string;                           // default ""
  skip?: boolean;                           // default false
  viewport?: Viewport;
  viewports?: string[] | { [variantName]: Viewport };
  variants?: Variants;
  waitImages?: boolean;                     // default true
  omitBackground?: boolean;                 // default false
  captureBeyondViewport?: boolean;          // default true
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
- `waitImages`: Deprecated. Use `waitAssets`. If set true, StoryFreeze waits until `<img>` in the story are loaded.
- `omitBackground`: If set true, StoryFreeze omits the background of the page allowing for transparent screenshots. Note the storybook theme will need to be transparent as well.
- `captureBeyondViewport`: If set true, StoryFreeze captures beyond the viewport through the Chromium screenshot protocol. The default is true for both browser backends.
- `clip`: If set, StoryFreeze captures only the portion of the screen bounded by x/y/width/height.

### type `Variants`

`Variants` is used to generate [multiple PNGs from 1 story](#multiple-pngs-from-1-story).

```ts
type Variants = {
  [variantName: string]: {
    extends?: string | string[]; // default: ""
    delay?: number;
    waitAssets?: boolean;
    waitFor?: string | () => Promise<void>;
    fullPage?: boolean;
    hover?: string;
    focus?: string;
    click?: string;
    skip?: boolean;
    viewport?: Viewport;
    waitImages?: boolean;
    omitBackground?: boolean;
    captureBeyondViewport?: boolean;
    clip?: { x: number; y: number; width: number; height: number } | null;
  };
};
```

- `extends`: If set other variant's name(or an array of names of them), this variant extends the other variant options. And this variant generates a PNG file with suffix such as `_${parentVariantName}_${thisVariantName}`.

### type `Viewport`

`Viewport` is StoryFreeze's browser-neutral Chromium viewport interface.

```ts
type Viewport =
  | string
  | {
      width: number; // default: 800
      height: number; // default: 600
      deviceScaleFactor: ?number; // default: 1,
      isMobile?: boolean; // default: false,
      hasTouch?: boolean; // default: false,
      isLandscape?: boolean; // default: false,
    };
```

> [!NOTE]
> Use a device name printed by `storyfreeze --list-devices` when setting a string. StoryFreeze keeps the same fixed registry for both browser backends.

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
storyfreeze (storyfreeze v0.2.0-alpha.0)
USAGE:
  storyfreeze <OPTIONS> [<storybook-url>]

ARGUMENTS:
  storybook-url           Storybook URL.

OPTIONS:
  -h, --help                                                       Display this help message
  -v, --version                                                    Display this version
  -o, --out-dir [out-dir]                                          Output directory. (default: __screenshots__)
  -p, --parallel [parallel]                                        Number of browsers to screenshot. (default: 4)
  --mode [mode]                                                    Preview mode. Use managed in CI to require the StoryFreeze addon. (default: auto, choices: auto | managed | simple)
  -f, --flat                                                       Flatten output filename. (default: false)
  -i, --include <include>                                          Including stories name rule.
  -e, --exclude <exclude>                                          Excluding stories name rule.
  --delay <delay>                                                  Waiting time [msec] before screenshot for each story. (default: 0)
  -V, --viewport <viewport>                                        Viewport. (default: 800x600)
  --disable-css-animation                                          Disable CSS animation and transition. (default: true)
  --no-disable-css-animation                                       Negatable of --disable-css-animation
  --disable-wait-assets                                            Disable waiting for requested assets. (default: false)
  --trace                                                          Emit Chromium trace files per screenshot. (default: false)
  --silent                                                         Suppress StoryFreeze output. (default: false)
  --verbose                                                        Enable verbose StoryFreeze output. (default: false)
  --forward-console-logs                                           Forward in-page console logs to the user's console. (default: false)
  --server-cmd <server-cmd>                                        Command line to launch Storybook server. (default: )
  --server-timeout [server-timeout]                                Timeout [msec] for starting Storybook server. (default: 60000)
  --shard [shard]                                                  The sharding options for this run. In the format <shardNumber>/<totalShards>. <shardNumber> is a number between 1 and <totalShards>. <totalShards> is the total number of computers working. (default: 1/1)
  --capture-timeout [capture-timeout]                              Timeout [msec] for capturing a story. (default: 5000)
  --capture-max-retry-count [capture-max-retry-count]              Number of times to retry capture. (default: 3)
  --metrics-watch-retry-count [metrics-watch-retry-count]          Number of times to retry until browser metrics are stable. (default: 1000)
  --viewport-delay <viewport-delay>                                Delay time [msec] between changing viewport and capturing. (default: 0)
  --reload-after-change-viewport                                   Whether to reload after viewport changed. (default: false)
  --state-change-delay <state-change-delay>                        Delay time [msec] after changing element's state. (default: 0)
  --list-devices                                                   List available device descriptors. (default: false)
  -C, --chromium-channel [chromium-channel]                        Channel to search local Chromium. (default: *, choices: canary | stable | *)
  --chromium-path <chromium-path>                                  Executable Chromium path. (default: )
  --browser-isolation [browser-isolation]                          Browser isolation mode for capture workers. (default: process, choices: process | context)
  --browser-launch-options <browser-launch-options>                JSON string of browser launch options. (default: {})

EXAMPLES:
  storyfreeze http://localhost:9009
  storyfreeze http://localhost:9009 -V 1024x768 -V 320x568
  storyfreeze http://localhost:9009 -i "some-kind/a-story"
  storyfreeze http://example.com/your-storybook -e "**/default" -V iPad
  storyfreeze --server-cmd "start-storybook -p 3000" http://localhost:3000
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

### Parallelisation across multiple computers

To process more stories in parallel across multiple computers, the `shard` argument can be used.

The `shard` argument is a string of the format: `<shardNumber>/<totalShards>`. `<shardNumber>` is a number between 1 and `<totalShards>`, inclusive. `<totalShards>` is the total number of computers running the execution.

For example, a run with `--shard 1/1` would be considered the default behaviour on a single computer. Two computers each running `--shard 1/2` and `--shard 2/2` respectively would split the stories across two computers.

Stories are distributed across shards in a round robin fashion when ordered by their ID. If a series of stories 'close together' are slower to screenshot than others, they should be distributed evenly.

## Tips

### Run with Docker

Use [regviz/node-xcb](https://cloud.docker.com/u/regviz/repository/docker/regviz/node-xcb).

Or create your Docker base image such as:

```Dockerfile
FROM node:18

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

Use `--browser-launch-options '<json>'` for browser launch arguments. `args`, `headless`, and `executablePath` are supported. An explicit `--chromium-path` takes precedence over `executablePath` in the JSON.

Chromium's sandbox is enabled by default, including when capturing a hosted Storybook. If a restricted container cannot start Chromium with its sandbox enabled, opt out explicitly for that trusted environment:

```sh
$ npx storyfreeze --browser-launch-options '{"args":["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]}' http://localhost:9009
```

Capture workers use separate browser processes by default. You can opt into one isolated browser context per worker with `--browser-isolation context`; this can reduce the number of Chromium processes while keeping cookies, storage, cache, and service workers isolated between workers. The current balanced [browser isolation record](https://github.com/l4dybird/storyfreeze/blob/master/benchmarks/browser-isolation-record.json) reduced wall p50 by 7.9%, wall p95 by 8.2%, peak RSS by 54.0%, and the Chromium process peak from 32 to 14. Its capture-request p95 was still 7.3% slower, above the 5% default gate, so process isolation remains the default.

`--trace` writes the existing Chromium CPU trace JSON format. Because Chromium CPU tracing is browser-process scoped, combining `--trace` with `--browser-isolation context` emits a warning and automatically uses process isolation for that run. The configured parallelism is preserved.

## Storybook compatibility

### Storybook versions

StoryFreeze is tested with the followings versions:

- Simple mode:
  - [x] Storybook v10.x
- Managed mode:
  - [x] Storybook v10.x

See also packages in `examples` directory.

### UI frameworks

StoryFreeze (with both simple and managed mode) is agnostic for specific UI frameworks(e.g. React, Angular, Vue.js, etc...). So you can use it with Storybook with your own favorite framework :smile: .

## How it works

StoryFreeze accesses the launched page using [Playwright][playwright]. It supports both process and context worker isolation.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT © huuyafwww](./LICENSE)
