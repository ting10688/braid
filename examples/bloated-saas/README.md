# Bloated SaaS fixture

This small application builds and passes its tests, but intentionally mixes order and notification
responsibilities, contains an orders/users dependency cycle, reaches across module boundaries, and
uses a low local file-size threshold to keep the oversized service readable.

Run it from the repository root with `pnpm analyze:example`.
