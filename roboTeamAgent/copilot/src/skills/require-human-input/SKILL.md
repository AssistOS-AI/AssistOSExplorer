---
name: require-human-input
description: Use when you must make a business decision but lack enough context to make it yourself. Ask the user through this skill, then end your execution immediately.
---

# Require human input

Use this skill only for a business decision that blocks the task and has no answer in the prompt or available context. Inspect that context first. Resolve routine technical choices yourself.

Ask one clear question and propose exactly three distinct, concrete answers. Put your recommended answer first. The user can also submit a custom answer.

Run the script from this skill's directory with a JSON object as its `--input` argument:

```sh
node scripts/run.mjs --input '{"question":"Which audience should this launch target?","options":["Existing customers","New small-business customers","Enterprise buyers"]}'
```

Use proper shell quoting for question and option text. Do not include credentials. The script handles delivery of the question; supply only the question and options.

After the script confirms success, end your current execution immediately. Do no more work and call no more tools. Your only remaining output is a short final response within the required `<<human-report>>` markers saying that you are waiting for the answer. Do not wait or poll. Resume work only when you receive the user's answer in a new message.

If the script fails, do not claim that the question was delivered. Report the failure and end the execution. Never invent the missing business decision.
