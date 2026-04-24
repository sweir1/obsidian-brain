The cross-entropy loss between a predicted probability distribution $\hat{p}$ and the ground truth $p$ is:

$$\mathcal{L} = -\sum_{i} p_i \log \hat{p}_i$$

For binary classification with a single positive label, this collapses to $\mathcal{L} = -\log \hat{p}_{\text{pos}}$. Minimising this loss pushes the model to assign higher probability mass to the correct class. Gradient descent updates the parameters $\theta$ as:

$$\theta \leftarrow \theta - \eta \nabla_\theta \mathcal{L}$$
