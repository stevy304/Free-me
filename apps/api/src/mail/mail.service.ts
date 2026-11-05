import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../config/config';

export interface OutgoingMail { to: string; subject: string; text: string; html: string }

/**
 * Sends email. SMTP in production; in development "console" prints the message (and the sign-in code) to the API
 * log; tests use "memory" and read `outbox`. Production refuses anything but SMTP (see config).
 */
@Injectable()
export class MailService {
  private readonly log = new Logger('Mail');
  private readonly transporter: Transporter | null;
  /** Messages sent with the memory transport (tests). */
  readonly outbox: OutgoingMail[] = [];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const s = config.mail.smtp;
    this.transporter = config.mail.transport === 'smtp' && s
      ? nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: s.user ? { user: s.user, pass: s.pass } : undefined })
      : null;
  }

  async send(mail: OutgoingMail): Promise<void> {
    if (this.config.mail.transport === 'memory') { this.outbox.push(mail); return; }
    if (this.config.mail.transport === 'console') { this.log.log(`[development mail] to ${mail.to}: ${mail.subject}\n${mail.text}`); return; }
    await this.transporter!.sendMail({ from: this.config.mail.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The sign-in code email: the code first, how long it lasts, and what to do if it was not you. */
export function signInCodeMail(to: string, code: string, minutes: number): OutgoingMail {
  const text = `Your Free Me sign-in code is ${code}\n\nIt expires in ${minutes} minutes and works once. If you did not try to sign in, you can ignore this email; nobody can sign in without the code.`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#fff;border-radius:16px;padding:32px">
<tr><td style="font-size:18px;font-weight:700;color:#0c827e">Free Me</td></tr>
<tr><td style="padding-top:20px;font-size:15px">Your sign-in code:</td></tr>
<tr><td style="padding:12px 0 4px;font-size:34px;font-weight:700;letter-spacing:8px">${esc(code)}</td></tr>
<tr><td style="font-size:13px;color:#52525b;padding-top:8px">It expires in ${minutes} minutes and works once. If you did not try to sign in, ignore this email: nobody can sign in without the code.</td></tr>
</table></td></tr></table></body></html>`;
  return { to, subject: `${code} is your Free Me sign-in code`, text, html };
}

/** A plain notice (moderation decisions, copyright notices): short paragraphs and an optional button. */
export function noticeMail(to: string, subject: string, paragraphs: string[], action?: { label: string; url: string }): OutgoingMail {
  const text = [...paragraphs, ...(action ? [`${action.label}: ${action.url}`] : [])].join('\n\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;padding:32px">
<tr><td style="font-size:18px;font-weight:700;color:#0c827e;padding-bottom:12px">Free Me</td></tr>
${paragraphs.map((p) => `<tr><td style="font-size:14px;line-height:21px;padding-top:10px;white-space:pre-line">${esc(p)}</td></tr>`).join('\n')}
${action ? `<tr><td style="padding-top:22px"><a href="${esc(action.url)}" style="display:inline-block;background:#0c827e;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 20px;border-radius:999px">${esc(action.label)}</a></td></tr>` : ''}
</table></td></tr></table></body></html>`;
  return { to, subject, text, html };
}
