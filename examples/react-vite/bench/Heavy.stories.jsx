import { BenchSurface } from './BenchSurface';

// S1: wide, retina, very tall fullPage captures. Targets the screenshot buffer
// budget (raw RGBA reservation vs real PNG size) and PNG encode cost.
const meta = {
  title: 'Bench/Heavy',
  component: BenchSurface,
  parameters: {
    screenshot: {
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    },
  },
};

export default meta;

// 120 rows * 40px + header is roughly 5,000 CSS px tall, so at
// deviceScaleFactor 2 each capture decodes to about 1.4 GB/16 of raw RGBA.
const rows = 120;

export const Heavy01 = { args: { label: 'Heavy 01', rows, tone: 1 } };
export const Heavy02 = { args: { label: 'Heavy 02', rows, tone: 2 } };
export const Heavy03 = { args: { label: 'Heavy 03', rows, tone: 3 } };
export const Heavy04 = { args: { label: 'Heavy 04', rows, tone: 4 } };
export const Heavy05 = { args: { label: 'Heavy 05', rows, tone: 5 } };
export const Heavy06 = { args: { label: 'Heavy 06', rows, tone: 6 } };
export const Heavy07 = { args: { label: 'Heavy 07', rows, tone: 7 } };
export const Heavy08 = { args: { label: 'Heavy 08', rows, tone: 8 } };
export const Heavy09 = { args: { label: 'Heavy 09', rows, tone: 9 } };
export const Heavy10 = { args: { label: 'Heavy 10', rows, tone: 10 } };
export const Heavy11 = { args: { label: 'Heavy 11', rows, tone: 11 } };
export const Heavy12 = { args: { label: 'Heavy 12', rows, tone: 12 } };
