import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { type MailService, noticeMail } from './mail.service';

const log = new Logger('TransactionalMail');

export async function sendDueMail(prisma: PrismaClient, mail: MailService, appUrl: string) {
  const now = new Date();
  const due = await prisma.transactionalMail.findMany({
    where: { sentAt: null, dueAt: { lte: now }, attempts: { lt: 8 } },
    orderBy: { dueAt: 'asc' }, take: 50,
  });
  for (const row of due) {
    const claimed = await prisma.transactionalMail.updateMany({
      where: { id: row.id, attempts: row.attempts, sentAt: null, dueAt: { lte: now } },
      data: { attempts: { increment: 1 }, dueAt: new Date(Date.now() + 5 * 60_000 * 2 ** row.attempts) },
    });
    if (!claimed.count) continue;
    try {
      await mail.send(noticeMail(row.recipient, row.subject, row.paragraphs, { label: 'Open Free Me', url: new URL(row.actionPath, appUrl).href }));
      await prisma.transactionalMail.update({ where: { id: row.id }, data: { sentAt: new Date() } });
    } catch {
      log.warn(`Delivery failed for notification ${row.id} (attempt ${row.attempts + 1})`);
    }
  }
}
