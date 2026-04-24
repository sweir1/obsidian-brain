# Embedding Models

## Architecture

Sentence embedding models typically use a BERT-style encoder backbone with mean pooling over the final hidden states. The output is a fixed-size vector regardless of input length, up to the model's maximum sequence length.

## Training Objectives

### Contrastive Loss

Contrastive training pairs semantically similar sentences as positives and dissimilar ones as negatives, pushing the model to cluster similar meanings in vector space.

### Multiple Negatives Ranking

MNR loss treats other sentences in the same batch as implicit negatives, scaling well to large batch sizes without explicit negative mining.
