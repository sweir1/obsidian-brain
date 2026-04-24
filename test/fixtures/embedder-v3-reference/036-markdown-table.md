Comparison of embedding model presets available in obsidian-brain:

| Preset        | Model                          | Size (MB) | Language      | Symmetric |
|---------------|--------------------------------|-----------|---------------|-----------|
| english       | Xenova/bge-small-en-v1.5       | 34        | English       | No        |
| fastest       | Xenova/paraphrase-MiniLM-L3-v2 | 17        | English       | Yes       |
| balanced      | Xenova/all-MiniLM-L6-v2        | 23        | English       | Yes       |
| multilingual  | Xenova/multilingual-e5-small   | 135       | Multilingual  | No        |

Asymmetric models (Symmetric = No) require different prefixes for queries versus documents. Symmetric models use the same representation for both.
