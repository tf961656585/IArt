import type { HubStatusPresenter } from '../types';

export const createStatusPresenter = (): HubStatusPresenter => ({
  set(element, message) {
    if (!element) return;
    element.textContent = message || '';
  },
});
