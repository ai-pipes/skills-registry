import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vite-plus/test';
import { notify } from '@/lib/notify.ts';
import { renderWithApp } from '../../test/setup.ts';

const region = () => screen.getByRole('region', { name: 'Notifications' });

describe('toasts (Base UI Toast)', () => {
  it('notify.success shows a success toast in the notifications region', async () => {
    renderWithApp(<p>page</p>);
    act(() => notify.success('Saved'));
    const text = await within(region()).findByText('Saved');
    expect(text.closest('[data-type]')?.getAttribute('data-type')).toBe('success');
    // not a dialog: an open toast must not look like one more open dialog
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('group', { name: 'Saved' })).toBeTruthy();
  });

  it('notify.error shows an error toast', async () => {
    renderWithApp(<p>page</p>);
    act(() => notify.error('Failed'));
    const text = await within(region()).findByText('Failed');
    expect(text.closest('[data-type]')?.getAttribute('data-type')).toBe('error');
  });

  it('a toast root is a focusable group, not a (modal) dialog', async () => {
    renderWithApp(<p>page</p>);
    act(() => notify.success('Saved'));
    const toast = await within(region()).findByRole('group', { name: 'Saved' });
    expect(toast.getAttribute('role')).toBe('group');
    expect(toast.hasAttribute('aria-modal')).toBe(false);
    expect(toast.getAttribute('tabindex')).toBe('0');
  });

  it('an error is announced assertively (high priority: an extra role="alert")', async () => {
    renderWithApp(<p>page</p>);
    act(() => notify.success('Saved'));
    expect(await within(region()).findByText('Saved')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => notify.error('Failed'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Failed');
    // Base UI hides the visible copy from assistive tech so the alert is not read twice.
    const toast = within(region()).getByText('Failed').closest('[role="group"]');
    if (!toast) throw new Error('no toast root');
    expect(toast.getAttribute('aria-hidden')).toBe('true');
    expect(toast.hasAttribute('aria-modal')).toBe(false);
  });

  it('notify.dismissAll closes every toast', async () => {
    renderWithApp(<p>page</p>);
    act(() => {
      notify.success('First');
      notify.success('Second');
    });
    expect(await screen.findByText('Second')).toBeTruthy();
    act(() => notify.dismissAll());
    await waitFor(() => expect(screen.queryByText('First')).toBeNull());
    expect(screen.queryByText('Second')).toBeNull();
  });

  // CSP `style-src 'self'` (no style-src-elem relaxation) blocks every inline <style>.
  it('renders no <style> element', async () => {
    renderWithApp(<p>page</p>);
    act(() => notify.success('Copied'));
    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(document.querySelectorAll('style')).toHaveLength(0);
  });
});
