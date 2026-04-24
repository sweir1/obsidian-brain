Reading a JSONL file line by line in Node.js without loading the whole thing into memory:

```typescript
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

async function* readJsonlLines<T>(filePath: string): AsyncGenerator<T> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim()) yield JSON.parse(line) as T;
  }
}
```

The `crlfDelay: Infinity` option prevents readline from treating a CR followed by a delayed LF as two separate line endings, which matters for files created on Windows.
