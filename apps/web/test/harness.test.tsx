import { screen } from '@testing-library/react';
import { useParams } from 'react-router';
import { describe, expect, it } from 'vite-plus/test';
import { renderWithApp } from './setup.ts';

function SlugProbe() {
  const { slug } = useParams();
  return <p>slug={slug ?? 'none'}</p>;
}

describe('renderWithApp', () => {
  it('mounts an element at `path`, so it receives route params', () => {
    renderWithApp(<SlugProbe />, { route: '/skills/code-review', path: '/skills/:slug' });
    expect(screen.getByText('slug=code-review')).toBeTruthy();
  });

  it('mounts an element at every path by default', () => {
    renderWithApp(<SlugProbe />, { route: '/anything/here' });
    expect(screen.getByText('slug=none')).toBeTruthy();
  });
});
