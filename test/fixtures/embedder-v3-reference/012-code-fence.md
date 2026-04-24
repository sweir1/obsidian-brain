SQLite-vec stores vectors as raw blobs inside a virtual table:

```sql
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding FLOAT[384]
);

-- Insert
INSERT INTO vec_chunks(chunk_id, embedding)
VALUES (42, vec_f32('[0.1, -0.2, 0.3, ...]'));

-- KNN query
SELECT chunk_id, distance
FROM vec_chunks
WHERE embedding MATCH vec_f32('[0.05, -0.18, 0.28, ...]')
ORDER BY distance
LIMIT 10;
```

The `vec_f32()` function serialises a JSON array into the compact binary format that sqlite-vec expects.
