/**
 * Hash a password for use as ADMIN_PASSWORD env var.
 * Usage: bun run scripts/hash-password.ts mysecretpass
 */
import bcrypt from "bcryptjs";

const input = process.argv[2];
if (!input) {
  console.error("Usage: bun run scripts/hash-password.ts <password>");
  process.exit(1);
}
const hash = bcrypt.hashSync(input, 10);
console.log(hash);
