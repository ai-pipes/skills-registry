import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vite-plus/test';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { renderWithApp } from '../../test/setup.ts';

// CSP `style-src 'self'` blocks inline <style> elements; Base UI must not render any
// (its scrollbar-hiding rule lives in global.css instead).
function baseUiStyleElements() {
  return [...document.querySelectorAll('style')].filter((s) =>
    (s.textContent ?? '').includes('base-ui-disable-scrollbar'),
  );
}

describe('Base UI under the strict CSP', () => {
  it('an open Select and a ScrollArea render no inline <style> elements', async () => {
    const { user } = renderWithApp(
      <>
        <Select defaultValue="a">
          <SelectTrigger aria-label="Choice">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">First</SelectItem>
            <SelectItem value="b">Second</SelectItem>
          </SelectContent>
        </Select>
        <ScrollArea className="h-10">
          <p>Long text</p>
        </ScrollArea>
      </>,
    );
    await user.click(screen.getByRole('combobox', { name: 'Choice' }));
    expect(await screen.findByRole('option', { name: 'Second' })).toBeTruthy();
    expect(baseUiStyleElements()).toEqual([]);
  });
});
