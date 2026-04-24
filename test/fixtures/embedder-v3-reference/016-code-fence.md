Graphology community detection with the Louvain algorithm:

```typescript
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

const graph = new Graph({ type: 'undirected' });
graph.addNode('A'); graph.addNode('B'); graph.addNode('C');
graph.addEdge('A', 'B'); graph.addEdge('B', 'C');

const communities = louvain(graph, { resolution: 1.0 });
// communities === { A: 0, B: 0, C: 0 } (all in one community for a path graph)
```

The `resolution` parameter controls granularity: higher values produce more, smaller communities; lower values merge nodes more aggressively.
