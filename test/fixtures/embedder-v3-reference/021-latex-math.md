The attention mechanism in transformer models computes a weighted sum of value vectors, where the weights come from a softmax over scaled dot-products between queries and keys:

$$\text{Attention}(Q, K, V) = \text{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}}\right) V$$

The scaling factor $\frac{1}{\sqrt{d_k}}$ prevents the dot products from growing too large in high-dimensional spaces, which would push the softmax into regions of extremely small gradients.
