import { PrismaClient, type Role } from '@prisma/client';
import { existsSync } from 'node:fs';

/**
 * Makes an account an administrator (it can do everything: Administration, Moderation, payment settings, and every
 * Premium feature such as Live Studio). The account is created if that address has never signed in.
 *   npm run make-admin -- someone@example.com
 * To keep someone administrator on every server, also list the address in ADMIN_EMAILS.
 */
async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error('Usage: npm run make-admin -- someone@example.com'); process.exit(1); }
  if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
  const prisma = new PrismaClient();
  const admin: Role[] = ['VIEWER', 'ADMIN', 'MODERATOR'];
  const existing = await prisma.user.findUnique({ where: { email } });
  const user = existing
    ? await prisma.user.update({ where: { email }, data: { status: 'ACTIVE', roles: { set: [...new Set([...existing.roles, ...admin])] } } })
    : await prisma.user.create({ data: { email, roles: admin, profile: { create: { displayName: email.split('@')[0] } } } });
  // Their Space (if they have one) shows the verified badge.
  await prisma.channel.updateMany({ where: { userId: user.id, isVerified: false }, data: { isVerified: true, verificationSource: 'ADMIN' } });
  console.log(`${email} is now an administrator${existing ? '' : ' (account created: sign in with this address to use it)'}.`);
  console.log('Sign out and in again if you were signed in. Administration is in the account menu; Premium features (Live Studio, monetisation) are included.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
