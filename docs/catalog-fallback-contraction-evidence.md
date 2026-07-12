# Catalog fallback contraction evidence

Recorded for Slice E of the workflow-stage catalog migration on 2026-07-12.

The legacy `vendor/skills/ai-catapult-init` fallback can be removed because:

- Slice D is merged on `main` as `a4c192c` and is an ancestor of release tag
  `v0.1.3` (`6f9e748`).
- `skills.lock.json` on `main` pins the exact merged Slice C commit
  `8a4a47d2b81f78f5a3596144e3ee051b557425b6`.
- GitHub Release `v0.1.3` targets `main` and contains Slice D.
- Release run [29195416013](https://github.com/r3dlex/ai-catapult/actions/runs/29195416013)
  successfully vendored that lock, verified vendor integrity, built both plugins,
  passed 142 tests, and passed the real-install smoke test. Those steps exercise
  catalog resolution from `03-configure-generate/ai-catapult-init` while retaining
  flat packaged plugin paths.
- `main` is the only supported release branch: the repository has no
  `release/*` branches, the `v0.1.3` release targets the default branch, and
  `.github/workflows/release.yml` publishes only version-tagged commits. Feature
  and pull-request branches are not supported release branches. Therefore no
  supported release-branch lock requires the legacy root layout.
- The unscoped `ai-catapult@0.1.3` package was published successfully.

The release workflow's overall conclusion is **failure**, not success: publishing
the optional `@r3dlex/ai-catapult@0.1.3` mirror failed with `ENEEDAUTH` after all
contraction-relevant build, test, integrity, and smoke gates passed. The scoped
mirror is not a source-layout consumer and its authentication failure does not
invalidate the catalog-path evidence above.
