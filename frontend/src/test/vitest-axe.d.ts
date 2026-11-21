import type { AxeMatchers } from 'vitest-axe';

interface ProjectMoneyAxeMatchers extends AxeMatchers {}

declare module 'vitest' {
  interface Assertion<T = any> extends ProjectMoneyAxeMatchers {}
  interface AsymmetricMatchersContaining extends ProjectMoneyAxeMatchers {}
}

export {};
