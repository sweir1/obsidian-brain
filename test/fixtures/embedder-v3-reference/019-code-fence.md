Chokidar watches a directory for file system changes with debouncing:

```typescript
import chokidar from 'chokidar';

const watcher = chokidar.watch('/path/to/vault', {
  ignored: /(^|[/\\])\../,   // ignore dotfiles
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
});

watcher
  .on('add',    (path) => console.log(`Added: ${path}`))
  .on('change', (path) => console.log(`Changed: ${path}`))
  .on('unlink', (path) => console.log(`Removed: ${path}`));
```

`awaitWriteFinish` waits until the file size is stable before emitting the event, preventing partial-read races during large saves.
