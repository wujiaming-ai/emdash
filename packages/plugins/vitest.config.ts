import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@emdash/agent-events': fileURLToPath(
        new URL('./src/agents/helpers/activity-events.ts', import.meta.url)
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
  },
});
