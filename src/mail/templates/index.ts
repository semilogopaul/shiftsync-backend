import { baseLayout, escapeHtml } from './base-layout';

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
}

export interface NameContext {
  readonly firstName: string;
}

export function welcomeEmail(ctx: NameContext & { verifyUrl: string }): RenderedEmail {
  return {
    subject: 'Welcome to ShiftSync',
    html: baseLayout({
      title: `Welcome, ${ctx.firstName}`,
      preview: 'Get started by verifying your email address.',
      bodyHtml: `<p>Your ShiftSync account is ready. Verify your email to activate your access and start picking up shifts.</p>`,

      cta: { label: 'Verify email', url: ctx.verifyUrl },
      footerNote: "If you didn't expect this email, you can safely ignore it.",
    }),
  };
}

export function emailVerificationEmail(ctx: NameContext & { verifyUrl: string }): RenderedEmail {
  return {
    subject: 'Verify your ShiftSync email',
    html: baseLayout({
      title: 'Verify your email',
      preview: 'Confirm your email to finish setting up ShiftSync.',
      bodyHtml: `<p>Hi ${escapeHtml(ctx.firstName)} — please confirm your email to activate your account.</p>`,
      cta: { label: 'Verify email', url: ctx.verifyUrl },
    }),
  };
}

export function emailVerifiedEmail(ctx: NameContext): RenderedEmail {
  return {
    subject: 'Your email is verified',
    html: baseLayout({
      title: 'Email verified',
      preview: 'Your ShiftSync email has been verified.',
      bodyHtml: `<p>Thanks ${escapeHtml(ctx.firstName)} — your email is verified and your account is fully active.</p>`,
    }),
  };
}

export function passwordResetRequestEmail(ctx: NameContext & { resetUrl: string; ipAddress?: string }): RenderedEmail {
  const ipNote = ctx.ipAddress ? `Request originated from ${escapeHtml(ctx.ipAddress)}.` : undefined;
  return {
    subject: 'Reset your ShiftSync password',
    html: baseLayout({
      title: 'Reset your password',
      preview: 'Use the link below to choose a new password.',
      bodyHtml: `
        <p>Hi ${escapeHtml(ctx.firstName)} — a password reset was requested for your account. The link below expires in 1 hour and can only be used once.</p>
        <p>If you didn't request this, you can ignore this email — your password will not change.</p>`,
      cta: { label: 'Choose a new password', url: ctx.resetUrl },
      footerNote: ipNote,
    }),
  };
}

export function passwordChangedEmail(ctx: NameContext & { ipAddress?: string }): RenderedEmail {
  return {
    subject: 'Your ShiftSync password was changed',
    html: baseLayout({
      title: 'Password changed',
      preview: 'Your account password was updated.',
      bodyHtml: `
        <p>Hi ${escapeHtml(ctx.firstName)} — your ShiftSync password was just changed${ctx.ipAddress ? ` from ${escapeHtml(ctx.ipAddress)}` : ''}.</p>
        <p>If this wasn't you, reset your password immediately and contact your administrator.</p>`,
    }),
  };
}

export function shiftAssignedEmail(ctx: NameContext & {
  locationName: string;
  whenLocal: string;
  skillName: string;
  shiftUrl: string;
}): RenderedEmail {
  return {
    subject: `New shift: ${ctx.skillName} at ${ctx.locationName}`,
    html: baseLayout({
      title: 'You picked up a new shift',
      preview: `${ctx.skillName} at ${ctx.locationName} — ${ctx.whenLocal}`,
      bodyHtml: `
        <p>Hi ${escapeHtml(ctx.firstName)},</p>
        <p>You've been assigned a shift:</p>
        <p style="margin:16px 0;padding:12px 16px;background:#f6f4f9;border-radius:8px;">
          <strong>${escapeHtml(ctx.skillName)}</strong> at <strong>${escapeHtml(ctx.locationName)}</strong><br/>
          ${escapeHtml(ctx.whenLocal)}
        </p>`,
      cta: { label: 'View shift', url: ctx.shiftUrl },
    }),
  };
}

export function shiftChangedEmail(ctx: NameContext & {
  locationName: string;
  whenLocal: string;
  changeSummary: string;
  shiftUrl: string;
}): RenderedEmail {
  return {
    subject: `Shift updated at ${ctx.locationName}`,
    html: baseLayout({
      title: 'Your shift was updated',
      preview: ctx.changeSummary,
      bodyHtml: `
        <p>Hi ${escapeHtml(ctx.firstName)},</p>
        <p>${escapeHtml(ctx.changeSummary)}</p>
        <p>New details:</p>
        <p style="margin:16px 0;padding:12px 16px;background:#f6f4f9;border-radius:8px;">
          ${escapeHtml(ctx.locationName)}<br/>${escapeHtml(ctx.whenLocal)}
        </p>`,
      cta: { label: 'View shift', url: ctx.shiftUrl },
    }),
  };
}

