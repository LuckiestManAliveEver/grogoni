import { chmod, open } from "node:fs/promises";
import { URL } from "node:url";
import webPush from "web-push";

const outputPath = new URL("../../../.env.vapid", import.meta.url);
const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:operations@grogoni.com";

if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
  throw new Error("VAPID_SUBJECT must be a mailto: or HTTPS URL.");
}

const keys = webPush.generateVAPIDKeys();
const contents = [
  `VAPID_PUBLIC_KEY=${keys.publicKey}`,
  `VAPID_PRIVATE_KEY=${keys.privateKey}`,
  `VAPID_SUBJECT=${subject}`,
  ""
].join("\n");

const file = await open(outputPath, "wx", 0o600).catch((error) => {
  if (error?.code === "EEXIST") {
    throw new Error(".env.vapid already exists; refusing to rotate the stable VAPID identity.");
  }
  throw error;
});

try {
  await file.writeFile(contents, { encoding: "utf8" });
} finally {
  await file.close();
}
await chmod(outputPath, 0o600);
console.log("Created .env.vapid with mode 0600. Secret values were not printed.");
