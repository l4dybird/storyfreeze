import React, { useEffect, useRef } from 'react';
import './bench.css';

/**
 * Deterministic filler content. Row count controls the document height so
 * fullPage captures can be made arbitrarily tall without random data.
 */
export function BenchSurface({ label, rows = 8, tone = 0 }) {
  const items = [];
  for (let index = 0; index < rows; index += 1) {
    items.push(
      <li key={index} className={index % 2 === 0 ? 'bench-row bench-row-even' : 'bench-row'}>
        <span className="bench-row-index">{String(index).padStart(4, '0')}</span>
        <span className="bench-row-body">
          {label} &middot; tone {tone} &middot; row {index}
        </span>
      </li>,
    );
  }

  return (
    <main className="bench-surface" data-tone={tone}>
      <h1 className="bench-title">{label}</h1>
      <ul className="bench-list">{items}</ul>
    </main>
  );
}

function readEmulation() {
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    orientation: window.screen.orientation ? window.screen.orientation.type : 'unsupported',
    orientationAngle: window.screen.orientation ? window.screen.orientation.angle : -1,
    devicePixelRatio: window.devicePixelRatio,
    maxTouchPoints: navigator.maxTouchPoints,
    coarsePointer: window.matchMedia('(pointer: coarse)').matches ? 'yes' : 'no',
  };
}

const probeFields = [
  'innerWidth',
  'innerHeight',
  'screenWidth',
  'screenHeight',
  'orientation',
  'orientationAngle',
  'devicePixelRatio',
  'maxTouchPoints',
  'coarsePointer',
];

/**
 * Renders the Chromium emulation state that StoryFreeze controls through CDP.
 *
 * StoryFreeze applies the viewport *after* the story renders, and a
 * touch-only change fires no `resize` event, so the values are re-read on every
 * animation frame.
 *
 * The re-read writes straight into the DOM instead of going through React
 * state. React would commit the update asynchronously, which races the two
 * animation frames StoryFreeze waits for before capturing and made this story
 * produce two different images for the same emulation. Writing `textContent`
 * inside the frame callback keeps the read and the paint in the same frame, so
 * the captured pixels are a deterministic record of the emulation in effect.
 */
export function EmulationProbe({ label }) {
  const values = useRef({});

  useEffect(() => {
    let handle = 0;
    let frames = 0;
    const tick = () => {
      const next = readEmulation();
      for (const field of probeFields) {
        const node = values.current[field];
        const text = String(next[field]);
        if (node && node.textContent !== text) node.textContent = text;
      }
      frames += 1;
      // Bounded so a story can never spin forever if it is left mounted.
      if (frames < 600) handle = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(handle);
  }, []);

  return (
    <main className="bench-probe">
      <h1 className="bench-title">{label}</h1>
      <dl className="bench-probe-list">
        {probeFields.map(field => (
          <div key={field} className="bench-probe-entry">
            <dt>{field}</dt>
            <dd
              data-testid={field}
              ref={node => {
                values.current[field] = node;
              }}
            />
          </div>
        ))}
      </dl>
    </main>
  );
}
