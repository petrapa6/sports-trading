import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModeBadge, modeBadgeLabel, type ModeBadgeProps } from '../../../src/web/components/ModeBadge';

const VARIANTS: [string, ModeBadgeProps][] = [
  ['LIVE', { effective: 'live', configured: 'live', reason: null }],
  ['DRY RUN', { effective: 'dry_run', configured: 'dry_run', reason: 'strategy' }],
  ['LIVE → DRY RUN (global)', { effective: 'dry_run', configured: 'live', reason: 'global_dry_run' }],
  ['LIVE → DRY RUN (add-on lock)', { effective: 'dry_run', configured: 'live', reason: 'addon_lock' }],
];

describe('ModeBadge', () => {
  it.each(VARIANTS)('renders %s', (label, props) => {
    expect(modeBadgeLabel(props)).toBe(label);
    const html = renderToStaticMarkup(<ModeBadge {...props} />);
    expect(html).toContain(`>${label}</span>`);
    expect(html).toMatchSnapshot();
  });

  it('defaults: configured = effective, no reason', () => {
    expect(modeBadgeLabel({ effective: 'live' })).toBe('LIVE');
    expect(modeBadgeLabel({ effective: 'dry_run' })).toBe('DRY RUN');
    // A strategy configured dry run is just DRY RUN, whatever the global reason.
    expect(modeBadgeLabel({ effective: 'dry_run', configured: 'dry_run', reason: 'addon_lock' })).toBe(
      'DRY RUN',
    );
  });
});
