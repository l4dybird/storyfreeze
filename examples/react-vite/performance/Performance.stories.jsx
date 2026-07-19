import React, { useEffect, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

const baseStyle = {
  background: '#f4f1ea',
  boxSizing: 'border-box',
  color: '#20242b',
  fontFamily: 'Arial, sans-serif',
  minHeight: '100vh',
  padding: 32,
};

function BenchmarkCard({ index = 0, kind = 'default', rows = 4 }) {
  const [clicks, setClicks] = useState(0);
  const [ready, setReady] = useState(kind !== 'network');

  useEffect(() => {
    if (kind !== 'network') return undefined;
    const timer = setTimeout(() => setReady(true), 35);
    return () => clearTimeout(timer);
  }, [kind]);

  return (
    <main style={baseStyle} data-benchmark-kind={kind}>
      <section
        style={{
          background: 'rgba(255, 255, 255, 0.92)',
          border: '2px solid #20242b',
          borderRadius: 16,
          boxShadow: '8px 8px 0 #f2b84b',
          margin: '0 auto',
          maxWidth: 960,
          padding: 24,
        }}
      >
        <p style={{ letterSpacing: 2, margin: 0, textTransform: 'uppercase' }}>StoryFreeze benchmark</p>
        <h1 style={{ fontSize: 32, margin: '8px 0 20px' }}>
          {kind} #{String(index).padStart(2, '0')}
        </h1>
        <button
          className="benchmark-target"
          style={{
            background: '#1f6feb',
            border: 0,
            borderRadius: 8,
            color: 'white',
            fontSize: 18,
            padding: '12px 20px',
          }}
          type="button"
          onClick={() => setClicks(current => current + 1)}
        >
          Interactions: {clicks}
        </button>
        <p data-testid="benchmark-ready">{ready ? 'Ready' : 'Loading'}</p>
        {kind === 'network' && (
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(4, 1fr)' }}>
            {Array.from({ length: 24 }, (_, imageIndex) => (
              <img
                key={imageIndex}
                alt={`Fixture ${imageIndex}`}
                src={`/fixture.svg?benchmark=${imageIndex}`}
                style={{ height: 64, width: 64 }}
              />
            ))}
          </div>
        )}
        <div style={{ display: 'grid', gap: 8, marginTop: 24 }}>
          {Array.from({ length: rows }, (_, rowIndex) => (
            <div
              key={rowIndex}
              style={{
                background: rowIndex % 2 ? '#dce8ff' : '#f9dfaa',
                borderRadius: 6,
                height: kind === 'large-full-page' ? 72 : 32,
              }}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

const manyStory = index => ({
  name: `Many/${String(index).padStart(2, '0')}`,
  args: { index, kind: 'many-story' },
});

const desktopViewport = { globals: { viewport: { value: 'desktop' } } };
const mobileViewport = { globals: { viewport: { value: 'mobile' } } };

const variantEntries = [
  ...Array.from({ length: 4 }, (_, index) => [`hover-${index + 1}`, { hover: '.benchmark-target' }]),
  ...Array.from({ length: 4 }, (_, index) => [`focus-${index + 1}`, { focus: '.benchmark-target' }]),
  ['clip-small', { clip: { x: 16, y: 16, width: 320, height: 240 } }],
  ['clip-large', { clip: { x: 8, y: 8, width: 640, height: 480 } }],
  ['transparent', { omitBackground: true }],
  ['bounded', { captureBeyondViewport: false }],
];

const meta = {
  title: 'Performance/Matrix',
  component: BenchmarkCard,
  args: {
    index: 1,
    kind: 'default',
    rows: 4,
  },
};

export default meta;

export const Single = {
  name: 'Single/Default',
};

export const Many01 = { ...manyStory(1), ...desktopViewport };
export const Many02 = { ...manyStory(2), ...desktopViewport };
export const Many03 = { ...manyStory(3), ...desktopViewport };
export const Many04 = { ...manyStory(4), ...desktopViewport };
export const Many05 = { ...manyStory(5), ...mobileViewport };
export const Many06 = { ...manyStory(6), ...mobileViewport };
export const Many07 = { ...manyStory(7), ...mobileViewport };
export const Many08 = { ...manyStory(8), ...mobileViewport };
export const Many09 = { ...manyStory(9), ...desktopViewport };
export const Many10 = { ...manyStory(10), ...desktopViewport };
export const Many11 = { ...manyStory(11), ...desktopViewport };
export const Many12 = { ...manyStory(12), ...desktopViewport };
export const Many13 = { ...manyStory(13), ...mobileViewport };
export const Many14 = { ...manyStory(14), ...mobileViewport };
export const Many15 = { ...manyStory(15), ...mobileViewport };
export const Many16 = { ...manyStory(16), ...mobileViewport };
export const Many17 = { ...manyStory(17), ...desktopViewport };
export const Many18 = { ...manyStory(18), ...desktopViewport };
export const Many19 = { ...manyStory(19), ...desktopViewport };
export const Many20 = { ...manyStory(20), ...desktopViewport };
export const Many21 = { ...manyStory(21), ...mobileViewport };
export const Many22 = { ...manyStory(22), ...mobileViewport };
export const Many23 = { ...manyStory(23), ...mobileViewport };
export const Many24 = { ...manyStory(24), ...mobileViewport };

export const VariantHeavy = {
  name: 'Variant Heavy/Default',
  args: { kind: 'variant-heavy' },
  parameters: {
    screenshot: {
      fullPage: false,
      variants: Object.fromEntries(variantEntries),
    },
  },
};

export const MultipleViewports = {
  name: 'Multiple Viewports/Default',
  args: { kind: 'multiple-viewports' },
  parameters: {
    screenshot: {
      viewports: {
        desktop: { width: 1280, height: 720 },
        laptop: { width: 1024, height: 768 },
        tablet: { width: 768, height: 1024 },
        compact: { width: 640, height: 480 },
      },
    },
  },
};

export const MixedDevices = {
  name: 'Mixed Devices/Default',
  args: { kind: 'mixed-devices' },
  parameters: {
    screenshot: {
      viewports: {
        desktop: { width: 1280, height: 720 },
        phone: { width: 390, height: 844, deviceScaleFactor: 3, hasTouch: true, isMobile: true },
        tablet: { width: 820, height: 1180, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
        desktopRetina: { width: 1440, height: 900, deviceScaleFactor: 2 },
      },
    },
  },
};

export const LargeFullPage = {
  name: 'Large Full Page/Default',
  args: { kind: 'large-full-page', rows: 100 },
  parameters: {
    screenshot: {
      fullPage: true,
      viewport: { width: 1440, height: 900 },
    },
  },
};

export const HighDpr = {
  name: 'High DPR/Default',
  args: { kind: 'high-dpr' },
  parameters: {
    screenshot: {
      viewports: {
        dpr1: { width: 800, height: 600, deviceScaleFactor: 1 },
        dpr2: { width: 800, height: 600, deviceScaleFactor: 2 },
        dpr3: { width: 800, height: 600, deviceScaleFactor: 3 },
      },
    },
  },
};

export const NetworkHeavy = {
  name: 'Network Heavy/Default',
  args: { kind: 'network' },
  parameters: {
    screenshot: {
      delay: 50,
      waitAssets: true,
    },
  },
};

export const InteractionHeavy = {
  name: 'Interaction Heavy/Default',
  args: { kind: 'interaction-heavy' },
  parameters: {
    screenshot: {
      variants: Object.fromEntries([
        ...Array.from({ length: 4 }, (_, index) => [`hover-${index + 1}`, { hover: '.benchmark-target' }]),
        ...Array.from({ length: 4 }, (_, index) => [`focus-${index + 1}`, { focus: '.benchmark-target' }]),
      ]),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button');
    for (let index = 0; index < 8; index += 1) await userEvent.click(button);
    await expect(button).toHaveTextContent('Interactions: 8');
  },
};
