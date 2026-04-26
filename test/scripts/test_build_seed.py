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
        "qwen3-embedding:0.6b": "Qwen/Qwen3-Embedding-0.6B",
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
    """`_normalize_prompt_template` decides which MTEB / HF prompt strings
    are shippable in the seed.

    Three buckets:
      - 0 placeholders → ship as plain prefix.
      - all placeholders are `{text}` → ship as template; runtime substitutes
        every occurrence (`replaceAll('{text}', input)`).
      - any non-`{text}` placeholder ({task}, {instruction}, ...) → return
        None. Those vars are task-conditioned at MTEB eval time and cannot
        be statically resolved at build time.
    """

    def test_plain_prefix_passes_through_unchanged(self) -> None:
        self.assertEqual(
            build_seed._normalize_prompt_template("search_query: "),
            "search_query: ",
        )

    def test_trailing_text_placeholder_kept_as_template(self) -> None:
        # Runtime substitutes via `replaceAll('{text}', input)`. The seed
        # ships the template verbatim — the placeholder is preserved, not
        # stripped (older versions stripped trailing `{text}`).
        self.assertEqual(
            build_seed._normalize_prompt_template(
                "Represent this sentence for searching relevant passages: {text}",
            ),
            "Represent this sentence for searching relevant passages: {text}",
        )

    def test_mid_string_text_placeholder_kept_as_template(self) -> None:
        # Mid-string `{text}` is fine — runtime `replaceAll` handles any
        # position, not just trailing.
        self.assertEqual(
            build_seed._normalize_prompt_template("Q: {text} →"),
            "Q: {text} →",
        )

    def test_multiple_text_placeholders_kept_as_template(self) -> None:
        # The footgun: pre-v1.7.5 logic only handled trailing `{text}`.
        # Real MTEB / HF configs use multi-`{text}` patterns like
        # "Task: {text}\nQuery: {text}". `replaceAll` substitutes all.
        template = "Task: {text}\nQuery: {text}"
        self.assertEqual(
            build_seed._normalize_prompt_template(template),
            template,
        )

    def test_non_text_placeholder_returns_none(self) -> None:
        # `{task}`, `{instruction}`, `{query}` are MTEB-eval-harness vars
        # filled per benchmark — drop entirely, the caller treats as null.
        self.assertIsNone(
            build_seed._normalize_prompt_template("Task: {task}\nQuery: "),
        )
        self.assertIsNone(
            build_seed._normalize_prompt_template("Instruction: {instruction}"),
        )

    def test_mixed_text_and_non_text_placeholder_returns_none(self) -> None:
        # Even one tainting placeholder kills the whole prompt — we can't
        # partially resolve a template.
        self.assertIsNone(
            build_seed._normalize_prompt_template("Task: {task}\nQuery: {text}"),
        )

    def test_extracted_entries_only_contain_text_placeholder(self) -> None:
        # Walk the committed seed: any `{...}` placeholder MUST be `{text}`.
        # Catches the original UAE-Large-V1 footgun (literal `{text}` was
        # the bug pre-v1.7.5 because we didn't substitute) and the new
        # footgun (a non-`{text}` placeholder slipping through means the
        # seed will ship literal `{task}`/`{instruction}` to the model).
        from pathlib import Path
        seed_path = (
            Path(__file__).resolve().parent.parent.parent / "data" / "seed-models.json"
        )
        with seed_path.open("r", encoding="utf-8") as fh:
            seed = json.load(fh)
        offenders = []
        import re as _re
        placeholder_re = _re.compile(r"\{([^{}]*)\}")
        for model_id, entry in seed.get("models", {}).items():
            for field in ("queryPrefix", "documentPrefix"):
                value = entry.get(field)
                if not isinstance(value, str):
                    continue
                for match in placeholder_re.findall(value):
                    if match != "text":
                        offenders.append(f"{model_id}.{field}: {value!r} has {{{match}}}")
        self.assertEqual(
            offenders,
            [],
            "seed contains non-{text} placeholders build-seed.py should have dropped:\n  "
            + "\n  ".join(offenders),
        )


# ---------------------------------------------------------------------------
# _fetch_hf_default_prompts — HF config_sentence_transformers.json fallback
# ---------------------------------------------------------------------------

