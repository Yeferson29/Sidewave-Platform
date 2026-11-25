# Tunecloud fork exchange

Build a feature in a Tunecloud fork, swap commit links with another team, and review each other's changes. Return a private report and an expected-behavior test. Each author team then patches the finding and verifies the fix.

## Set up the exchange

1. Create a class GitHub repository from the extracted `tunecloud` folder. Commit the full project, including `.env.example` and the lockfile. Tag the starting commit `class-baseline` and give every team its URL.
2. Give each team access to the baseline and its assigned partner repo. Use private forks if the class organization's policy permits them. Otherwise, create a private repository per team with the same baseline commit. Confirm teams can read the assigned repositories and submit reports privately. [GitHub organization fork settings](https://docs.github.com/en/organizations/managing-organization-settings/managing-the-forking-policy-for-your-organization) · [GitHub repository access](https://docs.github.com/en/repositories/creating-and-managing-repositories/access-to-repositories)
3. Have teams run review copies in disposable class environments with separate local databases, synthetic users and content, and test billing fixtures. Limit the review to the assigned commit and its local Tunecloud instance.

## Round 1 · Build and submit

Choose one change or agree on an equivalent feature with the instructor. Include a normal use case, a boundary case, and a short note about the rule your server enforces.

| App | Feature change | Expected behavior to verify |
| --- | --- | --- |
| **Commons** | Add comments to posts. | Comments follow the post's visibility. An approved viewer can read a private post's comments, and a viewer without approval cannot. |
| **Stillroom** | Add albums with a member-selectable audience. | Listing photos, opening a photo, and viewing saved favorites all reflect the current album audience. |
| **Lowline** | Add a premium bundle redeemable with credits. | An eligible account can redeem the listed bundle. A repeated confirmation preserves the original debit and unlocks. |

Submit one commit SHA with the handoff below. Assignments are graded on the feature and its defenses.

## Round 2 · Swap and review

Create a local checkout of your partner's submitted commit. Read the diff from `class-baseline` and trace one feature from the UI to the server and database. Compare the implementation against the rule in the handoff. Use the app's normal controls and test accounts to check both permitted and denied behavior. Document any confirmed mismatch, its impact, and where enforcement belongs.

To keep your own fork and your review copy running at the same time, create a `.env` file in the review checkout with `PORT=3001`. Then run these commands from the review checkout:

```sh
npm ci
npm start
```

Open [http://localhost:3001](http://localhost:3001) in a separate browser profile. Each checkout has its own `.tunecloud-data/` directory. The browser profile keeps its accounts and cookies separate. Press Ctrl+C to stop the review copy.

Send the report privately to your partner team and instructor. If the checked properties hold, submit the evidence for a passed review instead of inventing a finding.

## Round 3 · Patch and verify

Review the partner's evidence. For a confirmed finding, write or adopt a regression test that states the intended restriction, patch the server-side enforcement, and verify that legitimate use still works. Submit the fix commit and test result. If the checked property already holds, cite the evidence and document an additional meaningful boundary test.

Use `npm run check` for syntax and `npm test` for the full test suite. The suite starts a temporary replica set by default. See the [README](README.md#verify) for details.

## Handoff form

```text
Team and feature
Repository URL and commit SHA
Feature entry point
Intended access or accounting rule
Synthetic setup and accounts needed
Tests and known limitations
```

## Review form

```text
Reviewed commit and feature
Expected behavior
Observed behavior, with synthetic evidence
Affected component and source location
Impact and proposed fix
Regression assertion for a permitted case
Regression assertion for a denied or repeat case
Fix commit and verification result
```

## Scoring

| Criterion | Points |
| --- | ---: |
| Working feature, clear rule, and reproducible handoff | 25 |
| Peer review evidence and accurate impact assessment | 35 |
| Verified patch or documented verification of the existing control | 25 |
| Regression assertions cover allowed and denied or repeated behavior | 15 |
| **Total** | **100** |
