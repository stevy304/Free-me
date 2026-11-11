import { BadRequestException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Payout } from '@prisma/client';

export interface WithdrawalQuote {
  id: string; channelId: string; accountVersion: number; amountCents: string;
  rwfPerUsd: number; feeRwf: number; receiveRwf: string; expiresAt: number;
}

export function payoutView(p: Payout) {
  return {
    id: p.id, amountCents: Number(p.amountCents), currency: p.currency, method: p.method,
    account: p.accountIdentifier, accountHolderName: p.accountHolderName, status: p.status,
    reference: p.referenceTransactionId, rejectionReason: p.rejectionReason,
    requestedAt: p.requestedAt, processedAt: p.processedAt,
    destinationCurrency: p.destinationCurrency, destinationAmount: p.destinationAmount?.toString() ?? null,
    feeAmount: p.feeAmount?.toString() ?? null, exchangeRate: p.exchangeRate,
  };
}

export function makeQuote(channelId: string, accountVersion: number, amount: bigint, rate: number, fee: number, secret: string) {
  const receive = amount * BigInt(rate) / 100n - BigInt(fee);
  if (receive <= 0n) throw new BadRequestException('This withdrawal would be smaller than the payout fee.');
  const quote: WithdrawalQuote = {
    id: randomUUID(), channelId, accountVersion, amountCents: amount.toString(),
    rwfPerUsd: rate, feeRwf: fee, receiveRwf: receive.toString(), expiresAt: Date.now() + 10 * 60_000,
  };
  const payload = Buffer.from(JSON.stringify(quote)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return { ...quote, token: `${payload}.${signature}` };
}

export function readQuote(token: string, secret: string): WithdrawalQuote {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw new BadRequestException('Preview this withdrawal again.');
  const actual = Buffer.from(signature, 'base64url');
  const expected = createHmac('sha256', secret).update(payload).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BadRequestException('Preview this withdrawal again.');
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as WithdrawalQuote; }
  catch { throw new BadRequestException('Preview this withdrawal again.'); }
}
