import '@fontsource/noto-sans/400.css';
import { useEffect, useState } from 'react';
import './fixture.css';

export function Fixture({ asyncLabel, consoleLevel }) {
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
