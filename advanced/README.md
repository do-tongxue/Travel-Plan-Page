# Advanced references

This directory separates the current lightweight generation path from retained Heavy Architecture references.

Ordinary trip generation must not read or run source-facts pipelines, canonical/renderer package pipelines, the full Entity or Stable ID systems, migration/normalizer frameworks, full schema validation, or architecture audits. Those materials remain historical or advanced references only and have not been deleted.

The default workflow reads `SKILL.md`, the single `trip-data.json`, and only the module-specific reference needed for an explicit DIY request. Standalone config/canonical files in the retained tools are advanced compatibility inputs, not ordinary generation inputs.

The retained Boundary-based `country-golden` / `generic-diagram` workflow is also legacy material. Current ordinary map generation uses ten fixed templates with automatic deterministic selection through `scripts/build-map.mjs`.

The optional real-basemap extension is documented in `references/advanced/real-basemap.md`. It is opt-in through `map.basemap`, never part of ordinary generation, and leaves the default builder output unchanged when disabled.
