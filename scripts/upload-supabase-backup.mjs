import { createBackupStorage, readBackupStorageConfig } from "./supabase-backup-storage.mjs";

const file = process.argv[2];
if (!file) throw new Error("A pg_dump file path is required.");
const result = await createBackupStorage(readBackupStorageConfig()).upload(file);
console.log(JSON.stringify(result));
