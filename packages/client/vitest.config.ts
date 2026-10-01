import { defineConfig } from 'vitest/config';
// Each integration file owns the same local workerd port. Never run them concurrently.
export default defineConfig({ test: { fileParallelism: false } });
