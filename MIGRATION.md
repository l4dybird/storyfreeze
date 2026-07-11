# Migration

<!-- toc -->

- [From Storycapture 9 to StoryFreeze](#from-storycapture-9-to-storyfreeze)
- [From storybook-chrome-screenshot 1.x to storyfreeze](#from-storybook-chrome-screenshot-1x-to-storyfreeze)
  - [Replace dependency](#replace-dependency)
  - [Replace decorators](#replace-decorators)
  - [Move global options from `setScreentshotOptions` to `withScreenshot`](#move-global-options-from-setscreentshotoptions-to-withscreenshot)
  - [Modify screenshot options](#modify-screenshot-options)
  - [CLI usage](#cli-usage)
  - [CLI options](#cli-options)
  - [Other deprecated features](#other-deprecated-features)
- [From zisui 1.x to storyfreeze](#from-zisui-1x-to-storyfreeze)
  - [Replace dependency](#replace-dependency-1)
  - [Simple mode](#simple-mode)
  - [Managed mode for React](#managed-mode-for-react)

<!-- tocstop -->

## From Storycapture 9 to StoryFreeze

StoryFreeze is an independent project. It does not provide a `storycapture` CLI
alias, so remove the old package before installing StoryFreeze:

```sh
$ npm uninstall storycapture
$ npm install --save-dev storyfreeze
```

StoryFreeze requires Node.js 20.19 or newer and Storybook 10. It is published
as an ESM-only package, so replace CommonJS `require('storyfreeze')` calls with
ESM imports.

Update the addon package and imports:

```diff
// .storybook/main.js
- addons: ['storycapture']
+ addons: ['storyfreeze']

- import { withScreenshot, isScreenshot } from 'storycapture';
+ import { withScreenshot, isScreenshot } from 'storyfreeze';
```

Run the renamed CLI:

```diff
- npx storycapture http://localhost:6006
+ npx storyfreeze http://localhost:6006
```

The `STORYCAP_SHOW` environment variable is now `STORYFREEZE_SHOW`. The
`withScreenshot`, `isScreenshot`, `ScreenshotOptions`, `Variants`, `Viewport`,
and `parameters.screenshot` APIs are unchanged. Screenshot output paths and
filenames are also unchanged.

## From storybook-chrome-screenshot 1.x to storyfreeze

### Replace dependency

```sh
$ npm uninstall storybook-chrome-screenshot
$ npm install storyfreeze
```

And edit SB addons installation:

```js
/* .storybook/addons.js */

//import 'storybook-chrome-screenshot/register';
import 'storyfreeze/register';
```

### Replace decorators

`initScreenshot` decorator is already deleted so you should remove it from your SB configuration.

```js
/* Before */
/* .storybook/config.js */

import { addDecorator } from '@storybook/react';
import { initScreenshot, withScreenshot } from 'storybook-chrome-screenshot';

addDecorator(initScreenshot());
addDecorator(
  withScreenshot({
    /* Some options... */
  }),
);
```

```js
/* After */
/* .storybook/config.js */

import { addDecorator } from '@storybook/react';
import { withScreenshot } from 'storyfreeze';

addDecorator(
  withScreenshot({
    /* Some options... */
  }),
);
```

You should replace import path if you configure screenshot behavior in each story:

```js
import React from 'react';
import { storiesOf } from '@storybook/react';
// import { withScreenshot } from 'storybook-chrome-screenshot';
import { withScreenshot } from 'storyfreeze'; // <-
import { Button } from './Button';

storiesOf('Button', module)
  .addDecorator(withScreenshot())
  .add('with default style', () => <Button>Default</Button>);
```

### Move global options from `setScreentshotOptions` to `withScreenshot`

SCS's `setScreentshotOptions` API is already deleted. Use `withScreenshot` instead of it.

```js
/* Before */
/* .storybook/config.js */
import { setScreenshotOptions } from 'storybook-chrome-screenshot';

setScreenshotOptions({
  viewport: {
    width: 768,
    height: 400,
    deviceScaleFactor: 2,
  },
});
```

```js
/* After */
/* .storybook/config.js */
import { addDecorator } from '@storybook/react';
import { withScreenshot } from 'storyfreeze';

addDecorator(
  withScreenshot({
    viewport: {
      width: 768,
      height: 400,
      deviceScaleFactor: 2,
    },
  }),
);
```

### Modify screenshot options

Some fields of the argument of `withScreenshot` are deprecated.

- `namespace` field is deleted. If you want to add suffix to eace story, use `defaultVariantSuffix`
- `filePattern` field is deleted
- `viewport` field can't accepts `Array`. If you want set multiple viewports, use `viewports` field or `--viewport` CLI option

### CLI usage

storyfreeze CLI accepts only Storybook's URL and you can boot local Storybook server with `--serverCmd` option.

```sh
# Before
$ storybook-chrome-screenshot -p 8080 -h localhost -s ./public
```

```sh
# After
$ storyfreeze http://localhost:8080 --serverCmd "start-storybook -p 8080 -h localhost -s ./public"
```

### CLI options

Some CLI options of storybook-chrome-screenshot are deprecated.

- `--browser-timeout`: Use `--serverTimeout` instead of it
- `--filter-kind`, `--filter-story`: Use `--include` instead of them

### Other deprecated features

We dropped supporting knobs. You can write story with corresponding properties if you want to capture overwriting stories' props.

## From zisui 1.x to storyfreeze

### Replace dependency

```sh
$ npm uninstall zisui
$ npm install storyfreeze
```

### Simple mode

All you need is change CLI name :smile:

```sh
# Before

$ zisui http://your.storybook.com
```

```sh
# After

$ storyfreeze http://your.storybook.com
```

All CLI options of _zisui_ are available with StoryFreeze.

### Managed mode for React

You had the following if you use zisui managed mode.

```js
/* .storybook/addons.js */

import 'zisui/register';
```

You should replace it:

```js
/* .storybook/addons.js */

import 'storyfreeze/register';
```

And you should edit `.storybook/config.js`:

```js
/* .storybook/config.js */

import { addDecorator } from '@storybook/react';
import { withScreenshot } from 'zisui';

addDecorator(withScreenshot({
  // Some screenshot options...
});
```

You should replace it as the following:

```js
/* .storybook/config.js */

import { addDecorator } from '@storybook/react';
import { withScreenshot } from 'storyfreeze';

addDecorator(withScreenshot({
  // Some screenshot options...
});
```

**Remarks**: StoryFreeze accepts [Storybook's global parameters notation](https://github.com/storybookjs/storybook/blob/next/MIGRATION.md#options-addon-deprecated), so `addParameters` is recommended if you use Storybook v5.0 or later:

```js
/* .storybook/config.js */

import { addDecorator, addParameters } from '@storybook/react';
import { withScreenshot } from 'storyfreeze';

addDecorator(withScreenshot);
addParameters({
  screenshot: {
    // Some screenshot options...
  },
});
```