class FetchHfDefaultPromptsTests(unittest.TestCase):
    """Mock `urllib.request.urlopen` to verify the HF fallback path without
    making any network calls. Targets the build-time recovery for MTEB
    instruction-aware models whose `model_prompts` is None (Qwen3, e5-mistral,
    snowflake-arctic, etc.) — verified live to recover ~57% of those."""

    def setUp(self) -> None:
        # Reset the in-process cache between tests so cache-hit assertions
        # don't bleed across runs.
        build_seed._HF_PROMPTS_CACHE.clear()

    def _patch_urlopen(self, body: dict | str | Exception):
        """Returns a context manager that monkey-patches urllib.request.urlopen
        for the duration of the test. `body` is JSON-serialized when dict,
        sent verbatim when str, raised when an exception."""
        from contextlib import contextmanager
        import urllib.request

        @contextmanager
        def patch():
            original = urllib.request.urlopen

            class FakeResponse:
                def __init__(self, payload: bytes):
                    self._payload = payload

                def read(self) -> bytes:
                    return self._payload

                def __enter__(self):
                    return self

                def __exit__(self, *exc) -> None:
                    return None

            def fake_urlopen(_req, timeout=None):
                if isinstance(body, Exception):
                    raise body
                payload = body if isinstance(body, str) else json.dumps(body)
                return FakeResponse(payload.encode("utf-8"))

            urllib.request.urlopen = fake_urlopen  # type: ignore[assignment]
            try:
                yield
            finally:
                urllib.request.urlopen = original  # type: ignore[assignment]

        return patch()

    def test_returns_clean_query_and_document_prompts(self) -> None:
        # The Qwen3-Embedding shape: prompts.query is the canonical
        # general-purpose retrieval default; prompts.document is "".
        body = {
            "prompts": {
                "query": "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:",
                "document": "",
            },
        }
        with self._patch_urlopen(body):
            q, d = build_seed._fetch_hf_default_prompts("Qwen/Qwen3-Embedding-0.6B")
        self.assertEqual(q, body["prompts"]["query"])
        self.assertEqual(d, "")

    def test_falls_back_to_first_task_query_key_alphabetically(self) -> None:
        # e5-mistral-instruct shape: only task-specific keys, no plain
        # "query". Pick the first `*_query` alphabetically (deterministic).
        body = {
            "prompts": {
                "web_search_query": "Instruct: Given a web search query...",
                "sts_query": "Instruct: Retrieve semantically similar text...",
                "classification_query": "Instruct: classify...",
            },
        }
        with self._patch_urlopen(body):
            q, d = build_seed._fetch_hf_default_prompts("intfloat/e5-mistral-7b-instruct")
        # alphabetical first of (classification_query, sts_query, web_search_query)
        self.assertEqual(q, "Instruct: classify...")
        # No 'document' key set → empty string (asymmetric default).
        self.assertEqual(d, "")

    def test_returns_none_none_when_prompts_missing(self) -> None:
        with self._patch_urlopen({"max_seq_length": 512}):
            q, d = build_seed._fetch_hf_default_prompts("owner/no-prompts-field")
        self.assertIsNone(q)
        self.assertIsNone(d)

    def test_returns_none_none_on_404(self) -> None:
        import urllib.error
        err = urllib.error.HTTPError(
            url="https://huggingface.co/missing/model/raw/main/config_sentence_transformers.json",
            code=404,
            msg="Not Found",
            hdrs=None,  # type: ignore[arg-type]
            fp=None,
        )
        with self._patch_urlopen(err):
            q, d = build_seed._fetch_hf_default_prompts("missing/model")
        self.assertIsNone(q)
        self.assertIsNone(d)

    def test_returns_none_none_on_invalid_json(self) -> None:
        with self._patch_urlopen("not json {"):
            q, d = build_seed._fetch_hf_default_prompts("owner/garbage")
        self.assertIsNone(q)
        self.assertIsNone(d)

    def test_caches_result_so_second_call_is_free(self) -> None:
        # First call hits urlopen; second call must NOT — verify by
        # patching urlopen to raise on second invocation.
        import urllib.request
        original = urllib.request.urlopen
        call_count = {"n": 0}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *exc) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps({"prompts": {"query": "q: ", "document": "d: "}}).encode()

        def fake_urlopen(_req, timeout=None):
            call_count["n"] += 1
            if call_count["n"] > 1:
                raise AssertionError("urlopen called twice — cache failed")
            return FakeResponse()

        urllib.request.urlopen = fake_urlopen  # type: ignore[assignment]
        try:
            q1, d1 = build_seed._fetch_hf_default_prompts("owner/cached")
            q2, d2 = build_seed._fetch_hf_default_prompts("owner/cached")
        finally:
            urllib.request.urlopen = original  # type: ignore[assignment]
        self.assertEqual(q1, "q: ")
        self.assertEqual(q2, "q: ")
        self.assertEqual(d1, "d: ")
        self.assertEqual(d2, "d: ")
        self.assertEqual(call_count["n"], 1)


