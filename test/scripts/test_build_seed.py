"""
Unit tests for `scripts/build-seed.py`.

Pure-logic tests using stdlib `unittest` — no `mteb` import required, no
network calls, no temp files. Constructs fake `ModelMeta`-shaped objects
and runs them through the filter/extract helpers directly.

Why this matters: build-seed.py produces the bundled `data/seed-models.json`
that ships in every npm tarball. A bug in its filter or prompt-extraction
logic ships wrong prefixes / max_tokens to thousands of installs. The
audits in v1.7.5 confirmed wrong values cause real damage (silent
retrieval degradation, mass chunk-skip on reindex). Vitest covers the
seed *output* (`test/embeddings/seed-loader.test.ts` reads the committed
anchor and asserts shape + canonical-preset prefixes); these Python
tests cover the *generator* itself.

Run locally: `npm run test:python` (or directly:
`python3 -m unittest discover -s test/scripts -p 'test_*.py'`).

The build-seed module imports `mteb` lazily inside `main()`, so importing
the helpers does NOT require the package — these tests run on stock
Python with no venv setup.
"""
from __future__ import annotations

import importlib.util
import json
import math
import sys
import unittest
from pathlib import Path
from typing import Any


# Load `scripts/build-seed.py` as a module without putting `scripts/` on
# sys.path (avoids polluting the import namespace and lets us name the
# module unambiguously).
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_SCRIPT_PATH = _REPO_ROOT / "scripts" / "build-seed.py"
_spec = importlib.util.spec_from_file_location("build_seed", _SCRIPT_PATH)
assert _spec is not None and _spec.loader is not None, f"could not load {_SCRIPT_PATH}"
build_seed = importlib.util.module_from_spec(_spec)
sys.modules["build_seed"] = build_seed
_spec.loader.exec_module(build_seed)


class FakeMeta:
    """Mimics the subset of `mteb.ModelMeta` build-seed.py reads.

    Real ModelMeta is a frozen dataclass; we duck-type with attribute
    access to keep tests free of the mteb dependency.
    """

    def __init__(
        self,
        name: str | None = "owner/model",
        max_tokens: float | int | None = 512,
        open_weights: bool | None = True,
        modalities: list[str] | None = None,
        model_type: list[str] | None = None,
        loader_kwargs: dict[str, Any] | None = None,
    ) -> None:
        self.name = name
        self.max_tokens = max_tokens
        self.open_weights = open_weights
        self.modalities = modalities if modalities is not None else ["text"]
        self.model_type = model_type if model_type is not None else ["dense"]
        self.loader_kwargs = loader_kwargs or {}


# ---------------------------------------------------------------------------
# is_dense_text_open_weights — keep/skip filter
# ---------------------------------------------------------------------------

class FilterTests(unittest.TestCase):
    def test_keeps_a_typical_dense_text_open_weights_model(self) -> None:
        keep, reason = build_seed.is_dense_text_open_weights(FakeMeta())
        self.assertTrue(keep)
        self.assertEqual(reason, "ok")

    def test_drops_models_with_no_name(self) -> None:
        keep, reason = build_seed.is_dense_text_open_weights(FakeMeta(name=None))
        self.assertFalse(keep)
        self.assertEqual(reason, "no-name")

    def test_drops_closed_weights(self) -> None:
        keep, reason = build_seed.is_dense_text_open_weights(FakeMeta(open_weights=False))
        self.assertFalse(keep)
        self.assertEqual(reason, "closed-weights")

    def test_drops_multimodal_image(self) -> None:
        keep, reason = build_seed.is_dense_text_open_weights(
            FakeMeta(modalities=["text", "image"]),
        )
        self.assertFalse(keep)
        self.assertEqual(reason, "multimodal")

    def test_drops_multimodal_audio(self) -> None:
        keep, reason = build_seed.is_dense_text_open_weights(FakeMeta(modalities=["audio"]))
        self.assertFalse(keep)
        self.assertEqual(reason, "multimodal")

    def test_drops_non_dense_sparse(self) -> None:
        keep, reason = build_seed.is_dense_text_open_weights(FakeMeta(model_type=["sparse"]))
        self.assertFalse(keep)
        self.assertTrue(reason.startswith("non-dense"))

    def test_drops_late_interaction_by_name(self) -> None:
        keep, reason = build_seed.is_dense_text_open_weights(
            FakeMeta(name="owner/colbertv2", model_type=["dense"]),
        )
        self.assertFalse(keep)
        self.assertEqual(reason, "multi-vector")

    def test_drops_static_embedding_with_inf_max_tokens(self) -> None:
        # model2vec / potion / NeuML pubmedbert-embeddings family — MTEB
        # encodes them with max_tokens=inf because they sum/average
        # precomputed token vectors with no real input limit.
        keep, reason = build_seed.is_dense_text_open_weights(
            FakeMeta(name="minishlab/potion-base-8M", max_tokens=math.inf),
        )
        self.assertFalse(keep)
        self.assertEqual(reason, "static-embedding")


