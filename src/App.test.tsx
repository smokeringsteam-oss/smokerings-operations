import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the side panel layout on launch', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /smoke rings bbq/i })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /overview/i })).toBeInTheDocument();
});