# ---------------------------------------------------------------------------
# extract_entry HF fallback — instruction-aware models with no MTEB prompts
# ---------------------------------------------------------------------------

class ExtractEntryHfFallbackTests(unittest.TestCase):
    """Verify the HF fallback fires only for instruction-aware models with
    no MTEB-side prompts, and that its results flow through the same
    `_normalize_prompt_template` filter as MTEB-side prompts."""

    def setUp(self) -> None:
        build_seed._HF_PROMPTS_CACHE.clear()

    def _patch_hf(self, return_value: tuple[str | None, str | None]):
        """Monkey-patch `_fetch_hf_default_prompts` to return a fixed value
        without doing network IO. Returns a context manager."""
        from contextlib import contextmanager

        @contextmanager
        def patch():
            original = build_seed._fetch_hf_default_prompts
            build_seed._fetch_hf_default_prompts = lambda _id, timeout_s=8.0: return_value  # type: ignore[assignment]
            try:
                yield
            finally:
                build_seed._fetch_hf_default_prompts = original  # type: ignore[assignment]

        return patch()

    def test_instruction_aware_with_no_mteb_prompts_uses_hf_default(self) -> None:
        meta = FakeMeta(
            name="Qwen/Qwen3-Embedding-0.6B",
            max_tokens=32768,
            loader_kwargs={},  # no model_prompts in MTEB
        )
        meta.use_instructions = True  # type: ignore[attr-defined]
        with self._patch_hf((
            "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:",
            "",
        )):
            entry, reason = build_seed.extract_entry(meta)
        self.assertIsNone(reason)
        self.assertEqual(
            entry["queryPrefix"],
            "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:",
        )
        self.assertEqual(entry["documentPrefix"], "")

    def test_instruction_aware_with_mteb_prompts_does_not_call_hf(self) -> None:
        # If MTEB already has model_prompts.query, the HF fallback must
        # NOT fire — MTEB is the more authoritative source for that model.
        meta = FakeMeta(
            name="someone/instruction-tuned",
            max_tokens=512,
            loader_kwargs={"model_prompts": {"query": "mteb-side: "}},
        )
        meta.use_instructions = True  # type: ignore[attr-defined]
        called = {"hf": False}

        original = build_seed._fetch_hf_default_prompts
        build_seed._fetch_hf_default_prompts = (  # type: ignore[assignment]
            lambda _id, timeout_s=8.0: (called.__setitem__("hf", True) or ("nope: ", ""))
        )
        try:
            entry, _ = build_seed.extract_entry(meta)
        finally:
            build_seed._fetch_hf_default_prompts = original  # type: ignore[assignment]

        self.assertEqual(entry["queryPrefix"], "mteb-side: ")
        self.assertFalse(called["hf"], "HF fallback ran when MTEB already had a prompt")

    def test_non_instruction_aware_does_not_call_hf(self) -> None:
        # Symmetric models (use_instructions != True) stay null/null —
        # the fallback is gated specifically on instruction-aware models.
        meta = FakeMeta(name="BAAI/bge-m3", max_tokens=8194, loader_kwargs={})
        # use_instructions left unset / falsy.
        called = {"hf": False}

        original = build_seed._fetch_hf_default_prompts
        build_seed._fetch_hf_default_prompts = (  # type: ignore[assignment]
            lambda _id, timeout_s=8.0: (called.__setitem__("hf", True) or ("nope: ", ""))
        )
        try:
            entry, _ = build_seed.extract_entry(meta)
        finally:
            build_seed._fetch_hf_default_prompts = original  # type: ignore[assignment]

        self.assertIsNone(entry["queryPrefix"])
        self.assertIsNone(entry["documentPrefix"])
        self.assertFalse(called["hf"], "HF fallback ran for symmetric model")

    def test_hf_returning_non_text_placeholder_is_dropped(self) -> None:
        # Defense: HF ships `prompts.query: "Task: {task}\nQuery: "` for
        # some models — the normalize step must drop it, leaving null.
        meta = FakeMeta(
            name="some/instruction-tuned",
            max_tokens=512,
            loader_kwargs={},
        )
        meta.use_instructions = True  # type: ignore[attr-defined]
        with self._patch_hf(("Task: {task}\nQuery: ", "")):
            entry, _ = build_seed.extract_entry(meta)
        self.assertIsNone(entry["queryPrefix"])

    def test_hf_returning_none_leaves_prefixes_null(self) -> None:
        meta = FakeMeta(
            name="some/instruction-tuned-no-config",
            max_tokens=512,
            loader_kwargs={},
        )
        meta.use_instructions = True  # type: ignore[attr-defined]
        with self._patch_hf((None, None)):
            entry, _ = build_seed.extract_entry(meta)
        self.assertIsNone(entry["queryPrefix"])
        self.assertIsNone(entry["documentPrefix"])


