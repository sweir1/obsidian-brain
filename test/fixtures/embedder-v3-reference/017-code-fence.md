Vitest's `test.skipIf` utility lets you conditionally skip tests without removing them:

```typescript
import { test, expect } from 'vitest';

const hasGpu = !!process.env.GPU_AVAILABLE;

test.skipIf(!hasGpu)('GPU accelerated inference', async () => {
  const result = await runOnGpu('hello');
  expect(result).toBeDefined();
});
```

The condition is evaluated at module load time, before the test runner collects suites. A skipped test appears in the report but does not count as a failure, preserving CI green status while signalling the gap to developers.
