import type { OptionGroup } from '@/types/course';

// Resolution helpers for OptionGroup's selection-rule discriminator.
// Centralised here so the renderer, modal, validator, and URL parser
// all agree on the defaults.

export type OptionGroupKind = 'pickN' | 'minCredits';

export function getOptionGroupKind(og: OptionGroup): OptionGroupKind {
  return og.kind ?? 'pickN';
}

// How many courses a 'pickN' group accepts. Falls back to the legacy
// `allowedNumberOfOptions` field; defaults to 1 if neither is set.
export function getOptionGroupPickN(og: OptionGroup): number {
  if (typeof og.pickN === 'number' && og.pickN >= 1) return og.pickN;
  if (typeof og.allowedNumberOfOptions === 'number' && og.allowedNumberOfOptions >= 1) {
    return og.allowedNumberOfOptions;
  }
  return 1;
}

// Required credit total for a 'minCredits' group. Returns 0 for 'pickN'
// groups so callers can use it unconditionally.
export function getOptionGroupMinCredits(og: OptionGroup): number {
  if (getOptionGroupKind(og) !== 'minCredits') return 0;
  return typeof og.minCredits === 'number' && og.minCredits >= 0 ? og.minCredits : 0;
}

/** How far a selection has got on one of the group's constraints. */
export interface ConstraintProgress {
  label: string;
  have: number;
  need: number;
  unit: 'count' | 'credits';
  met: boolean;
}

// Progress on each of the group's sub-quotas (OptionGroup.constraints) for a
// set of picked codes. `creditsOf` gives a picked course's credits, from the
// caller's own course lookup. Shared by the selection modal and the tooltip, so
// the two cannot disagree about whether a rule is met.
export function constraintProgress(
  og: OptionGroup,
  picked: string[],
  creditsOf: (code: string) => number,
  language: 'sv' | 'en',
): ConstraintProgress[] {
  return (og.constraints ?? []).map(c => {
    const pool = c.from ? new Set(c.from) : null;
    const counted = picked.filter(code => !pool || pool.has(code));
    const have = c.kind === 'minCount'
      ? counted.length
      : Math.round(counted.reduce((a, code) => a + creditsOf(code), 0) * 10) / 10;
    return {
      label: language === 'en' ? (c.labelEn || c.label) : c.label,
      have,
      need: c.value,
      unit: c.kind === 'minCount' ? 'count' : 'credits',
      // 0.05 hp: the tolerance used for the group total too (3.7 + 3.8 hp).
      met: c.kind === 'minCount' ? have >= c.value : have >= c.value - 0.05,
    };
  });
}
