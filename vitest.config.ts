import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['backend/test/**/*.test.ts', 'test/**/*.test.ts'], environment: 'node' },
});
