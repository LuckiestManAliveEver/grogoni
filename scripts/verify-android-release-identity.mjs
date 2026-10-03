import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { dirname, join } from "node:path";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApproved = process.argv.includes("--require-approved");
const identityPath = join(workspaceRoot, "config/android-release-identity.json");
const identity = JSON.parse(readFileSync(identityPath, "utf8"));
const webManifest = JSON.parse(
  readFileSync(join(workspaceRoot, "apps/web/public/manifest.webmanifest"), "utf8")
);
const rootPackage = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8"));
const renderBlueprint = readFileSync(join(workspaceRoot, "render.yaml"), "utf8");
const errors = [];
const pending = [];

check(identity.schemaVersion === 1, "schemaVersion must be 1");
check(identity.checkpoint === "CP26", "checkpoint must be CP26");
check(identity.$schema === "./android-release-identity.schema.json", "$schema is invalid");
check(isDate(identity.lastReviewedOn), "lastReviewedOn must be an ISO calendar date");
check(["proposed", "approved"].includes(identity.identityStatus), "identityStatus is invalid");
check(identity.brand?.appName === webManifest.name, "appName must match the PWA manifest name");
check(
  identity.brand?.launcherName === webManifest.short_name,
  "launcherName must match the PWA manifest short_name"
);
check(
  /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(identity.android?.applicationId ?? ""),
  "applicationId must contain at least three valid lowercase segments"
);
check(!identity.android?.applicationId.includes("example"), "applicationId must not be an example");
check(
  ["proposed", "approved"].includes(identity.android?.applicationIdStatus),
  "applicationIdStatus is invalid"
);
check(identity.android?.wrapper === "trusted-web-activity", "wrapper must be trusted-web-activity");
check(identity.android?.distribution === "google-play", "distribution must be google-play");
check(identity.android?.firstTrack === "internal", "firstTrack must be internal");
check(identity.android?.versionName === rootPackage.version, "versionName must match package.json");
check(Number.isInteger(identity.android?.versionCode), "versionCode must be an integer");
check(identity.android?.versionCode > 0, "versionCode must be positive");
check(identity.android?.minSdk >= 23, "minSdk must be at least 23");
check(identity.android?.targetSdk >= 35, "targetSdk must be at least 35");
check(
  identity.android?.compileSdk >= identity.android?.targetSdk,
  "compileSdk must not be lower than targetSdk"
);
check(identity.web?.origin === "https://grogoni.com", "production web origin is invalid");
check(isHttpsUrl(identity.web?.origin), "production web origin must use HTTPS");
check(isHttpsUrl(identity.web?.apiOrigin), "production API origin must use HTTPS");
check(
  identity.web?.startUrl === `${identity.web?.origin}/`,
  "startUrl must use the production origin"
);
check(identity.web?.scope === `${identity.web?.origin}/`, "scope must use the production origin");
check(
  identity.web?.manifestUrl === `${identity.web?.origin}/manifest.webmanifest`,
  "manifestUrl is inconsistent"
);
check(
  identity.web?.digitalAssetLinksUrl === `${identity.web?.origin}/.well-known/assetlinks.json`,
  "Digital Asset Links URL is inconsistent"
);
check(renderBlueprint.includes("domains:\n      - grogoni"), "Render must declare grogoni");
check(
  renderBlueprint.includes("value: https://grogoni.com"),
  "Render web API origin must match the release identity"
);
check(identity.signing?.playAppSigning === true, "Play App Signing must be enabled");
check(
  identity.signing?.privateKeysCommitted === false,
  "private signing keys must never be committed"
);
check(
  ["organization", "personal"].includes(identity.developer?.accountType),
  "developer accountType is invalid"
);
check(
  ["proposed", "approved"].includes(identity.developer?.accountTypeStatus),
  "developer accountTypeStatus is invalid"
);
check(
  ["pending", "verified"].includes(identity.developer?.identityVerificationStatus),
  "developer identityVerificationStatus is invalid"
);
check(isDate(identity.policyBaseline?.targetApiVerifiedOn), "target API review date is invalid");
check(
  identity.policyBaseline?.targetApiSource ===
    "https://developer.android.com/google/play/requirements/target-sdk",
  "target API source is invalid"
);
check(
  identity.policyBaseline?.revalidateBeforeFirstUpload === true,
  "target API policy must be revalidated before upload"
);

for (const certificateField of ["uploadCertificateSha256", "appSigningCertificateSha256"]) {
  const fingerprint = identity.signing?.[certificateField];
  check(
    fingerprint === null || /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(fingerprint),
    `${certificateField} must be null or a colon-separated SHA-256 fingerprint`
  );
}

if (identity.approval?.approvedOn !== null) {
  check(isDate(identity.approval?.approvedOn), "approval.approvedOn must be an ISO calendar date");
}

pendingValue("android.applicationId", identity.android?.applicationIdStatus === "approved");
pendingValue("developer.accountType", identity.developer?.accountTypeStatus === "approved");
pendingValue("developer.playDeveloperName", hasText(identity.developer?.playDeveloperName));
pendingValue("developer.legalEntityName", hasText(identity.developer?.legalEntityName));
pendingValue(
  "developer.playDeveloperAccountId",
  hasText(identity.developer?.playDeveloperAccountId)
);
pendingValue(
  "developer.identityVerificationStatus",
  identity.developer?.identityVerificationStatus === "verified"
);

for (const key of [
  "releaseOwner",
  "playConsolePrimaryOwner",
  "uploadKeyCustodian",
  "incidentRecoveryOwner"
]) {
  pendingValue(`ownership.${key}`, hasText(identity.ownership?.[key]));
}

pendingValue(
  "signing.rotationAndRecoveryDocumented",
  identity.signing?.rotationAndRecoveryDocumented
);
pendingValue("approval.approvedBy", hasText(identity.approval?.approvedBy));
pendingValue("approval.approvedOn", hasText(identity.approval?.approvedOn));
pendingValue("approval.changeRecord", hasText(identity.approval?.changeRecord));

if (identity.identityStatus === "approved" && pending.length > 0) {
  errors.push("identityStatus cannot be approved while required approvals remain pending");
}

if (requireApproved && identity.identityStatus !== "approved") {
  errors.push("CP26 identity has not been approved");
}

if (requireApproved && pending.length > 0) {
  errors.push(`CP26 approval fields remain pending: ${pending.join(", ")}`);
}

if (errors.length > 0) {
  console.error("Android release identity verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Android release identity is structurally valid (${identity.identityStatus}).`);
if (pending.length > 0) {
  console.log(`Pending CP26 approvals: ${pending.join(", ")}`);
}

function check(condition, message) {
  if (!condition) errors.push(message);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isDate(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function pendingValue(label, satisfied) {
  if (!satisfied) pending.push(label);
}
