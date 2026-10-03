import { describe, expect, it } from 'vitest';
import { matchWakeWord } from './wakeWord';

describe('matchWakeWord', () => {
  it('hears the phrase on its own', () => {
    expect(matchWakeWord('hey smokey')).toBe('');
    expect(matchWakeWord('Hey, Smoky.')).toBe('');
  });

  it('hands back what was said after it', () => {
    expect(matchWakeWord('hey smokey bought 5 kg pork shoulder at 540')).toBe('bought 5 kg pork shoulder at 540');
    expect(matchWakeWord('right so hey smokie, remind Sowmya to call the gas vendor')).toBe(
      'remind Sowmya to call the gas vendor',
    );
  });

  it('ignores everything else', () => {
    expect(matchWakeWord('the smokey ribs are ready')).toBeNull();
    expect(matchWakeWord('hey sowmya')).toBeNull();
    expect(matchWakeWord('')).toBeNull();
  });
});
