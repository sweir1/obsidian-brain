Graph centrality metrics and their computational complexity:

| Metric              | Complexity       | Interpretation                              |
|---------------------|------------------|---------------------------------------------|
| Degree centrality   | O(V + E)         | Number of direct connections                |
| Betweenness         | O(V · E)         | Bridge nodes on shortest paths              |
| Closeness           | O(V · (V + E))   | Average shortest path to all others         |
| Eigenvector         | O(V² · k)        | Influence via well-connected neighbours     |
| PageRank            | O(V + E) / iter  | Weighted authority propagation              |
| Harmonic centrality | O(V · (V + E))   | Handles disconnected graphs gracefully      |

`V` = vertices, `E` = edges, `k` = number of power-iteration steps.
