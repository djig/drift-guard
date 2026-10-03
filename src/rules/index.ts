import type { Rule } from '../types.js';
import { nextRules } from './next.js';
import { reactRules } from './react.js';
import { tailwindRules } from './tailwind.js';
import { depsRules } from './deps.js';

export const allRules: Rule[] = [...nextRules, ...reactRules, ...tailwindRules, ...depsRules];

export const rulesById: Map<string, Rule> = new Map(allRules.map((r) => [r.id, r]));

export { nextRules, reactRules, tailwindRules, depsRules };
