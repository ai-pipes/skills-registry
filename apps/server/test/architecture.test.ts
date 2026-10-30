import { cruise } from 'dependency-cruiser';
import extractDepcruiseConfig from 'dependency-cruiser/config-utl/extract-depcruise-config';
import extractWebpackResolveConfig from 'dependency-cruiser/config-utl/extract-webpack-resolve-config';
import { describe, expect, it } from 'vite-plus/test';

const ruleSet = await extractDepcruiseConfig('./.dependency-cruiser.cjs');
// The CLI reads `options.webpackConfig` itself; through the API the resolve options are passed
// explicitly, so the web app's `@/` alias resolves.
const { alias } = await extractWebpackResolveConfig('./.dependency-cruiser.resolve.cjs');

async function violationsIn(dir: string) {
  const result = await cruise(
    [dir],
    { ruleSet, validate: true, tsPreCompilationDeps: true },
    { alias },
  );
  if (typeof result.output === 'string') throw new Error('unexpected string output');
  return result.output.summary.violations;
}

describe('architecture rules', () => {
  it('rejects domain importing infrastructure', async () => {
    const violations = await violationsIn('apps/server/test/architecture/fixtures/bad-domain');
    // domain -> infrastructure also breaks `domain-is-pure`; assert on the dedicated rule.
    const inward = violations.filter((v) => v.rule.name === 'no-inward-infra');
    expect(inward).toHaveLength(1);
    expect(inward[0]).toMatchObject({
      from: expect.stringContaining('modules/x/domain/a.ts'),
      to: expect.stringContaining('modules/x/infrastructure/b.ts'),
    });
  });

  it('rejects importing Radix', async () => {
    const violations = await violationsIn('apps/server/test/architecture/fixtures/radix');
    expect(violations.filter((v) => v.rule.name === 'no-radix')).toEqual([
      expect.objectContaining({ from: expect.stringContaining('fixtures/radix/a.ts') }),
    ]);
  });

  it('accepts the real source tree', async () => {
    expect(await violationsIn('apps/server/src')).toEqual([]);
  });

  it('accepts the real web source tree', async () => {
    expect(await violationsIn('apps/web/src')).toEqual([]);
  });
});
