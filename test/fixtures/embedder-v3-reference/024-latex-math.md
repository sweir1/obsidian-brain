Principal Component Analysis finds the directions of maximum variance in data. Given a centered data matrix $X \in \mathbb{R}^{n \times d}$, compute the covariance matrix:

$$\Sigma = \frac{1}{n-1} X^\top X$$

The eigenvectors of $\Sigma$ are the principal components. The fraction of variance explained by the first $k$ components is:

$$\text{EVR}_k = \frac{\sum_{i=1}^{k} \lambda_i}{\sum_{i=1}^{d} \lambda_i}$$

where $\lambda_i$ are the eigenvalues sorted in descending order.
