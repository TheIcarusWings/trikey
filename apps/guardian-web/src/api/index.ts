import type { GuardianApi } from './client';
import { createHttpApi } from './http';
import { createMockApi, readScenario } from './mock';

export type { GuardianApi } from './client';
export { ApiError } from './client';
export * from './types';

/**
 * VITE_API=mock|http. Without it the dev server uses the mock and a production
 * build talks to the real guardian, so `npm run build` can never ship demo data
 * by accident.
 */
function selectApi(): GuardianApi {
  const choice = import.meta.env.VITE_API ?? (import.meta.env.DEV ? 'mock' : 'http');
  if (choice === 'mock') return createMockApi(readScenario(window.location.search));
  return createHttpApi(import.meta.env.VITE_API_BASE ?? '');
}

export const api: GuardianApi = selectApi();
export const usingMockApi: boolean = (import.meta.env.VITE_API ?? (import.meta.env.DEV ? 'mock' : 'http')) === 'mock';
