import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Fixture } from './Fixture';

const retrySessionKey = 'storyfreeze-fixture-retry-ready';

async function waitForRetryRequest() {
  const retryCount = Number(new URLSearchParams(window.location.search).get('storyfreezeRetryCount') ?? 0);
  if (retryCount > 0) return;
  if (sessionStorage.getItem(retrySessionKey)) return;
  sessionStorage.setItem(retrySessionKey, 'true');
  await new Promise(resolve => setTimeout(resolve, 3500));
}

const meta = {
  title: 'Compatibility/Fixture',
  component: Fixture,
  tags: ['autodocs'],
  args: {
    asyncLabel: 'Assets ready',
  },
};

export default meta;

export const Interactions = {
  args: {
    consoleLevel: 'warn',
  },
  loaders: [
    async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { status: 'loaded' };
    },
  ],
  parameters: {
    screenshot: {
      variants: {
        hovered: {
          extends: ['LARGE', 'SMALL'],
          hover: '.fixture-button',
        },
        focused: {
          extends: ['LARGE', 'SMALL'],
          focus: '.fixture-button',
        },
        clicked: {
          click: '.fixture-button',
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByTestId('async-status')).toHaveTextContent('Assets ready'),
    );
    await userEvent.click(canvas.getByRole('button'));
    await expect(canvas.getByRole('button')).toHaveTextContent('Captures: 1');
  },
  afterEach: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('button')).toHaveTextContent('Captures: 1');
  },
};

export const ConsoleError = {
  args: {
    consoleLevel: 'error',
  },
};

export const Retry = {
  args: {
    retryStatus: 'Ready after retry',
  },
  parameters: {
    screenshot: {
      waitFor: waitForRetryRequest,
    },
  },
};
