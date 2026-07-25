import { BenchSurface } from './BenchSurface';

// S2: several viewport variants per story plus a static delay and a play
// function. Every variant currently pays a FORCE_REMOUNT, its own readiness
// wait and its own delay, so this is the scenario where readiness
// notifications and cost-aware assignment should show up most clearly.
const meta = {
  title: 'Bench/Variants',
  component: BenchSurface,
  parameters: {
    screenshot: {
      delay: 150,
      viewports: {
        DESKTOP: { width: 1200, height: 800 },
        TABLET: { width: 834, height: 1112 },
        MOBILE: { width: 390, height: 844 },
      },
    },
  },
  play: async () => {
    // Deterministic asynchronous settle, mirroring a real play function.
    await new Promise(resolve => setTimeout(resolve, 40));
  },
};

export default meta;

const rows = 10;

export const Variants01 = { args: { label: 'Variants 01', rows, tone: 1 } };
export const Variants02 = { args: { label: 'Variants 02', rows, tone: 2 } };
export const Variants03 = { args: { label: 'Variants 03', rows, tone: 3 } };
export const Variants04 = { args: { label: 'Variants 04', rows, tone: 4 } };
export const Variants05 = { args: { label: 'Variants 05', rows, tone: 5 } };
export const Variants06 = { args: { label: 'Variants 06', rows, tone: 6 } };
export const Variants07 = { args: { label: 'Variants 07', rows, tone: 7 } };
export const Variants08 = { args: { label: 'Variants 08', rows, tone: 8 } };
