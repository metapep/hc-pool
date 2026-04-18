import { DifficultyUtils } from './difficulty.utils';

describe('DifficultyUtils', () => {
  it('calculates expected network difficulty for legacy and post-retarget bits', () => {
    const legacyBitsDifficulty =
      DifficultyUtils.calculateDifficultyFromBits(0x207fffff);
    const postRetargetDifficulty =
      DifficultyUtils.calculateDifficultyFromBits(0x1e09debb);

    expect(legacyBitsDifficulty).toBeCloseTo(4.6565423739e-10, 20);
    expect(postRetargetDifficulty).toBeCloseTo(0.000395762331, 12);
    expect(postRetargetDifficulty).toBeGreaterThan(legacyBitsDifficulty);
  });
});
