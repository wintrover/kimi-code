import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kimi-core',
    include: ['test/**/*.{test,e2e}.ts', 'src/**/__tests__/**/*.test.ts'],
  },
});
