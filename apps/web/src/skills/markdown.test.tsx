import { render as rtlRender } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vite-plus/test';
import { Markdown } from './Markdown.tsx';

/** Relative links render a react-router `<Link>`, which needs a router. */
function render(ui: ReactElement, route = '/skills/demo') {
  return rtlRender(<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>);
}

const malicious = `
# Title

<script>alert(1)</script>

<iframe src="https://evil.example"></iframe>

<img src="x" onerror="alert(1)">

<a href="javascript:alert(1)" onclick="alert(1)">raw link</a>

[js](javascript:alert(1))

[js upper](JaVaScRiPt:alert(1))

[js spaced]( javascript:alert(1))

[data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)

[vb](vbscript:msgbox(1))

![img](javascript:alert(1))
`;

function allElements(root: HTMLElement): Element[] {
  return [root, ...root.querySelectorAll('*')];
}

describe('<Markdown>', () => {
  it('renders hostile markdown without scripts, frames, handlers or dangerous URLs', () => {
    const { container } = render(<Markdown slug="demo" source={malicious} />);
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('script, iframe, object, embed, style')).toBeNull();
    for (const el of allElements(container)) {
      for (const attr of el.attributes) {
        expect(attr.name.toLowerCase().startsWith('on'), `${el.tagName} ${attr.name}`).toBe(false);
        if (attr.name === 'href' || attr.name === 'src') {
          expect(attr.value.trim().toLowerCase()).not.toMatch(/^(javascript|vbscript|data):/);
        }
      }
    }
  });

  it('keeps http(s), mailto and relative links; external ones get rel="noopener noreferrer"', () => {
    const { container } = render(
      <Markdown
        slug="demo"
        source={
          '[web](https://example.com/a) [mail](mailto:a@example.com) [rel](references/guide.md) [anchor](#usage) [pr](//example.org/x)'
        }
      />,
    );
    const hrefs = [...container.querySelectorAll('a')].map((a) => [
      a.textContent,
      a.getAttribute('href'),
      a.getAttribute('rel'),
    ]);
    expect(hrefs).toEqual([
      ['web', 'https://example.com/a', 'noopener noreferrer'],
      ['mail', 'mailto:a@example.com', null],
      ['rel', '/skills/demo?file=references/guide.md', null],
      ['anchor', '#usage', null],
      ['pr', '//example.org/x', 'noopener noreferrer'],
    ]);
    const external = container.querySelector('a[href^="https:"]');
    expect(external?.getAttribute('target')).toBe('_blank');
  });

  it('renders GFM tables and task lists', () => {
    const { container } = render(
      <Markdown slug="demo" source={'| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n'} />,
    );
    expect(container.querySelectorAll('table td')).toHaveLength(2);
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it('opens a relative link as a file of the skill, resolved against the skill root', () => {
    const { container } = render(
      <Markdown
        slug="demo"
        source={
          '[a](references/x.md) [b](./references/../refs/y.md#part) [c](a%20b/%D0%BC.md?x=1) [up](../../etc/passwd) [root](..)'
        }
      />,
    );
    const links = Object.fromEntries(
      [...container.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]),
    );
    expect(links).toEqual({
      a: '/skills/demo?file=references/x.md',
      b: '/skills/demo?file=refs/y.md',
      c: `/skills/demo?file=a%20b/${encodeURIComponent('м')}.md`,
    });
    // Escaping the skill root: the text stays, the link does not.
    expect(container.textContent).toContain('up');
    expect(container.textContent).toContain('root');
  });

  it('keeps ?version=N on relative links of an old version', () => {
    const { container } = render(
      <Markdown slug="demo" version={3} source="[a](references/x.md)" />,
    );
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      '/skills/demo?file=references/x.md&version=3',
    );
  });

  it('loads relative images from the skill files API, absolute ones as they are', () => {
    const { container } = render(
      <Markdown
        slug="my skill"
        version={2}
        source={
          '![logo](assets/my%20logo.png) ![web](https://example.com/i.png) ![up](../secret.png)'
        }
      />,
    );
    const srcs = [...container.querySelectorAll('img')].map((i) => [
      i.getAttribute('alt'),
      i.getAttribute('src'),
    ]);
    expect(srcs).toEqual([
      ['logo', '/api/skills/my%20skill/files/assets/my%20logo.png?version=2'],
      ['web', 'https://example.com/i.png'],
      ['up', null],
    ]);
  });
});
