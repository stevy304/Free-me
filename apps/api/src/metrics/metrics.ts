import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics. Each process (API instance, worker) has its own registry with the process's own numbers
 * (memory, CPU, event-loop lag) and what it does. Prometheus, or a free hosted collector, reads them every 15-60 s
 * with the METRICS_TOKEN; see MONITORING.md for the dashboards and alerts built on them.
 */
export const METRICS = Symbol('METRICS');

export function createRegistry(service: 'api' | 'worker'): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry, prefix: 'freeme_' });
  return registry;
}

/** Bearer token check without leaking its length or content through timing. */
export function tokenMatches(header: string | undefined, token: string | null): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Counts every API request and how long it took, by route pattern (`/api/videos/:id`, never the id itself, so
 * the number of series stays small) and status code. Health checks and the metrics endpoint are left out.
 */
export function httpMetrics(registry: Registry) {
  const requests = new Counter({ name: 'freeme_http_requests_total', help: 'API requests', labelNames: ['method', 'route', 'status'] as const, registers: [registry] });
  const duration = new Histogram({ name: 'freeme_http_request_duration_seconds', help: 'API response time', labelNames: ['method', 'route'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry] });
  return (req: Request, res: Response, next: NextFunction) => {
    const end = duration.startTimer();
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : 'unmatched';
      if (route === '/api/health' || route === '/api/metrics') return;
      const labels = { method: req.method, route };
      end(labels);
      requests.inc({ ...labels, status: String(res.statusCode) });
    });
    next();
  };
}
