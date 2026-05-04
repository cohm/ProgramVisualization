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
