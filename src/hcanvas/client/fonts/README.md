# Bundled fonts

These variable WOFF2 files are bundled so Hcanvas renders consistently across machines.
All three are distributed under the SIL Open Font License 1.1.

- Inter — https://github.com/rsms/inter
- Source Serif 4 — https://github.com/adobe-fonts/source-serif
- JetBrains Mono — https://github.com/JetBrains/JetBrainsMono

The Latin subsets are copied into `dist/hcanvas/assets/fonts` by `scripts/build-hcanvas.mjs`.
Chinese glyphs intentionally fall back to system CJK fonts (Microsoft YaHei, PingFang SC, Songti SC, SimSun, etc.).