# ---------------------------------------------------------------------------
# extract_entry — pull the load-bearing fields out
# ---------------------------------------------------------------------------

class ExtractTests(unittest.TestCase):
    def test_asymmetric_bge_style_dict_with_query_and_empty_doc(self) -> None:
        meta = FakeMeta(
            name="BAAI/bge-small-en-v1.5",
            max_tokens=512,
            loader_kwargs={
                "model_prompts": {
                    "query": "Represent this sentence for searching relevant passages: ",
                },
            },
        )
        entry, reason = build_seed.extract_entry(meta)
        self.assertIsNone(reason)
        self.assertEqual(entry["maxTokens"], 512)
        self.assertEqual(
            entry["queryPrefix"],
            "Represent this sentence for searching relevant passages: ",
        )
        # Asymmetric models that only declare a `query` key get an empty
        # string on the document side — NOT null. Downstream embed() always
        # concatenates a prefix.
        self.assertEqual(entry["documentPrefix"], "")

    def test_asymmetric_e5_style_dict_with_query_and_passage(self) -> None:
        # e5_models.py uses PromptType.query.value as keys. PromptType is
        # a str enum so the runtime key is the string "query". The dict
        # we receive has document="passage: " stored under the literal
        # key "document" (since PromptType.document.value == "document").
        meta = FakeMeta(
            name="intfloat/multilingual-e5-small",
            max_tokens=512,
            loader_kwargs={
                "model_prompts": {"query": "query: ", "document": "passage: "},
            },
        )
        entry, reason = build_seed.extract_entry(meta)
        self.assertIsNone(reason)
        self.assertEqual(entry["queryPrefix"], "query: ")
        self.assertEqual(entry["documentPrefix"], "passage: ")

    def test_falls_back_to_passage_key_when_document_missing(self) -> None:
        # Some older sentence-transformer configs use "passage" as the
        # document-side key. Both should resolve to documentPrefix.
        meta = FakeMeta(
            loader_kwargs={"model_prompts": {"query": "q: ", "passage": "p: "}},
        )
        entry, reason = build_seed.extract_entry(meta)
        self.assertIsNone(reason)
        self.assertEqual(entry["queryPrefix"], "q: ")
        self.assertEqual(entry["documentPrefix"], "p: ")

    def test_symmetric_model_with_no_prompts_returns_null_prefixes(self) -> None:
        # bge-m3, all-MiniLM-L6-v2 etc. — symmetric; no model_prompts in
        # loader_kwargs. The runtime treats null prefixes as no-op (see
        # metadata-resolver materialise() which coerces null→'').
        meta = FakeMeta(name="BAAI/bge-m3", max_tokens=8194)
        entry, reason = build_seed.extract_entry(meta)
        self.assertIsNone(reason)
        self.assertIsNone(entry["queryPrefix"])
        self.assertIsNone(entry["documentPrefix"])

    def test_max_tokens_none_skips_with_no_max_tokens_reason(self) -> None:
        meta = FakeMeta(max_tokens=None)
        entry, reason = build_seed.extract_entry(meta)
        self.assertIsNone(entry)
        self.assertEqual(reason, "no-max-tokens")

    def test_max_tokens_zero_or_negative_skips(self) -> None:
        for bad in (0, -1):
            meta = FakeMeta(max_tokens=bad)
            entry, reason = build_seed.extract_entry(meta)
            self.assertIsNone(entry, f"expected skip for max_tokens={bad}")
            self.assertEqual(reason, "max-tokens-non-positive")

    def test_max_tokens_float_is_floored_to_int(self) -> None:
        # MTEB stores max_tokens as float | None. multilingual-e5-base
        # has max_tokens=514.0 in the registry — verify int coercion.
        meta = FakeMeta(max_tokens=514.0)
        entry, reason = build_seed.extract_entry(meta)
        self.assertIsNone(reason)
        self.assertEqual(entry["maxTokens"], 514)
        self.assertIsInstance(entry["maxTokens"], int)

    def test_non_string_prompt_value_is_treated_as_missing(self) -> None:
        # Defensive: if some niche family passes a callable or list as
        # the prompt value (unusual but possible), don't ship garbage —
        # treat as null.
        meta = FakeMeta(
            loader_kwargs={
                "model_prompts": {"query": ["wrong shape"], "document": 42},
            },
        )
        entry, reason = build_seed.extract_entry(meta)
        self.assertIsNone(reason)
        self.assertIsNone(entry["queryPrefix"])
        self.assertIsNone(entry["documentPrefix"])


