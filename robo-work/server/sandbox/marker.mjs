// The reservation marker: the S1 reservation id (base64url, 22 characters) carried verbatim as a literal argv element of every
// pre-commit stage and as bwrap's `--hostname`, so that recovery can match it with `cmdline.includes(locator.marker)`.
//
// An S1 id begins with '-' about once in 64 (base64url has '-'), so a leading '-' is ACCEPTED here and everywhere the marker is
// used (bwrapArgs.mjs, stage.sh, sandboxPrep.mjs, sandboxLauncher.mjs): the marker is only ever a positional or the value of a
// fixed option (`--hostname`), never an option of a tool. This is the single JavaScript definition; stage.sh repeats the same
// character set in shell, and stageScript.test.mjs / marker.test.mjs pin the two together.
export const MARKER_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;
export const isMarker = (value) => typeof value === 'string' && MARKER_PATTERN.test(value);
