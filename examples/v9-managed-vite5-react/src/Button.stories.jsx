import React from 'react';
import { Button } from './Button';
import { action } from 'storybook/actions';

import { isScreenshot } from 'storyfreeze';

export default {
  title: 'Button',
  component: Button,
};

export const WithText = {
  render: () => <Button onClick={action('clicked')}>Hello {isScreenshot() ? 'StoryFreeze' : 'Button'}</Button>,
};

export const WithSomeEmoji = {
  render: () => (
    <Button onClick={action('clicked')}>
      <span role="img" aria-label="so cool">
        😀 😎 👍 💯
      </span>
    </Button>
  ),
};

export const ToBeSkipped = {
  parameters: {
    screenshot: {
      skip: true,
    },
  },
};
