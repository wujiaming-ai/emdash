/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextUsageIndicator } from './context-usage-indicator';

afterEach(cleanup);

describe('ContextUsageIndicator', () => {
  it.each(['estimated', 'resolved'] as const)(
    'explains a %s window without changing the token count',
    async (windowSource) => {
      const view = render(
        <ContextUsageIndicator usage={{ used: 745000, size: 1000000, windowSource }} />
      );
      fireEvent.click(view.getByRole('button', { name: /^Context window: 75% used/ }));
      expect(await view.findByText('745k / 1.0M Tokens')).toBeTruthy();
      expect(
        view.getByText(
          windowSource === 'estimated'
            ? 'Estimated window'
            : 'Current Claude context window; may be limited by auto-compaction policy.'
        )
      ).toBeTruthy();
    }
  );

  it('reports the actual percentage above the window instead of hiding it at 100%', async () => {
    const view = render(<ContextUsageIndicator usage={{ used: 745000, size: 200000 }} />);
    fireEvent.click(view.getByRole('button', { name: 'Context window: 373% used' }));
    expect(await view.findByText('373%')).toBeTruthy();
    expect(view.getByText('745k / 200k Tokens')).toBeTruthy();
    expect(
      view.container.querySelector('svg [stroke-dasharray]')?.getAttribute('stroke-dasharray')
    ).toBe('100 100');
  });

  it('shows tokens without a percentage when the window is unknown', async () => {
    const view = render(<ContextUsageIndicator usage={{ used: 745000, size: 0 }} />);
    fireEvent.click(
      view.getByRole('button', { name: 'Context window: unknown, 745k tokens used' })
    );
    expect(await view.findByText('Window unknown')).toBeTruthy();
    expect(view.getByText('745k Tokens')).toBeTruthy();
    expect(view.queryByText(/NaN|Infinity|100%/)).toBeNull();
  });
});
