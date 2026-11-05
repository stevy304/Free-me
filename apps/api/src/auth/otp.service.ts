import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { OTP_LENGTH, OTP_MAX_ATTEMPTS, OTP_TTL_MINUTES } from '@free-me/shared';
import { PrismaService } from '../database/prisma.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { MailService, signInCodeMail } from '../mail/mail.service';
import { RateLimitService } from '../common/rate-limit.service';

/**
 * One-time sign-in codes by email. Six random digits, valid for ten minutes, five tries, one use. Only an HMAC of the
 * code (keyed with SESSION_SECRET and bound to the address) is stored. A new request replaces any earlier code.
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService, private readonly mail: MailService, private readonly limits: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private hash(email: string, code: string) {
    return createHmac('sha256', this.config.sessionSecret).update(`sign-in:${email}:${code}`).digest('hex');
  }

  async request(email: string, ip: string | null) {
    await this.limits.consume(`otp:req:email:${email}`, 1, 60, 'A code was just sent. Wait a minute before asking for another.');
    await this.limits.consume(`otp:req:email-hour:${email}`, 5, 3600, 'Too many codes for this address. Try again in an hour.');
    if (ip) await this.limits.consume(`otp:req:ip:${ip}`, 30, 3600);
    const code = String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
    await this.prisma.$transaction([
      this.prisma.emailOtp.updateMany({ where: { email, consumedAt: null }, data: { consumedAt: new Date() } }),
      this.prisma.emailOtp.create({ data: { email, codeHash: this.hash(email, code), expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60_000), requestIp: ip } }),
    ]);
    await this.mail.send(signInCodeMail(email, code, OTP_TTL_MINUTES));
  }

  /** Checks a code and uses it up. Throws a clear 400 when it is wrong, expired or out of tries. */
  async verify(email: string, code: string, ip: string | null): Promise<void> {
    if (ip) await this.limits.consume(`otp:verify:ip:${ip}`, 60, 3600);
    if (!new RegExp(`^\\d{${OTP_LENGTH}}$`).test(code)) throw new BadRequestException(`Enter the ${OTP_LENGTH}-digit code from the email.`);
    const otp = await this.prisma.emailOtp.findFirst({ where: { email, consumedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    if (!otp) throw new BadRequestException('This code has expired or was already used. Ask for a new one.');
    const expected = Buffer.from(otp.codeHash, 'hex');
    const given = Buffer.from(this.hash(email, code), 'hex');
    if (!timingSafeEqual(expected, given)) {
      const attempts = otp.attempts + 1;
      await this.prisma.emailOtp.update({ where: { id: otp.id }, data: { attempts, ...(attempts >= OTP_MAX_ATTEMPTS ? { consumedAt: new Date() } : {}) } });
      throw new BadRequestException(attempts >= OTP_MAX_ATTEMPTS ? 'Too many wrong codes. Ask for a new one.' : `That code is not right. ${OTP_MAX_ATTEMPTS - attempts} ${OTP_MAX_ATTEMPTS - attempts === 1 ? 'try' : 'tries'} left.`);
    }
    // Use it up atomically: two simultaneous requests with the same code cannot both succeed.
    const used = await this.prisma.emailOtp.updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (used.count !== 1) throw new BadRequestException('This code was already used. Ask for a new one.');
  }
}