# ---------------------------------------------------------------------------
# ALIASES table — Xenova / Ollama-tag aliases
# ---------------------------------------------------------------------------

class AliasTableTests(unittest.TestCase):
    """Verify the hand-curated alias table has the right shape and covers
    every canonical preset id obsidian-brain ships."""

    EXPECTED_ALIASES = {
        "Xenova/bge-small-en-v1.5": "BAAI/bge-small-en-v1.5",
        "Xenova/bge-base-en-v1.5": "BAAI/bge-base-en-v1.5",
        "Xenova/bge-large-en-v1.5": "BAAI/bge-large-en-v1.5",
        "Xenova/multilingual-e5-small": "intfloat/multilingual-e5-small",
        "Xenova/multilingual-e5-base": "intfloat/multilingual-e5-base",
        "Xenova/multilingual-e5-large": "intfloat/multilingual-e5-large",
        "bge-m3": "BAAI/bge-m3",
    }

    def test_every_canonical_preset_alias_is_declared(self) -> None:
        for alias, expected_upstream in self.EXPECTED_ALIASES.items():
            self.assertIn(alias, build_seed.ALIASES, f"alias {alias} missing")
            actual_upstream, _overrides = build_seed.ALIASES[alias]
            self.assertEqual(
                actual_upstream,
                expected_upstream,
                f"alias {alias} points at {actual_upstream}, expected {expected_upstream}",
            )

    def test_alias_table_has_no_unexpected_entries(self) -> None:
        # If someone adds a new alias, the test fails here so they must
        # also update EXPECTED_ALIASES + the runtime preset list. Forces
        # an explicit "yes I meant to add this."
        self.assertEqual(
            set(build_seed.ALIASES.keys()),
            set(self.EXPECTED_ALIASES.keys()),
        )


class NormalizePromptTemplateTests(unittest.TestCase):
    """`_normalize_prompt_template` converts MTEB's `{text}` placeholder
    templates into plain prepend-prefixes so the seed never ships a
    literal-`{text}` string that would get embedded as part of the prompt."""

    def test_plain_prefix_passes_through_unchanged(self) -> None:
        self.assertEqual(
            build_seed._normalize_prompt_template("search_query: "),
            "search_query: ",
        )

    def test_trailing_text_placeholder_is_stripped(self) -> None:
        # The canonical MTEB pattern: prefix + {text} → strip {text}, the
        # remaining string is a plain prepend-prefix.
        self.assertEqual(
            build_seed._normalize_prompt_template(
                "Represent this sentence for searching relevant passages: {text}",
            ),
            "Represent this sentence for searching relevant passages: ",
        )

    def test_no_separator_before_placeholder_still_strips_cleanly(self) -> None:
        self.assertEqual(
            build_seed._normalize_prompt_template("prefix:{text}"),
            "prefix:",
        )

    def test_non_trailing_placeholder_returns_None(self) -> None:
        # `{text}` in the middle can't be expressed as a plain prepend-prefix.
        # We drop the prompt entirely (return None) so the caller treats it
        # as missing and falls back to live HF / safe defaults.
        self.assertIsNone(
            build_seed._normalize_prompt_template("Q: {text} →"),
        )
        self.assertIsNone(
            build_seed._normalize_prompt_template("{text} matters"),
        )

    def test_extracted_entries_never_contain_text_placeholder(self) -> None:
        # Belt-and-braces: walk the live committed seed and assert no
        # entry has a literal `{text}` in either prefix. Regression guard
        # for the WhereIsAI/UAE-Large-V1 footgun where MTEB's template
        # ended with `{text}` and we shipped it verbatim.
        from pathlib import Path
        seed_path = (
            Path(__file__).resolve().parent.parent.parent / "data" / "seed-models.json"
        )
        with seed_path.open("r", encoding="utf-8") as fh:
            seed = json.load(fh)
        offenders = []
        for model_id, entry in seed.get("models", {}).items():
            for field in ("queryPrefix", "documentPrefix"):
                value = entry.get(field)
                if isinstance(value, str) and "{text}" in value:
                    offenders.append(f"{model_id}.{field}: {value!r}")
        self.assertEqual(
            offenders,
            [],
            f"seed contains literal {{text}} placeholders that build-seed.py "
            f"should have normalized:\n  " + "\n  ".join(offenders),
        )


if __name__ == "__main__":
    unittest.main()
