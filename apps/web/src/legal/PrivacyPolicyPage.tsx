import { Surface } from "@grogoni/ui";
import {
  LegalMarkdownBody,
  parseAnnexes,
  parseNumberedSections,
  type LegalSection
} from "./LegalMarkdown";
import partOneMarkdown from "./privacy-v1-draft-part-i.md?raw";
import partTwoMarkdown from "./privacy-v1-draft-part-ii.md?raw";
import partThreeMarkdown from "./privacy-v1-draft-part-iii.md?raw";
import partFourMarkdown from "./privacy-v1-draft-part-iv.md?raw";
import { AppIcon } from "../AppIcon";

interface PrivacyPart {
  description: string;
  id: string;
  label: string;
  sections: LegalSection[];
}

const privacyParts: PrivacyPart[] = [
  {
    id: "privacy-part-i",
    label: "Part I",
    description: "Overview, Scope, Definitions, Data Controller, and Personal Data We Collect",
    sections: parseNumberedSections(partOneMarkdown)
  },
  {
    id: "privacy-part-ii",
    label: "Part II",
    description: "Legal Bases, Uses of Personal Data, AI Processing, Cookies, and Data Sharing",
    sections: parseNumberedSections(partTwoMarkdown)
  },
  {
    id: "privacy-part-iii",
    label: "Part III",
    description:
      "International Transfers, Retention, Security, Data Subject Rights, Automated Decisions, and Children’s Privacy",
    sections: parseNumberedSections(partThreeMarkdown)
  },
  {
    id: "privacy-part-iv",
    label: "Part IV",
    description:
      "Complaints, Supervisory Authorities, Policy Updates, Contact Information, Final Provisions, and Annexes",
    sections: parseNumberedSections(partFourMarkdown)
  }
];

const privacyAnnexes = parseAnnexes(partFourMarkdown);

export default function PrivacyPolicyPage() {
  return (
    <Surface title="Grogoni Privacy Policy — Version 1.0 Draft">
      <a className="legal-skip-link" href="#privacy-content">
        Skip to privacy policy
      </a>
      <main className="legal-document-shell">
        <header className="legal-document-header">
          <a className="legal-brand" href="/" aria-label="Back to Grogoni home">
            <AppIcon className="legal-brand-icon" />
            <span>grogoni</span>
          </a>
          <p className="eyebrow">Legal</p>
          <h1>Privacy Policy</h1>
          <p className="legal-version">Version 1.0 (Draft) · Parts I–IV</p>
          <p className="legal-effective-date">Effective Date: To Be Inserted</p>
          <p className="legal-intro">
            How Grogoni collects, uses, stores, shares, protects, and otherwise processes
            Personal Data when people use the Services.
          </p>
          <dl className="legal-particulars">
            <div>
              <dt>Data Controller</dt>
              <dd>[Legal Entity Name]</dd>
            </div>
            <div>
              <dt>Registered Office</dt>
              <dd>[Registered Address]</dd>
            </div>
            <div>
              <dt>Privacy Contact</dt>
              <dd>privacy@grogoni.com (placeholder)</dd>
            </div>
          </dl>
        </header>

        <aside className="legal-draft-notice" aria-labelledby="privacy-draft-notice-title">
          <h2 id="privacy-draft-notice-title">Draft and completeness notice</h2>
          <p>
            All four parts and annexes are published for review, but this is not yet a
            production-ready privacy notice. The effective date, legal data controller, registered
            office, verified privacy contact, Data Protection Officer or representative details,
            applicable supervisory authorities, and jurisdiction-specific disclosures must be
            completed and legally approved before publication as a final policy.
          </p>
        </aside>

        <div className="legal-document-layout">
          <nav
            id="privacy-contents"
            className="legal-table-of-contents"
            aria-label="Privacy Policy contents"
          >
            <h2>Contents</h2>
            {privacyParts.map((part) => (
              <div className="legal-toc-part" key={part.id}>
                <a className="legal-toc-part-link" href={`#${part.id}`}>
                  {part.label}
                </a>
                <ol start={part.sections[0]?.number}>
                  {part.sections.map((section) => (
                    <li key={section.number}>
                      <a href={`#privacy-section-${section.number}`}>{section.title}</a>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
            <div className="legal-toc-part">
              <a className="legal-toc-part-link" href="#privacy-annexes">
                Annexes
              </a>
              <ul className="legal-toc-annexes">
                {privacyAnnexes.map((annex) => (
                  <li key={annex.id}>
                    <a href={`#${annex.id}`}>{annex.title}</a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>

          <article id="privacy-content" className="legal-document" tabIndex={-1}>
            {privacyParts.map((part) => (
              <section className="legal-part" aria-labelledby={`${part.id}-title`} key={part.id}>
                <header id={part.id} className="legal-part-header">
                  <p>{part.label}</p>
                  <h2 id={`${part.id}-title`}>{part.description}</h2>
                </header>
                {part.sections.map((section) => (
                  <section
                    className="legal-section"
                    aria-labelledby={`privacy-section-${section.number}-title`}
                    id={`privacy-section-${section.number}`}
                    key={section.number}
                  >
                    <h3 id={`privacy-section-${section.number}-title`}>
                      {section.number}. {section.title}
                    </h3>
                    <LegalMarkdownBody body={section.body} />
                    <a className="legal-back-to-contents" href="#privacy-contents">
                      Back to contents
                    </a>
                  </section>
                ))}
              </section>
            ))}

            <section
              id="privacy-annexes"
              className="legal-part"
              aria-labelledby="privacy-annexes-title"
            >
              <header className="legal-part-header">
                <p>Reference</p>
                <h2 id="privacy-annexes-title">Privacy Policy Annexes</h2>
              </header>
              {privacyAnnexes.map((annex) => (
                <section
                  id={annex.id}
                  className="legal-section"
                  aria-labelledby={`${annex.id}-title`}
                  key={annex.id}
                >
                  <h3 id={`${annex.id}-title`}>
                    {annex.label} – {annex.title}
                  </h3>
                  <LegalMarkdownBody body={annex.body} />
                  <a className="legal-back-to-contents" href="#privacy-contents">
                    Back to contents
                  </a>
                </section>
              ))}
            </section>

            <footer className="legal-document-footer">
              <h2>End of supplied Privacy Policy</h2>
              <p>
                By using the Services, you acknowledge that you have been informed about the
                processing of your Personal Data as described in this Privacy Policy.
              </p>
              <p>© Grogoni. All rights reserved.</p>
            </footer>
          </article>
        </div>
      </main>
    </Surface>
  );
}
