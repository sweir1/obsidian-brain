Performance characteristics of vector search algorithms:

| Algorithm | Build Time | Query Time | Memory      | Accuracy |
|-----------|------------|------------|-------------|----------|
| Brute KNN | O(1)       | O(n·d)     | O(n·d)      | Exact    |
| IVF       | O(n·d)     | O(n/k · d) | O(n·d)      | ~95%     |
| HNSW      | O(n log n) | O(log n)   | O(n · M·d)  | ~99%     |
| LSH       | O(n·d)     | O(n^0.5)   | O(n·L)      | ~90%     |

`n` = number of vectors, `d` = dimension, `k` = number of clusters, `M` = HNSW connectivity parameter, `L` = number of hash tables.
