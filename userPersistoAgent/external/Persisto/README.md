# Bundled Persisto runtime

These files are unchanged copies from [OpenDSU/Persisto](https://github.com/OpenDSU/Persisto/tree/a711a67f6bdfdec15af91f9f79aa8a0d69397149), commit `a711a67f6bdfdec15af91f9f79aa8a0d69397149`. `upstream.json` records the revision and SHA-256 digest of every included upstream file. The upstream MIT license is retained in `LICENSE`.

The bundle contains the persistence engine, its storage strategy and required audit-event constants. UserPersisto supplies its own durable adapter and logger. The unused upstream audit server/client and its optional `achillesUtils` integration are not included. No upstream package lifecycle script is run.

Bundling this small, existing runtime makes installation independent of startup Git/network access and permits Ploinky to mount all of `/code` read-only. User data remains in `PERSISTENCE_FOLDER`; the source bundle is never a persistence directory.

For an update, select and review an exact upstream commit, copy the required files verbatim, retain the license, regenerate `upstream.json`, and run the full UserPersisto suite plus initialization with the agent source mounted read-only. Do not update the runtime during agent startup.
