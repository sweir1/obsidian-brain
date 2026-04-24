# Retrieval Pipeline

## Indexing Phase

### Chunking

Documents are split into overlapping chunks. Each chunk is embedded independently, allowing fine-grained retrieval of relevant passages rather than entire documents.

### Storage

Chunk vectors are stored in a vec0 virtual table alongside their source document ID and character offset, enabling reconstruction of the original context window.

## Query Phase

The query is embedded with the same model and a nearest-neighbour search returns the top-k most similar chunks.
