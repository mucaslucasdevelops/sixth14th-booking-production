# Repository map for Codex

This repository contains one active application at the repository root.

- `server.mjs` is the server entry point. `Dockerfile` copies it into `/app` and runs it.
- `public/` contains the served HTML, CSS, JavaScript, and image. Edit assets here, never at the repository root.
- `scripts/` contains operational scripts and tests. `package.json` calls these paths.
- `data/settings.json` and `data/reservations.seed.json` are Docker build inputs. Runtime data comes from `DATA_DIR` or `DATABASE_URL`; `data/reservations.json` is local data, not a production snapshot.
- `docs/archive/` contains old staging and cutover instructions for historical reference. It does not describe the current deployment.

The old uploaded source folders, ZIP packages, root copies of public assets/scripts, and staging `render.yaml` were removed at this cleanup. They remain recoverable from Git history at commit `eee477bd08a9756bbd26f053375e44cb67d4762c`. Do not restore or edit them as a second application.

See `DEPLOYMENT.md` before changing Render configuration. Do not infer the live service's environment or attached data store from a historical YAML file.
