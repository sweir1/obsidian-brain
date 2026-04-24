Quantization dtype comparison for transformer inference:

| dtype | Bits | Size vs fp32 | Accuracy Loss | Use Case                  |
|-------|------|-------------|---------------|---------------------------|
| fp32  | 32   | 1×          | None          | Training, reference       |
| fp16  | 16   | 0.5×        | Minimal       | GPU inference             |
| bf16  | 16   | 0.5×        | Minimal       | GPU inference (modern)    |
| q8    | 8    | 0.25×       | Low           | CPU inference, default    |
| q4    | 4    | 0.125×      | Moderate      | Constrained memory        |
| q4f16 | 4+16 | ~0.2×      | Low–Moderate  | Mixed precision           |

Q8 is the recommended choice for offline consumer hardware, balancing model size with retrieval quality.
