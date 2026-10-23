// @vitest-environment jsdom
import React from 'react';
import { it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Metric } from './Metric';
it('shows zero observations without fabricated improvement', () => {
  render(<Metric label="COMPLETED TASKS" value={0} />);
  expect(screen.getByText('0')).toBeTruthy();
  expect(screen.queryByText(/%/)).toBeNull();
  cleanup();
});
