import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['*.ts'],
      exclude: ['clawplay-cli.ts', 'review.ts', 'types.ts', 'vitest.config.ts', 'dist/**', 'build/**', 'staged/**', 'scripts/**', 'test/**'],
      thresholds: {
        lines: 60,
        functions: 50,
      },
    },
  },
});
