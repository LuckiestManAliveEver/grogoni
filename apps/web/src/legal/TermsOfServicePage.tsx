import { Surface } from "@grogoni/ui";
import { LegalMarkdownBody, parseNumberedSections, type LegalSection } from "./LegalMarkdown";
import partOneMarkdown from "./terms-v1-draft-part-i.md?raw";
import partTwoMarkdown from "./terms-v1-draft-part-ii.md?raw";
import partThreeMarkdown from "./terms-v1-draft-part-iii.md?raw";
import partFourMarkdown from "./terms-v1-draft-part-iv.md?raw";
import { AppIcon } from "../AppIcon";

interface TermsPart {
  description: string;
  id: string;
  label: string;
  sections: LegalSection[];
}

const termsParts: TermsPart[] = [
  {
    id: "part-i",
    label: "Part I",
    description: "Preamble, Definitions, Acceptance, Eligibility, and Accounts",
    sections: parseNumberedSections(partOneMarkdown)
  },
  {
    id: "part-ii",
    label: "Part II",
    description:
      "Platform Services, AI Agents, Marketplace, Messaging, Skills, APIs, and User Responsibilities",
    sections: parseNumberedSections(partTwoMarkdown)
  },
  {
    id: "part-iii",
    label: "Part III",
    description:
      "Commercial Terms, Payments, Intellectual Property, Security, Compliance, and Third-Party Services",
    sections: parseNumberedSections(partThreeMarkdown)
  },
  {
    id: "part-iv",
    label: "Part IV",
    description:
      "Suspension, Termination, Liability, Consumer Rights, Dispute Resolution, Governing Law, and General Provisions",
    sections: parseNumberedSections(partFourMarkdown)
  }
];

export default function TermsOfServicePage() {
  return (
    <Surface title="Grogoni Terms of Service — Version 1.0 Draft">
      <a className="legal-skip-link" href="#terms-content">
        Skip to terms
      </a>
      <main className="legal-document-shell">
        <header className="legal-document-header">
          <a className="legal-brand" href="/" aria-label="Back to Grogoni home">
            <AppIcon className="legal-brand-icon" />
            <span>grogoni</span>
          </a>
          <p className="eyebrow">Legal</p>
          <h1>Terms of Service</h1>
          <p className="legal-version">Version 1.0 (Draft) · Parts I–IV</p>
          <p className="legal-effective-date">Effective Date: To Be Inserted</p>
          <p className="legal-intro">
            Commercial, security, enforcement, consumer-rights, liability, and general terms for use
            of Grogoni.
          </p>
        </header>

        <aside className="legal-draft-notice" aria-labelledby="draft-notice-title">
          <h2 id="draft-notice-title">Draft and completeness notice</h2>
          <p>
            All four parts of the draft are published for review, but this is not yet a
            production-ready agreement. The effective date, contracting entity, registered address,
            legal contact details, governing-law particulars, and any required jurisdiction-specific
            notices must be completed and legally approved before these Terms are presented for
            production acceptance.
          </p>
        </aside>

        <div className="legal-document-layout">
          <nav
            id="terms-contents"
            className="legal-table-of-contents"
            aria-label="Terms of Service contents"
          >
            <h2>Contents</h2>
            {termsParts.map((part) => (
              <div className="legal-toc-part" key={part.id}>
                <a className="legal-toc-part-link" href={`#${part.id}`}>
                  {part.label}
                </a>
                <ol start={part.sections[0]?.number}>
                  {part.sections.map((section) => (
                    <li key={section.number}>
                      <a href={`#section-${section.number}`}>{section.title}</a>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </nav>

          <article id="terms-content" className="legal-document" tabIndex={-1}>
            {termsParts.map((part) => (
              <section className="legal-part" aria-labelledby={`${part.id}-title`} key={part.id}>
                <header id={part.id} className="legal-part-header">
                  <p>{part.label}</p>
                  <h2 id={`${part.id}-title`}>{part.description}</h2>
                </header>
                {part.sections.map((section) => (
                  <section
                    className="legal-section"
                    aria-labelledby={`section-${section.number}-title`}
                    id={`section-${section.number}`}
                    key={section.number}
                  >
                    <h3 id={`section-${section.number}-title`}>
                      {section.number}. {section.title}
                    </h3>
                    <LegalMarkdownBody body={section.body} />
                    <a className="legal-back-to-contents" href="#terms-contents">
                      Back to contents
                    </a>
                  </section>
                ))}
              </section>
            ))}

            <footer className="legal-document-footer">
              <h2>End of supplied Terms of Service</h2>
              <p>
                By creating an account, accessing, or using the Services, you acknowledge that you
                have read, understood, and agree to be bound by these Terms of Service.
              </p>
              <p>© Grogoni. All rights reserved.</p>
            </footer>
          </article>
        </div>
      </main>
    </Surface>
  );
}
