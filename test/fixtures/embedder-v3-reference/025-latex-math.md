The BM25 ranking function scores document $D$ for query $Q = \{q_1, \ldots, q_n\}$:

$$\text{BM25}(D, Q) = \sum_{i=1}^{n} \text{IDF}(q_i) \cdot \frac{f(q_i, D) \cdot (k_1 + 1)}{f(q_i, D) + k_1 \cdot \left(1 - b + b \cdot \frac{|D|}{\text{avgdl}}\right)}$$

where $f(q_i, D)$ is term frequency, $|D|$ is document length, $\text{avgdl}$ is average document length, and $k_1 \in [1.2, 2.0]$, $b = 0.75$ are tuning parameters.
