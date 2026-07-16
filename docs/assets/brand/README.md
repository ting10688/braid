# Braid brand assets

`braid-logo-source.jpeg` is the untouched user-approved master supplied on 2026-07-16. Its SHA-256 is
`c816d7594d2c8c95257f2ed568904e8eba1ec57630fd5cc04f41771a31623142`. The source is a 1254 × 1254
sRGB JPEG without alpha; do not remove its background or alter the mark.

The generated PNGs use charcoal `#11161C`, off-white `#F3F2EF`, and mint `#8EE7BF`. The approved mark
may be cropped proportionally, scaled, padded, or placed into a larger composition. Do not redraw it,
recolour it, add internal symbols, or present it on a visually noisy background.

Regenerate and verify assets with:

```bash
pnpm brand:render
pnpm brand:verify
```

`scripts/render-brand-assets.mjs` is the editable deterministic composition source. It uses system
sans-serif fonts and the dev-only `sharp` renderer; no font files are committed. Exact PNG bytes are not
a cross-platform contract, while source hash, filename, format, dimensions, and size limits are.

For video, keep critical text inside a 10% safe area. The social preview must be uploaded manually in
GitHub after merge; see `SOCIAL_PREVIEW.md`.
