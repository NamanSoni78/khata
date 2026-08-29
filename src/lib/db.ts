import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  })

// Ensure the engine is connected at startup (fixes "Engine is not yet connected" errors
// when the first DB query happens deep inside a request handler).
if (!globalForPrisma.prisma) {
  globalForPrisma.prisma = db
  // Kick off connection in background; don't block module load.
  db.$connect().catch((e) => {
    console.error('[prisma] $connect() failed:', e)
  })
}