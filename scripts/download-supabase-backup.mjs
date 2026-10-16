import { createBackupStorage, readBackupStorageConfig } from "./supabase-backup-storage.mjs";

const [objectKey, destination] = process.argv.slice(2);
if (!objectKey || !destination)
  throw new Error("An object key and new local destination are required.");
console.log(
  JSON.stringify(
    await createBackupStorage(readBackupStorageConfig()).download(objectKey, destination)
  )
);
