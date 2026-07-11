import '@fontsource/noto-sans/400.css';
import React, { useEffect, useState } from 'react';
import './fixture.css';

export function Fixture({ asyncLabel, consoleLevel, retryStatus }) {
  const [label, setLabel] = useState('Loading…');
  const [clicks, setClicks] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setLabel(asyncLabel), 25);

    if (consoleLevel === 'warn') {
      console.warn('StoryFreeze fixture warning');
    }
    if (consoleLevel === 'error') {
      console.error('StoryFreeze fixture error');
    }

    return () => clearTimeout(timer);
  }, [asyncLabel, consoleLevel]);

  return (
    <main className="fixture-card">
      <img src="/fixture.svg" alt="StoryFreeze fixture" />
      <p data-testid="async-status">{label}</p>
      {retryStatus && <p data-testid="retry-status">{retryStatus}</p>}
      <button
        className="fixture-button"
        type="button"
        onClick={() => setClicks(current => current + 1)}
      >
        Captures: {clicks}
      </button>
    </main>
  );
}
