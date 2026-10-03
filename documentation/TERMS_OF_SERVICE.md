# Terms of Service publication

## Current status

The web app publishes the supplied Grogoni Terms of Service Version 1.0 Draft, Parts I–IV,
at `/terms`. The page is responsive, keyboard navigable, printable, and uses semantic headings,
lists, landmarks, and anchored navigation.

The supplied draft contains a continuous section sequence from 1–77. It remains intentionally
identified as a draft and must not be treated as a production-ready agreement until its placeholder
effective date and missing legal particulars have been completed and approved.

## Source of truth

The supplied text is preserved without editorial rewriting in:

- `apps/web/src/legal/terms-v1-draft-part-i.md` — sections 1–14.
- `apps/web/src/legal/terms-v1-draft-part-ii.md` — sections 15–32.
- `apps/web/src/legal/terms-v1-draft-part-iii.md` — sections 33–54.
- `apps/web/src/legal/terms-v1-draft-part-iv.md` — sections 55–77.

`apps/web/src/legal/TermsOfServicePage.tsx` parses those Markdown sources into the public page. The
editorial sentence at the end of Part III announcing a future installment is not rendered. The
final acknowledgement from Part IV is rendered as the document footer.

## Production publication gate

Before enabling acceptance of these Terms in production, legal/product owners must:

1. Replace `[To Be Inserted]` with an approved effective date and remove the draft label when
   authorized.
2. Identify the contracting entity, registered address, and legal contact channels.
3. Specify governing-law and jurisdiction details for each relevant contracting entity.
4. Add all required consumer, privacy, marketplace, and regional notices.
5. Confirm that referenced policies and support/appeal mechanisms exist and are reachable.
6. Obtain legal approval for the complete agreement and record the approved artifact/version.
7. Verify the final page using `pnpm test:ui-cert` before release.

The in-product completeness notice must remain visible until this gate has been satisfied.
