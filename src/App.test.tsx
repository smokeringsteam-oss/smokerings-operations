import { fireEvent, render, screen } from '@testing-library/react';
import App from './App';

test('renders the side panel layout on launch', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /smoke rings bbq/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /b2c dashboard/i })).toBeInTheDocument();
});

test('the mobile menu toggle opens and closes the side panel drawer', () => {
  const { container } = render(<App />);
  const shell = container.querySelector('.app-shell')!;

  expect(shell).not.toHaveClass('menu-open');

  fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
  expect(shell).toHaveClass('menu-open');

  fireEvent.click(screen.getByRole('button', { name: /close menu/i }));
  expect(shell).not.toHaveClass('menu-open');
});

test('picking a tool from the drawer closes it', () => {
  const { container } = render(<App />);
  const shell = container.querySelector('.app-shell')!;

  fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
  fireEvent.click(screen.getByRole('button', { name: /b2b dashboard/i }));

  expect(shell).not.toHaveClass('menu-open');
});
