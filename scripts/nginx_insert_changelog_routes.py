#!/usr/bin/env python3
"""
Idempotent surgical insert: adds the launcher /changelog.html +
/SUITE_CHANGELOG.md location blocks to the live nginx config, right
after the existing `location = /index.html` block.

Called by .github/workflows/sp-nginx-add-changelog.yml. Reason it lives
here as a file rather than inline in the workflow: YAML block-scalar
indentation makes nested-heredoc Python impossible without leading-
whitespace traps.

Usage:
    python3 nginx_insert_changelog_routes.py /etc/nginx/sites-enabled/sentimentpulse
"""
import sys

ANCHOR = (
    "    location = /index.html {\n"
    "        root /opt/sentimentpulse/launcher;\n"
    "    }\n"
)

INSERT = (
    "    # Suite-wide What's New page + its markdown source. Both are served\n"
    "    # directly from the checkout under /opt/sentimentpulse/.\n"
    "    location = /changelog.html {\n"
    "        root /opt/sentimentpulse/launcher;\n"
    '        add_header Cache-Control "no-cache, must-revalidate";\n'
    "    }\n"
    "    location = /SUITE_CHANGELOG.md {\n"
    "        alias /opt/sentimentpulse/SUITE_CHANGELOG.md;\n"
    "        default_type text/markdown;\n"
    '        add_header Cache-Control "no-cache, must-revalidate";\n'
    "    }\n"
)

SENTINEL = "location = /changelog.html"


def main(path: str) -> int:
    src = open(path).read()
    if SENTINEL in src:
        print(f"{path}: changelog routes already present — no changes made.")
        return 0
    if ANCHOR not in src:
        print(
            f"{path}: could not find the launcher /index.html anchor.\n"
            "Refusing to modify. The live config has drifted and this "
            "insert would land in the wrong place. Fix the anchor or "
            "insert manually.",
            file=sys.stderr,
        )
        return 2

    new = src.replace(ANCHOR, ANCHOR + INSERT, 1)
    open(path, "w").write(new)
    added = INSERT.count("\n")
    print(f"{path}: inserted {added} lines after the launcher anchor.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: nginx_insert_changelog_routes.py <path-to-nginx-conf>", file=sys.stderr)
        sys.exit(64)
    sys.exit(main(sys.argv[1]))
