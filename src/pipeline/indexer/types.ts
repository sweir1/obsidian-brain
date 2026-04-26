export interface IndexStats {
  nodesIndexed: number;
  nodesSkipped: number;
  edgesIndexed: number;
  communitiesDetected: number;
  stubNodesCreated: number;
  chunksOk: number;
  chunksSkipped: number;
  notesMissingEmbeddings: number;
  /**
   * Notes whose body had nothing chunkable (frontmatter-only, embeds-only,
   * shorter than minChunkChars). v1.7.3+ embeds a title-based fallback for
   * these so they remain searchable; this counter tracks how many used the
   * fallback path. A note with truly nothing to embed (no title, no
   * frontmatter, no body) is recorded in `failed_chunks` with reason
   * `'no-embeddable-content'` and is excluded from `notesMissingEmbeddings`.
   */
  notesNoEmbeddableContent: number;
}

export interface SingleNoteResult {
  indexed: boolean;
  skipped: boolean;
  deleted: boolean;
  edgesIndexed: number;
  stubsCreated: number;
}
