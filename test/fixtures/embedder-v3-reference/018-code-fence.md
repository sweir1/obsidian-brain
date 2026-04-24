Gray-matter parses YAML front matter from Markdown files:

```typescript
import matter from 'gray-matter';

const raw = `---
title: My Note
tags: [machine-learning, embeddings]
---
This is the body of the note.`;

const { data, content } = matter(raw);
// data  === { title: 'My Note', tags: ['machine-learning', 'embeddings'] }
// content === '\nThis is the body of the note.'
```

The `content` string includes the trailing newline after the closing `---` delimiter. Strip it with `.trimStart()` if you want clean body text.
