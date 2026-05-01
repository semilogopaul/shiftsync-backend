/**
 * Shared HTML scaffolding for all transactional emails.
 * Keeps a consistent ShiftSync look (purple theme matching the frontend).
 *
 * Logo: hosted on GitHub so email clients can fetch it without a deployed server.
 * Uses the grey logo (dark text + purple icon) which renders correctly on the
 * light (#f6f4f9) email background.
 */

interface BaseLayoutInput {
  readonly title: string;
  readonly preview: string;
  readonly bodyHtml: string;
  readonly cta?: { readonly label: string; readonly url: string };
  readonly footerNote?: string;
}

const BRAND_COLOR = '#9900ec';
const BG = '#f6f4f9';
const CARD_BG = '#ffffff';
const TEXT = '#1a1a1f';
const MUTED = '#6b6877';
const LOGO_URL =
  'https://raw.githubusercontent.com/semilogopaul/shiftsync-frontend/main/public/logo/shiftsync-grey-logo.png';

export function baseLayout(input: BaseLayoutInput): string {
  const { title, preview, bodyHtml, cta, footerNote } = input;
  const ctaHtml = cta
    ? `
      <table role="presentation" cellspacing="0" cellpadding="0" style="margin:32px 0;">
        <tr>
          <td style="border-radius:8px;background:${BRAND_COLOR};">
            <a href="${escapeAttr(cta.url)}"
               style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
              ${escapeHtml(cta.label)}
            </a>
          </td>
        </tr>
      </table>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT};">
<span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;">${escapeHtml(preview)}</span>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${BG};padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:${CARD_BG};border-radius:12px;padding:40px 36px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <tr>
          <td>
            <div style="margin-bottom:24px;text-align:center;">
              <img src="${LOGO_URL}" alt="ShiftSync" width="148" height="auto" style="display:inline-block;border:0;outline:none;text-decoration:none;max-width:148px;margin-left:-16px;" />
            </div>
            <h1 style="font-size:22px;font-weight:600;margin:0 0 20px;color:${TEXT};letter-spacing:-0.01em;text-align:center;">${escapeHtml(title)}</h1>
            <div style="font-size:15px;line-height:1.6;color:${TEXT};">
              ${bodyHtml}
            </div>
            ${ctaHtml}
            ${footerNote ? `<p style="font-size:13px;color:${MUTED};margin-top:24px;">${escapeHtml(footerNote)}</p>` : ''}
          </td>
        </tr>
      </table>
      <p style="font-size:12px;color:${MUTED};margin-top:24px;">© ${new Date().getFullYear()} ShiftSync · Coastal Eats</p>
    </td>
  </tr>
</table>
</body>
</html>`;
}

export function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function escapeAttr(input: string): string {
  return escapeHtml(input);
}
