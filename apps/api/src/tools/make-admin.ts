import { PrismaClient, type Role } from '@prisma/client';
import { handleProblem, normalizeHandle } from '@free-me/shared';
import { existsSync } from 'node:fs';

/**
 * Makes an account an administrator: it can do everything (Administration, Moderation, payment settings, every
 * Premium feature such as Live Studio and Ad Studio). The account is created if that address never signed in.
 * With --space it also gets (or renames) its Space, with the verified badge: the platform's own official account.
 *   npm run make-admin -- someone@example.com
 *   npm run make-admin -- someone@example.com --space "Free Me" --handle freeme
 * To keep someone administrator on every server, also list the address in ADMIN_EMAILS.
 */
function option(name: string) { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]?.trim() : undefined; }

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error('Usage: npm run make-admin -- someone@example.com [--space "Free Me" --handle freeme]'); process.exit(1); }
  const space = option('space');
  const handle = option('handle');
  // Reserved handles (freeme, admin…) are kept for the platform itself: allowed here, refused to everyone else.
  const problem = handle ? handleProblem(handle) : null;
  if (problem && !/reserved/i.test(problem)) { console.error(`Handle: ${problem}`); process.exit(1); }
  if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
  const prisma = new PrismaClient();
  const admin: Role[] = ['VIEWER', 'ADMIN', 'MODERATOR', ...(space ? ['CREATOR' as Role] : [])];
  const existing = await prisma.user.findUnique({ where: { email } });
  const user = existing
    ? await prisma.user.update({ where: { email }, data: { status: 'ACTIVE', roles: { set: [...new Set([...existing.roles, ...admin])] } } })
    : await prisma.user.create({ data: { email, roles: admin, profile: { create: { displayName: space ?? email.split('@')[0] } } } });

  if (space) {
    const h = normalizeHandle(handle ?? space);
    const taken = await prisma.channel.findUnique({ where: { handle: h } });
    if (taken && taken.userId !== user.id) { console.error(`The handle @${h} belongs to another account. Choose another with --handle.`); process.exit(1); }
    const mine = await prisma.channel.findUnique({ where: { userId: user.id } });
    const data = { name: space, handle: h, isVerified: true, verificationSource: 'ADMIN' };
    if (mine) await prisma.channel.update({ where: { id: mine.id }, data });
    else await prisma.channel.create({ data: { userId: user.id, ...data } });
    await prisma.profile.updateMany({ where: { userId: user.id }, data: { displayName: space } });
    console.log(`Space "${space}" (@${h}) with the verified badge.`);
  } else {
    // Their Space (if they have one) shows the verified badge.
    await prisma.channel.updateMany({ where: { userId: user.id, isVerified: false }, data: { isVerified: true, verificationSource: 'ADMIN' } });
  }
  console.log(`${email} is now an administrator${existing ? '' : ' (account created: sign in with this address to use it)'}.`);
  console.log('Administration is in the account menu; every Premium feature (Live Studio, Ad Studio, monetisation) is included.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
