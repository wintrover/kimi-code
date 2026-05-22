import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { resolveHost, resolveVisAuthToken } from '../src/config';
import { formatStartupBanner } from '../src/startup-banner';

describe('vis server access controls', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('binds to loopback by default', () => {
    delete process.env['VIS_HOST'];
    delete process.env['HOST'];

    expect(resolveHost()).toBe('127.0.0.1');
  });

  it('allows an explicit bind host', () => {
    process.env['VIS_HOST'] = '0.0.0.0';

    expect(resolveHost()).toBe('0.0.0.0');
  });

  it('requires a token when binding outside loopback', () => {
    delete process.env['VIS_AUTH_TOKEN'];

    expect(() => resolveVisAuthToken('0.0.0.0')).toThrow(/VIS_AUTH_TOKEN/);

    process.env['VIS_AUTH_TOKEN'] = 'secret-token';
    expect(resolveVisAuthToken('0.0.0.0')).toBe('secret-token');
  });

  it('requires bearer auth for API routes when a token is configured', async () => {
    const app = await createApp({ authToken: 'secret-token' });

    const anonymous = await app.request('/api/sessions');
    expect(anonymous.status).toBe(401);
    await expect(anonymous.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' });

    const wrong = await app.request('/api/sessions', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(wrong.status).toBe(401);

    const allowed = await app.request('/api/sessions', {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(allowed.status).toBe(200);
  });

  it('keeps loopback-only local API access open when no token is configured', async () => {
    const app = await createApp();

    const response = await app.request('/api/sessions');

    expect(response.status).toBe(200);
  });

  it('does not include the bearer token in the startup banner', () => {
    const banner = formatStartupBanner({
      authToken: 'secret-token',
      host: '127.0.0.1',
      kimiCodeHome: '/tmp/kimi-code',
      port: 3001,
    });

    expect(banner).toContain('auth=required');
    expect(banner).not.toContain('secret-token');
    expect(banner).not.toContain('token=');
  });
});
