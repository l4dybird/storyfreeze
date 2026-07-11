# Migration

<!-- toc -->

- [From Storycapture 9 to StoryFreeze](#from-storycapture-9-to-storyfreeze)
- [From storybook-chrome-screenshot 1.x to storyfreeze](#from-storybook-chrome-screenshot-1x-to-storyfreeze)
  - [Replace dependency](#replace-dependency)
  - [Replace decorators](#replace-decorators)
  - [Move global options from `setScreentshotOptions` to parameters](#move-global-options-from-setscreentshotoptions-to-parameters)
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

Update the addon package and direct API imports:

```diff
// .storybook/main.js
- addons: ['storycapture']
+ addons: ['storyfreeze']

- import { withScreenshot, isScreenshot } from 'storycapture';
+ import { isScreenshot } from 'storyfreeze';
```

Remove manual `withScreenshot` decorator registration. Storybook 10 loads it
from the addon automatically; move its options to `parameters.screenshot`.

Run the renamed CLI:

```diff
- npx storycapture http://localhost:6006
+ npx storyfreeze http://localhost:6006
```

The `STORYCAP_SHOW` environment variable is now `STORYFREEZE_SHOW`. The
`isScreenshot`, `ScreenshotOptions`, `Variants`, `Viewport`, and
`parameters.screenshot` APIs are unchanged. The `withScreenshot` export remains
available for direct integrations but must not be registered alongside the
addon. Screenshot output paths and filenames are also unchanged.

## From storybook-chrome-screenshot 1.x to storyfreeze

### Replace dependency

```sh
$ npm uninstall storybook-chrome-screenshot
$ npm install storyfreeze
```

And add StoryFreeze to the Storybook addons configuration:

```js
/* .storybook/main.js */
export default {
  addons: ['storyfreeze'],
};
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
/* .storybook/preview.js */

export const parameters = {
  screenshot: {
    /* Some options... */
  },
};
```

Use the `screenshot` parameter if you configure screenshot behavior in each story:

```js
import React from 'react';
import { storiesOf } from '@storybook/react';
import { Button } from './Button';

storiesOf('Button', module)
  .addParameters({
    screenshot: {
      /* Some options... */
    },
  })
  .add('with default style', () => <Button>Default</Button>);
```

### Move global options from `setScreentshotOptions` to parameters

SCS's `setScreentshotOptions` API is already deleted. Use Storybook parameters instead.

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
/* .storybook/preview.js */
export const parameters = {
  screenshot: {
    viewport: {
      width: 768,
      height: 400,
      deviceScaleFactor: 2,
    },
  },
};
```

### Modify screenshot options

Some fields of `ScreenshotOptions` are deprecated.

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

Replace the legacy registration with the Storybook addon configuration:

```js
/* .storybook/main.js */
export default {
  addons: ['storyfreeze'],
};
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
/* .storybook/preview.js */

export const parameters = {
  screenshot: {
    // Some screenshot options...
  },
};
```

StoryFreeze uses Storybook's global parameters notation:

```js
/* .storybook/preview.js */

export const parameters = {
  screenshot: {
    // Some screenshot options...
  },
};
```
