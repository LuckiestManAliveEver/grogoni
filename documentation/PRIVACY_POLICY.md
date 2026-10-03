# Privacy Policy publication

## Current status

The web app publishes the supplied Grogoni Privacy Policy Version 1.0 Draft, Parts I–IV and
Annexes A–D, at `/privacy`. The page is responsive, keyboard navigable, printable, and uses
semantic headings, lists, landmarks, definitions, and anchored navigation.

The supplied draft contains a continuous section sequence from 1–40. It remains intentionally
identified as a draft and must not be treated as a production-ready privacy notice until its
placeholders and jurisdiction-specific disclosures have been completed and approved.

## Source of truth

The supplied wording is preserved in:

- `apps/web/src/legal/privacy-v1-draft-part-i.md` — sections 1–6.
- `apps/web/src/legal/privacy-v1-draft-part-ii.md` — sections 7–18.
- `apps/web/src/legal/privacy-v1-draft-part-iii.md` — sections 19–27.
- `apps/web/src/legal/privacy-v1-draft-part-iv.md` — sections 28–40 and Annexes A–D.

`apps/web/src/legal/PrivacyPolicyPage.tsx` parses those Markdown sources into the public page. The
editorial “next installment” sentences are not rendered. The supplied final acknowledgement is
rendered as the document footer.

## Production publication gate

Before publishing this Privacy Policy as final, legal/privacy owners must:

1. Replace `[To Be Inserted]` with the approved effective date and remove the draft label when
   authorized.
2. Identify the legal data controller and registered office.
3. Verify and publish monitored privacy-rights contact channels.
4. Add the Data Protection Officer or representative details where appointment is required.
5. Identify applicable supervisory authorities and jurisdiction-specific rights or disclosures.
6. Confirm the declared processing purposes, legal bases, recipients, international-transfer
   mechanisms, subprocessors, retention practices, cookie controls, and automated-decision details
   match production behavior.
7. Confirm that consent withdrawal, access, correction, deletion, portability, objection,
   restriction, and complaint workflows are operational where applicable.
8. Obtain legal/privacy approval and record the approved artifact and version.
9. Verify the final page using `pnpm test:ui-cert` before release.

The in-product completeness notice must remain visible until this gate has been satisfied.
