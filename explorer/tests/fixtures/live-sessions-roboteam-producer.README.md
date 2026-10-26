# RoboTeam Live Sessions producer fixture

`live-sessions-roboteam-producer.json` is a byte-identical copy of recorded RoboTeam Live Sessions producer output: nine administrator-view rows and three recorded event streams.

| Field | Value |
| --- | --- |
| Source repository | AchillesCLI (`roboTeamAgent/tests/fixtures/live-sessions-producer-payload.json`) |
| Source commit | 085b6f0d |
| Generator | `roboTeamAgent/tests/helpers/generate-live-sessions-fixture.mjs` |
| SHA-256 | 38d2760d3e73408a6137d43f9ff1ab229eb8a404e9756e0e386726e88ba738d8 |

Refresh by regenerating in AchillesCLI, copying the file unchanged, and updating the commit and SHA-256 above. `tests/unit/liveSessionsProducerReplay.test.js` checks the hash and replays the file through the Explorer consumer; it does not read the sibling repository.
