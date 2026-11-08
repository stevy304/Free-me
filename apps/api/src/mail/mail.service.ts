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
      ? nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, connectionTimeout: 15_000, socketTimeout: 60_000, auth: s.user ? { user: s.user, pass: s.pass } : undefined })
      : null;
  }

  async send(mail: OutgoingMail): Promise<void> {
    if (this.config.mail.transport === 'memory') { this.outbox.push(mail); return; }
    if (this.config.mail.transport === 'console') { this.log.log(`[development mail] to ${mail.to}: ${mail.subject}\n${mail.text}`); return; }
    await this.transporter!.sendMail({ from: this.config.mail.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function brandedMail(title: string, preview: string, content: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#eef4f1;font-family:Arial,Helvetica,sans-serif;color:#102620">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #d9e5de;border-radius:20px">
<tr><td style="background:#102620;color:#a6f3bd;border-radius:20px 20px 0 0;padding:22px 28px;font-size:23px;font-weight:700">Free Me</td></tr>
<tr><td style="padding:28px"><h1 style="margin:0 0 16px;font-size:25px;line-height:32px;color:#102620">${esc(title)}</h1>${content}</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #d9e5de;color:#40594e;font-size:13px;line-height:20px">Free Me · Account and activity updates</td></tr>
</table></td></tr></table></body></html>`;
}

export function signInCodeMail(to: string, code: string, minutes: number): OutgoingMail {
  const help = `It expires in ${minutes} minutes and works once. If you did not try to sign in, you can ignore this email; nobody can sign in without the code.`;
  const text = `Your Free Me sign-in code is ${code}\n\n${help}`;
  const html = brandedMail('Your sign-in code', 'Use this one-time code to sign in to Free Me.',
    `<p style="margin:0 0 16px;padding:14px;background:#eaf7ee;border-radius:12px;font-size:32px;font-weight:700;letter-spacing:6px;text-align:center">${esc(code)}</p><p style="margin:0;font-size:15px;line-height:23px">${esc(help)}</p>`);
  return { to, subject: `${code} is your Free Me sign-in code`, text, html };
}

export function noticeMail(to: string, subject: string, paragraphs: string[], action?: { label: string; url: string }): OutgoingMail {
  const safeAction = action && /^https?:\/\//i.test(action.url) ? action : undefined;
  const text = [...paragraphs, ...(safeAction ? [`${safeAction.label}: ${safeAction.url}`] : [])].join('\n\n');
  const content = paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:23px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const button = safeAction ? `<a href="${esc(safeAction.url)}" style="display:inline-block;margin-top:8px;background:#145b39;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">${esc(safeAction.label)}</a>` : '';
  return { to, subject, text, html: brandedMail(subject, 'An update from Free Me.', content + button) };
}