class ChangelogConsistencyTests(unittest.TestCase):
    """Doc-drift invariants: numerical claims in the topmost CHANGELOG entry
    must match the actual committed artefacts. Catches the most common drift
    (someone updates the seed but forgets to update the bullet referencing
    its size, or vice-versa).
    """

    def setUp(self) -> None:
        self.repo_root = _REPO_ROOT
        self.changelog = (self.repo_root / "docs" / "CHANGELOG.md").read_text(encoding="utf-8")
        # The topmost release block: from "## v" to next "## v" or EOF.
        parts = self.changelog.split("## v", 2)
        if len(parts) < 2:
            self.skipTest("CHANGELOG has no version blocks")
        self.top_block = parts[1]

    def test_seed_entry_count_claim_matches_committed_seed(self) -> None:
        """If the topmost CHANGELOG block claims an N-entry seed, the
        committed data/seed-models.json must have exactly N entries.
        """
        seed = json.loads((self.repo_root / "data" / "seed-models.json").read_text())
        actual = len(seed["models"])

        # Match phrases like "349-entry seed", "349 dense, text-only..."
        # but only if the "seed" word follows.
        import re
        candidates = re.findall(r"\b(\d{2,4})[ -]entry seed\b", self.top_block, re.IGNORECASE)
        if not candidates:
            return  # no count claimed; nothing to verify

        for claimed_str in candidates:
            self.assertEqual(
                int(claimed_str),
                actual,
                f"CHANGELOG claims {claimed_str}-entry seed; committed seed has {actual}",
            )

    def test_python_test_count_claim_matches_actual(self) -> None:
        """If the topmost CHANGELOG block claims '36/36 Python', that count
        must equal the actual number of Python tests this suite runs.
        Slightly self-referential (this test is one of the 36) but catches
        drift in the count claim.
        """
        import re
        m = re.search(r"(\d+)/\d+\s+Python\b", self.top_block)
        if not m:
            return  # no claim; skip

        # Discover and count tests deterministically. Stdlib unittest only —
        # no pytest, no mteb, no extra deps.
        loader = unittest.TestLoader()
        suite = loader.discover(
            start_dir=str(self.repo_root / "test" / "scripts"),
            pattern="test_*.py",
        )

        def count(s: unittest.TestSuite) -> int:
            n = 0
            for t in s:
                if isinstance(t, unittest.TestSuite):
                    n += count(t)
                else:
                    n += 1
            return n

        actual = count(suite)
        claimed = int(m.group(1))
        self.assertEqual(
            claimed,
            actual,
            f"CHANGELOG claims {claimed} Python tests; suite contains {actual}",
        )


if __name__ == "__main__":
    unittest.main()
