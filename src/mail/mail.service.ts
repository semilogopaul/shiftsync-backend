import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { RenderedEmail } from './templates';

export interface SendMailOptions {
  to: string | string[];
  subject: string;
  html: string;
  /** Override the default from address for this specific email */
  from?: string;
}

@Injectable()
export class MailService {
  private readonly resend: Resend;
  private readonly from: string;
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService) {
    this.resend = new Resend(this.config.getOrThrow<string>('RESEND_API_KEY'));
    this.from = this.config.getOrThrow<string>('MAIL_FROM');
  }

  /**
   * Awaits delivery — use only for transactional emails where confirmation
   * matters (password reset, email verification). Throws on Resend error.
   */
  async send(options: SendMailOptions): Promise<void> {
    const { to, subject, html, from } = options;

    try {
      const { error } = await this.resend.emails.send({
        from: from ?? this.from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
      });

      if (error) {
        this.logger.error(`send: Resend rejected — to=${JSON.stringify(to)} subject="${subject}" err=${error.message}`);
        throw new Error('Email delivery failed');
      }

      this.logger.log(`send: ok — subject="${subject}" to=${JSON.stringify(to)}`);
    } catch (err) {
      this.logger.error(`send: exception — to=${JSON.stringify(to)} err=${(err as Error).message}`);
      throw new Error('Email delivery failed');
    }
  }

  /**
   * Render-and-send convenience using a typed template result. Awaits delivery.
   */
  async sendTemplate(to: string | string[], rendered: RenderedEmail): Promise<void> {
    await this.send({ to, subject: rendered.subject, html: rendered.html });
  }

  /**
   * Fire-and-forget. Use for non-critical emails (notifications, welcome).
   * Never throws. Errors are logged with full context but do not propagate.
   */
  sendAndForget(to: string | string[], rendered: RenderedEmail): void {
    void this.sendTemplate(to, rendered).catch((err: unknown) => {
      this.logger.error(
        `sendAndForget: drop on the floor — to=${JSON.stringify(to)} subject="${rendered.subject}" err=${(err as Error).message}`,
      );
    });
  }
}
