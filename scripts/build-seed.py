#!/usr/bin/env python3
"""
Build the bundled seed JSON at `data/seed-models.json` (v1.7.5+, schema v2).

Walks the in-process `mteb` package's ModelMeta registry and dumps every
open-weights, dense, text-only entry to JSON. Three load-bearing fields per
entry — `maxTokens`, `queryPrefix`, `documentPrefix`. Everything else
(`dim`, `sizeBytes`, `prefixSource`, `modelType`, `baseModel`,
`hasDenseLayer`, `hasNormalize`, `runnableViaTransformersJs`) was dropped
from schema v2 because it's display-only — runtime probes `dim` from the
loaded ONNX, and the rest is informational.

**Why Python, not Node**: the prompt strings live inside MTEB's
`loader_kwargs={"model_prompts": ...}` dict. Different family files use
different key formats — `bge_models.py` uses literal `"query"` strings;
`e5_models.py` uses `PromptType.query.value` enum lookups (PromptType is
a str enum so the runtime key is still `"query"`). Importing the actual
Python registry resolves both forms uniformly. Pure-JS regex extraction
would have to hand-resolve the enum and falls down on conditional dict
construction.

**Zero HF API calls**. Replaces the v1 `scripts/build-seed.mjs` that fired
~5,500 HF requests per release-time run and routinely tripped HF rate
limits (anonymous: 500 / 5min; free token: 1,000 / 5min).

Local invocation: `python3 scripts/build-seed.py`. Requires `pip install
mteb` (pinned in CI; see `.github/workflows/release.yml`). Refreshing the
seed is opt-in — releases pick up whatever's currently committed unless
the workflow regenerates it.

Failure modes:
  - `import mteb` fails → exit 1.
  - Output file write fails → exit 1.
  - A specific model raises during extraction → log to stderr, skip that
    entry, continue. Per-model failures never abort the whole run.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

# Schema version of the JSON we write. Bumped from v1 (the Node build script)
# to v2 here. `src/embeddings/seed-loader.ts` reads both v1 and v2 (v1 entries
# get adapted on load) so the committed v1 anchor doesn't break in development
# the moment this script lands.
SCHEMA_VERSION = 2

# Hand-curated aliases for ids that don't appear in MTEB's registry but our
# presets reference. Each entry: alias_id → (upstream_mteb_id, override_dict).
# `override_dict` lets us correct for models where the alias differs from the
# upstream (e.g. a different max_tokens). Empty dict = pure copy.
#
# bge-m3 here is the Ollama-side tag, NOT an HF id. The string has no `/`
# separator on purpose; the runtime treats it as an Ollama model. We seed
# its prompts/max-tokens by pointing at BAAI/bge-m3 in MTEB.
ALIASES: dict[str, tuple[str, dict[str, object]]] = {
    "Xenova/bge-small-en-v1.5": ("BAAI/bge-small-en-v1.5", {}),
    "Xenova/bge-base-en-v1.5": ("BAAI/bge-base-en-v1.5", {}),
    "Xenova/bge-large-en-v1.5": ("BAAI/bge-large-en-v1.5", {}),
    "Xenova/multilingual-e5-small": ("intfloat/multilingual-e5-small", {}),
    "Xenova/multilingual-e5-base": ("intfloat/multilingual-e5-base", {}),
    "Xenova/multilingual-e5-large": ("intfloat/multilingual-e5-large", {}),
    # Ollama-side tag: pulled by `ollama pull bge-m3`. The runtime detects the
    # missing `/` and routes to the Ollama embedder rather than transformers.js.
    "bge-m3": ("BAAI/bge-m3", {}),
}


def log(msg: str) -> None:
    print(f"build-seed: {msg}", file=sys.stderr, flush=True)


def is_dense_text_open_weights(meta) -> tuple[bool, str]:
    """Decide if a ModelMeta belongs in the seed. Returns (keep, reason)."""
    if not meta.name:
        return False, "no-name"
    if meta.open_weights is False:
        return False, "closed-weights"
    modalities = getattr(meta, "modalities", None) or ["text"]
    if any(m in ("image", "audio", "video") for m in modalities):
        return False, "multimodal"
    model_types = getattr(meta, "model_type", None) or ["dense"]
    if "dense" not in model_types:
        return False, f"non-dense({','.join(model_types)})"
    # ColBERT / late-interaction can also surface as dense; reject by name.
    name_lower = meta.name.lower()
    if "colbert" in name_lower or "late-interaction" in name_lower:
        return False, "multi-vector"
    return True, "ok"


def extract_entry(meta) -> dict[str, object] | None:
    """Pull the three load-bearing fields out of a ModelMeta. None on failure."""
    try:
        max_tokens_raw = meta.max_tokens
        if max_tokens_raw is None:
            # Bound: every modern sentence-transformer encoder has a
            # documented max_tokens. Skip rather than guess.
            return None
        max_tokens = int(float(max_tokens_raw))
        if max_tokens <= 0:
            return None

        loader_kwargs = meta.loader_kwargs or {}
        model_prompts = loader_kwargs.get("model_prompts")
        query_prefix: str | None = None
        document_prefix: str | None = None
        if isinstance(model_prompts, dict):
            # Both literal "query" and PromptType.query.value (a str enum)
            # resolve to the runtime key "query"; same for "document". Some
            # E5-style configs use "passage" instead of "document".
            q = model_prompts.get("query")
            d = model_prompts.get("document")
            if d is None:
                d = model_prompts.get("passage")
            if isinstance(q, str):
                query_prefix = q
            if isinstance(d, str):
                document_prefix = d
            # Asymmetric models that only declare a `query` key still need
            # an empty string on the document side for downstream code that
            # always concats a prefix (see embedder.embed). Mirror MTEB:
            # the absence of a document prompt means the document side is
            # left untouched, i.e. empty string, NOT null.
            if query_prefix is not None and document_prefix is None:
                document_prefix = ""

        return {
            "maxTokens": max_tokens,
            "queryPrefix": query_prefix,
            "documentPrefix": document_prefix,
        }
    except Exception as err:  # noqa: BLE001
        log(f"failed to extract {getattr(meta, 'name', '?')}: {err}")
        return None


def main() -> int:
    try:
        import mteb  # noqa: WPS433
    except ImportError as err:
        log(f"could not import mteb: {err}. Install with `pip install mteb`.")
        return 1

    log(f"using mteb {mteb.__version__}")
    metas = mteb.get_model_metas()
    log(f"got {len(metas)} ModelMeta entries from registry")

    out: dict[str, dict[str, object]] = {}
    skipped: dict[str, int] = {}

    for meta in metas:
        keep, reason = is_dense_text_open_weights(meta)
        if not keep:
            skipped[reason] = skipped.get(reason, 0) + 1
            continue
        entry = extract_entry(meta)
        if entry is None:
            skipped["extract-failed"] = skipped.get("extract-failed", 0) + 1
            continue
        # Last-write wins on duplicate names. MTEB has none currently but be
        # explicit so the seed doesn't depend on iteration order.
        out[meta.name] = entry

    log(f"kept {len(out)}; skipped {sum(skipped.values())} ({skipped})")

    # Apply hardcoded aliases. Each alias copies its upstream entry verbatim
    # then layers any per-alias overrides. Skip silently if the upstream
    # isn't in the registry (rare; would mean MTEB dropped a model we still
    # ship a preset for — flag for the maintainer but don't crash CI).
    alias_added = 0
    alias_skipped = 0
    for alias_id, (upstream_id, overrides) in ALIASES.items():
        upstream = out.get(upstream_id)
        if upstream is None:
            log(f"alias {alias_id} → {upstream_id}: upstream not in MTEB; skipping")
            alias_skipped += 1
            continue
        merged = {**upstream, **overrides}
        out[alias_id] = merged
        alias_added += 1
    log(f"aliases: {alias_added} added; {alias_skipped} skipped (upstream missing)")

    # Sort by id for stable diffs.
    sorted_models = dict(sorted(out.items(), key=lambda kv: kv[0].lower()))

    payload = {
        "$schemaVersion": SCHEMA_VERSION,
        "$generatedAt": int(time.time() * 1000),
        "$source": f"mteb-{mteb.__version__}",
        "$comment": (
            "Generated by scripts/build-seed.py from the MTEB Python registry. "
            "Three load-bearing fields per model: maxTokens, queryPrefix, "
            "documentPrefix. Runtime probes dim from ONNX. Edit by hand only "
            "for local testing — release CI overwrites whatever is committed."
        ),
        "models": sorted_models,
    }

    repo_root = Path(__file__).resolve().parent.parent
    out_file = repo_root / "data" / "seed-models.json"
    tmp_file = out_file.with_suffix(".json.tmp")
    tmp_file.parent.mkdir(parents=True, exist_ok=True)
    with tmp_file.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False, sort_keys=False)
        fh.write("\n")
    # Atomic rename so partial writes never leave a corrupt seed.
    os.replace(tmp_file, out_file)

    log(f"wrote {len(sorted_models)} models to {out_file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
