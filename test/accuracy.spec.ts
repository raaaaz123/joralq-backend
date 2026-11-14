import { accuracyOf } from '../src/attempts/attempts.service';

describe('accuracyOf', () => {
  it('rounds to two decimals', () => {
    expect(accuracyOf(2, 3)).toBe(66.67);
    expect(accuracyOf(1, 3)).toBe(33.33);
    expect(accuracyOf(3, 3)).toBe(100);
    expect(accuracyOf(0, 5)).toBe(0);
  });
});
