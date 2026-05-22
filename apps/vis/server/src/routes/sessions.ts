import { Hono } from 'hono';

import { pathConfig } from '../config';
import { clearSessions } from '../lib/session-delete';
import { listSessions } from '../lib/session-lister';

export function sessionsRoute(): Hono {
  const app = new Hono();
  app.get('/', async (c) => {
    try {
      const summaries = await listSessions(pathConfig.sessionsDir);
      return c.json(summaries);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `failed to list sessions: ${msg}`, code: 'READ_ERROR' }, 500);
    }
  });
  app.delete('/', async (c) => {
    try {
      const result = await clearSessions();
      return c.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `failed to clear sessions: ${msg}`, code: 'DELETE_ERROR' }, 500);
    }
  });
  return app;
}
