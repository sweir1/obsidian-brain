export interface SentenceTransformersModule {
  idx: number;
  name: string;
  path: string;
  type: string;
}

export interface HfTreeFile {
  type: string;
  path: string;
  size: number;
}

export interface ConfigJson {
  hidden_size?: number;
  d_model?: number;
  n_embd?: number;
  n_embed?: number;
  max_position_embeddings?: number;
  n_positions?: number;
  max_trained_positions?: number;
  model_type?: string;
  num_hidden_layers?: number;
  num_layers?: number;
  n_layer?: number;
}

export interface PromptsBlock {
  prompts?: { query?: string; document?: string; passage?: string };
}

export interface DenseConfig {
  in_features?: number;
  out_features?: number;
}
