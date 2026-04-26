// src/embeddings/hf-metadata.ts
export {
  getEmbeddingMetadata,
  DEFAULT_HF_TIMEOUT_MS,
  DEFAULT_HF_RETRIES,
} from './hf-metadata/index.js';
export type {
  HfMetadata,
  HfMetadataOptions,
  Dtype,
  PrefixSource,
} from './hf-metadata/index.js';
export {
  extractBaseModel,
  detectModelLanguage,
  detectPrefixScript,
  languageToScript,
  resolvePromptsFromReadme,
} from './hf-metadata/readme.js';
