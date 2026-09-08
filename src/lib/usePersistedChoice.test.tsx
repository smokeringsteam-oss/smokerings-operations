// Remembering which screen you were on, across a reload.
//
// Two of these are the point. The first is the plain one: pick a screen,
// reload, still be there. The second is the one that makes this safe to
// ship — a stored id that no longer names a real screen must fall back to
// the default rather than rendering nothing, because a blank dashboard with
// no way back except clearing site data is a much worse bug than forgetting
// a tab.
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { usePersistedChoice } from './usePersistedChoice';

const KEY = 'test.choice';
const KNOWN = ['home', 'clients', 'sales'] as const;
type Choice = (typeof KNOWN)[number];

const Screen = () => {
  const [choice, choose] = usePersistedChoice<Choice>(KEY, 'home', KNOWN);
  return (
    <div>
      <output>{choice}</output>
      {KNOWN.map((id) => (
        <button key={id} type="button" onClick={() => choose(id)}>
          go {id}
        </button>
      ))}
    </div>
  );
};

const shown = () => screen.getByRole('status').textContent;

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

test('a fresh browser lands on the default', () => {
  render(<Screen />);
  expect(shown()).toBe('home');
});

test('the choice survives the component being torn down and rebuilt', () => {
  const first = render(<Screen />);
  fireEvent.click(screen.getByRole('button', { name: 'go sales' }));
  expect(shown()).toBe('sales');

  // What a reload does, as far as the component is concerned.
  first.unmount();
  render(<Screen />);
  expect(shown()).toBe('sales');
});

test('a stored screen that no longer exists falls back instead of stranding', () => {
  // Exactly what a renamed or deleted module leaves behind in a browser that
  // was sitting on it. Rendering that id would render nothing.
  window.localStorage.setItem(KEY, 'weeklyPurchasingOld');
  render(<Screen />);
  expect(shown()).toBe('home');
});

test('going back to the default is remembered too, not treated as "nothing chosen"', () => {
  // A reload after stepping out of a module must not drop you back into it.
  render(<Screen />);
  fireEvent.click(screen.getByRole('button', { name: 'go clients' }));
  fireEvent.click(screen.getByRole('button', { name: 'go home' }));
  expect(window.localStorage.getItem(KEY)).toBe('home');
});

test('storage that throws is survived, in both directions', () => {
  // Safari private browsing, blocked cookies, a full quota. The screen still
  // has to render and still has to navigate — it just cannot remember.
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {},
    clear: () => {},
  });

  render(<Screen />);
  expect(shown()).toBe('home');
  fireEvent.click(screen.getByRole('button', { name: 'go sales' }));
  expect(shown()).toBe('sales');
});
