Zod schema for validating embedding configuration from environment variables:

```typescript
import { z } from 'zod';

const EmbedConfigSchema = z.object({
  model: z.string().min(1),
  dtype: z.enum(['fp32', 'fp16', 'q8', 'q4']).default('q8'),
  maxTokens: z.coerce.number().int().positive().max(512).default(256),
  batchSize: z.coerce.number().int().min(1).max(64).default(8),
});

type EmbedConfig = z.infer<typeof EmbedConfigSchema>;

const config: EmbedConfig = EmbedConfigSchema.parse({
  model: process.env.EMBEDDING_MODEL,
  dtype: process.env.EMBEDDING_DTYPE,
});
```

`z.coerce.number()` converts environment variable strings to numbers automatically before validation.
