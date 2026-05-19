# Contributing

Run the full local checks before opening a PR:

```bash
npm install
npm run ci
```

Keep public defaults machine-neutral. Put workstation-specific paths, model
artifacts, and service labels in examples or generated local config, not in
library code.

Generated state, model files, SQLite databases, logs, and local config files
must not be committed.