export function shiftCancelledEmail(ctx: NameContext & {
  locationName: string;
  whenLocal: string;
}): RenderedEmail {
  return {
    subject: `Shift cancelled at ${ctx.locationName}`,
    html: baseLayout({
      title: 'Your shift was cancelled',
      preview: `Shift at ${ctx.locationName} on ${ctx.whenLocal} was cancelled.`,
      bodyHtml: `
        <p>Hi ${escapeHtml(ctx.firstName)},</p>
        <p>Your shift at <strong>${escapeHtml(ctx.locationName)}</strong> on ${escapeHtml(ctx.whenLocal)} has been cancelled. No action needed.</p>`,
    }),
  };
}

export function schedulePublishedEmail(ctx: NameContext & {
  weekLabel: string;
  shiftCount: number;
  scheduleUrl: string;
}): RenderedEmail {
  return {
    subject: `Your schedule for ${ctx.weekLabel} is live`,
    html: baseLayout({
      title: 'Your schedule is published',
      preview: `${ctx.shiftCount} shift${ctx.shiftCount === 1 ? '' : 's'} for ${ctx.weekLabel}.`,
      bodyHtml: `
        <p>Hi ${escapeHtml(ctx.firstName)},</p>
        <p>Your schedule for <strong>${escapeHtml(ctx.weekLabel)}</strong> has been published. You have ${ctx.shiftCount} shift${ctx.shiftCount === 1 ? '' : 's'} this week.</p>`,
      cta: { label: 'View schedule', url: ctx.scheduleUrl },
    }),
  };
}

export function swapRequestedEmail(ctx: NameContext & {
  fromName: string;
  whenLocal: string;
  locationName: string;
  swapUrl: string;
}): RenderedEmail {
  return {
    subject: `${ctx.fromName} wants to swap a shift with you`,
    html: baseLayout({
      title: 'Swap request',
      preview: `${ctx.fromName} requested a shift swap.`,
      bodyHtml: `
        <p>Hi ${escapeHtml(ctx.firstName)},</p>
        <p><strong>${escapeHtml(ctx.fromName)}</strong> would like to swap their shift at <strong>${escapeHtml(ctx.locationName)}</strong> on ${escapeHtml(ctx.whenLocal)} with you.</p>`,
      cta: { label: 'Review request', url: ctx.swapUrl },
    }),
  };
}

export function swapDecisionEmail(ctx: NameContext & {
  approved: boolean;
  locationName: string;
  whenLocal: string;
  shiftUrl: string;
}): RenderedEmail {
  const verb = ctx.approved ? 'approved' : 'rejected';
  return {
    subject: `Your shift swap was ${verb}`,
    html: baseLayout({
      title: `Swap ${verb}`,
      preview: `Your swap request was ${verb}.`,
      bodyHtml: `
        <p>Hi ${escapeHtml(ctx.firstName)},</p>
        <p>Your swap request for <strong>${escapeHtml(ctx.locationName)}</strong> on ${escapeHtml(ctx.whenLocal)} has been <strong>${verb}</strong>.</p>`,
      cta: { label: 'View shift', url: ctx.shiftUrl },
    }),
  };
}

export function dropRequestedEmail(ctx: NameContext & {
  fromName: string;
  locationName: string;
  whenLocal: string;
  reviewUrl: string;
}): RenderedEmail {
  return {
    subject: `Drop request from ${ctx.fromName}`,
    html: baseLayout({
      title: 'Drop request awaiting review',
      preview: `${ctx.fromName} dropped a shift.`,
      bodyHtml: `
        <p>Hi ${escapeHtml(ctx.firstName)},</p>
        <p><strong>${escapeHtml(ctx.fromName)}</strong> has dropped their shift at <strong>${escapeHtml(ctx.locationName)}</strong> on ${escapeHtml(ctx.whenLocal)}. It is now available for qualified staff to claim.</p>`,
      cta: { label: 'Review', url: ctx.reviewUrl },
    }),
  };
}

export function overtimeWarningEmail(ctx: NameContext & {
  weekLabel: string;
  projectedHours: number;
  scheduleUrl: string;
}): RenderedEmail {
  return {
    subject: `Overtime warning — ${ctx.weekLabel}`,
    html: baseLayout({
      title: 'Overtime warning',
      preview: `Projected ${ctx.projectedHours.toFixed(1)} hours this week.`,
      bodyHtml: `
        <p>Hi ${escapeHtml(ctx.firstName)},</p>
        <p>You're projected to work <strong>${ctx.projectedHours.toFixed(1)} hours</strong> in ${escapeHtml(ctx.weekLabel)}, which is approaching or exceeding the standard limit.</p>`,
      cta: { label: 'Review your schedule', url: ctx.scheduleUrl },
    }),
  };
}
