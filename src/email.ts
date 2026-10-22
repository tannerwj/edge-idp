import { html } from "hono/html";
import type { Env } from "./config";
import type { InstanceSettings } from "./settings-cache";

export interface MailContent {
  subject: string;
  heading: string;
  paragraphs: string[];
  button?: { label: string; url: string };
  footer?: string;
}

export type MailResult = { ok: true } | { ok: false; error: string };

export type EmailStatus = "ready" | "off" | "no-binding" | "no-sender";

export function emailStatus(env: Env, s: InstanceSettings): EmailStatus {
  if (!env.EMAIL) return "no-binding";
  if (!s.emailFrom) return "no-sender";
  return s.emailEnabled ? "ready" : "off";
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function mailHtml(rpName: string, content: MailContent, footer: string) {
  const paragraphs = content.paragraphs.map(
    (p) => html`<p style="margin:0 0 14px;font-size:15px;line-height:1.5">${p}</p>`,
  );
  const button = content.button
    ? html`<p style="margin:22px 0">
          <a
            href="${content.button.url}"
            style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600;font-size:15px"
            >${content.button.label}</a
          >
        </p>
        <p style="margin:0 0 14px;font-size:12px;color:#6e6e73;word-break:break-all">
          ${content.button.url}
        </p>`
    : "";
  return html`<!doctype html>
    <html>
      <body style="margin:0;padding:24px;background:#f5f5f7;font-family:${FONT};color:#1d1d1f">
        <table
          role="presentation"
          width="100%"
          style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px"
        >
          <tr>
            <td>
              <p style="margin:0 0 18px;font-size:13px;color:#6e6e73">${rpName}</p>
              <h1 style="margin:0 0 14px;font-size:20px;line-height:1.3">${content.heading}</h1>
              ${paragraphs} ${button}
              <p style="margin:22px 0 0;font-size:12px;color:#6e6e73">${footer}</p>
            </td>
          </tr>
        </table>
      </body>
    </html>`;
}

export async function renderMail(
  rpName: string,
  content: MailContent,
): Promise<{ html: string; text: string }> {
  const footer = content.footer ?? "If you didn't expect this email, you can ignore it.";
  const text = [
    content.heading,
    "",
    ...content.paragraphs.flatMap((p) => [p, ""]),
    ...(content.button ? [`${content.button.label}: ${content.button.url}`, ""] : []),
    footer,
    "",
    `— ${rpName}`,
  ].join("\n");
  return { html: String(await mailHtml(rpName, content, footer)), text };
}

export async function sendMail(
  env: Env,
  s: InstanceSettings,
  to: string,
  content: MailContent,
): Promise<MailResult> {
  if (!env.EMAIL || !s.emailFrom) return { ok: false, error: "Email isn't set up." };
  if (!s.emailEnabled) return { ok: false, error: "Email is turned off in Settings." };
  const body = await renderMail(env.RP_NAME, content);
  try {
    await env.EMAIL.send({
      to,
      from: { email: s.emailFrom, name: s.emailFromName || env.RP_NAME },
      subject: content.subject,
      html: body.html,
      text: body.text,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
