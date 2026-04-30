// Centralised colour helpers and visual constants. Pure module — safe to
// import from any component or other lib module.

import kthColors from '@/data/kth-colors.json';
import type { CourseGroup } from '@/types/cosmetics';

// One of the five KTH colour families used for cosmetics-based grouping.
export type FamilyName = CourseGroup['colorFamily'];

// Centralized styling constants — module-level so they're stable across renders.
export const STYLE = {
  fontFamily: "Figtree, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, Noto Sans, 'Apple Color Emoji', 'Segoe UI Emoji'",
  legend: {
    width: 170,
    offsetX: 85,
    offsetY: 30,
    background: 'rgba(255,255,255,0.95)',
    borderColor: '#e5e7eb',
    requires: 'Särskild behörighet',
    requiredFor: 'Krävs för',
    textColor: kthColors.KthBlue?.HEX || '#004791',
  },
} as const;

// Default colour for courses not in any cosmetics group.
export const defaultColor = {
  fill: kthColors.KthHeaven?.HEX || '#6298D2',
  stroke: kthColors.KthBlue?.HEX || '#004791',
  text: kthColors.KthLightBlue?.HEX || '#DEF0FF',
};

export const getColorForFamily = (family: FamilyName) => {
  const families = {
    blue: { fill: kthColors.KthBlue?.HEX || '#004791', stroke: kthColors.KthMarine?.HEX || '#000061', text: kthColors.KthLightBlue?.HEX || '#DEF0FF' },
    green: { fill: kthColors.KthGreen?.HEX || '#4DA061', stroke: kthColors.KthDarkGreen?.HEX || '#0D4A21', text: kthColors.KthLightGreen?.HEX || '#C7EBBA' },
    turquoise: { fill: kthColors.KthTurquoise?.HEX || '#339C9C', stroke: kthColors.KthDarkTurquoise?.HEX || '#1C434C', text: kthColors.KthLightTurquoise?.HEX || '#B2E0E0' },
    brick: { fill: kthColors.KthBrick?.HEX || '#E86A58', stroke: kthColors.KthDarkBrick?.HEX || '#78001A', text: kthColors.KthLightBrick?.HEX || '#FFCCC4' },
    yellow: { fill: kthColors.KthYellow?.HEX || '#FFBE00', stroke: kthColors.KthDarkYellow?.HEX || '#A65900', text: kthColors.KthLightYellow?.HEX || '#FFF0B0' },
  };
  return families[family];
};

export const getFamilyVariants = (family: FamilyName) => {
  if (family === 'blue') {
    return [
      { fill: kthColors.KthLightBlue?.HEX || '#6298D2', stroke: kthColors.KthMarine?.HEX || '#000061', text: kthColors.KthMarine?.HEX || '#000061' },
    ];
  }
  if (family === 'green') {
    return [
      { fill: kthColors.KthLightGreen?.HEX || '#C7EBBA', stroke: kthColors.KthDarkGreen?.HEX || '#0D4A21', text: kthColors.KthLightGreen?.HEX || '#C7EBBA' },
    ];
  }
  if (family === 'turquoise') {
    return [
      { fill: kthColors.KthLightTurquoise?.HEX || '#B2E0E0', stroke: kthColors.KthDarkTurquoise?.HEX || '#1C434C', text: kthColors.KthLightTurquoise?.HEX || '#B2E0E0' },
    ];
  }
  if (family === 'brick') {
    return [
      { fill: kthColors.KthLightBrick?.HEX || '#FFCCC4', stroke: kthColors.KthDarkBrick?.HEX || '#78001A', text: kthColors.KthDarkBrick?.HEX || '#78001A' },
    ];
  }
  // yellow
  return [
    { fill: kthColors.KthLightYellow?.HEX || '#FFF0B0', stroke: kthColors.KthDarkYellow?.HEX || '#A65900', text: kthColors.KthDarkYellow?.HEX || '#A65900' },
  ];
};
