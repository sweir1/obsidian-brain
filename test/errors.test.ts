import { describe, expect, it } from 'vitest';
import { UserError, formatUserError } from '../src/errors.js';

describe('UserError', () => {
  it('is an instance of Error', () => {
    const err = new UserError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UserError);
    expect(err.name).toBe('UserError');
    expect(err.message).toBe('boom');
  });

  it('preserves the optional hint', () => {
    const err = new UserError('boom', { hint: 'try setting X' });
    expect(err.hint).toBe('try setting X');
  });

  it('hint is undefined when not provided', () => {
    const err = new UserError('boom');
    expect(err.hint).toBeUndefined();
  });

  it('formatUserError prepends obsidian-brain prefix and formats hint as "↳"', () => {
    const out = formatUserError(new UserError('something missing', { hint: 'set FOO' }));
    expect(out).toContain('obsidian-brain: something missing');
    expect(out).toContain('↳ set FOO');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('formatUserError omits the hint line when no hint is set', () => {
    const out = formatUserError(new UserError('plain error'));
    expect(out).toBe('obsidian-brain: plain error\n');
    expect(out).not.toContain('↳');
  });
});
