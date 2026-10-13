import { onCLS, onFID, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';

export type ReportHandler = (metric: Metric) => void;

const defaultHandler: ReportHandler = (metric) => {
  if (process.env['NODE_ENV'] !== 'production') {
    console.log(`[Web Vitals] ${metric.name}:`, metric.value);
  }
};

export function reportWebVitals(onReport: ReportHandler | undefined) {
  if (typeof window === 'undefined') return;

  const handler: ReportHandler = onReport ?? defaultHandler;
  const supportsINP =
    'PerformanceObserver' in window &&
    Array.isArray(PerformanceObserver.supportedEntryTypes) &&
    PerformanceObserver.supportedEntryTypes.includes('event');

  onCLS(handler);
  onLCP(handler);
  onTTFB(handler);

  if (supportsINP) {
    onINP(handler);
  } else {
    onFID(handler);
  }
}
