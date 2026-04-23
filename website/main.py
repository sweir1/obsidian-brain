import json, pathlib, re

def define_env(env):
    pkg = json.loads((pathlib.Path(__file__).parent.parent / "package.json").read_text())
    env.variables["version"] = pkg["version"]

    @env.macro
    def recent_releases(n=5):
        """Return a markdown bulleted list of the N most recent CHANGELOG entries."""
        changelog_path = pathlib.Path(__file__).parent.parent / "docs" / "CHANGELOG.md"
        try:
            text = changelog_path.read_text(encoding="utf-8")
        except OSError:
            return "- (changelog unavailable)"

        pattern = re.compile(
            r"^## v(?P<ver>\d+\.\d+\.\d+)"
            r"(?: — (?P<date>\d{4}-\d{2}-\d{2}))?"
            r"(?: — (?P<title>.+))?$",
            re.MULTILINE,
        )

        bullets = []
        for m in pattern.finditer(text):
            ver   = m.group("ver")
            date  = m.group("date")
            title = m.group("title")

            parts = [f"**v{ver}**"]
            if date:
                parts.append(f"({date})")
            if title:
                parts.append(f"— {title.strip()}")
            bullets.append("- " + " ".join(parts))

            if len(bullets) >= n:
                break

        return "\n".join(bullets) if bullets else "- (no releases found)"
