/**
 * Email sending via Cloudflare Email Workers binding.
 *
 * Requirements:
 *  - Email Routing must be enabled on your Cloudflare zone.
 *  - The FROM_EMAIL address must belong to a domain with Email Routing active.
 *  - The send_email binding ("EMAIL") must be declared in wrangler.toml.
 *
 * Docs: https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/
 */

export async function sendVerificationEmail(
  emailBinding: SendEmail,
  opts: {
    to: string;
    from: string;
    verifyUrl: string;
    instanceTitle: string;
  }
): Promise<void> {
  const { to, from, verifyUrl, instanceTitle } = opts;

  await emailBinding.send({
    from,
    to,
    subject: `Verify your ${instanceTitle} account`,
    text: [
      `Welcome to ${instanceTitle}!`,
      ``,
      `Please verify your email address by clicking the link below:`,
      ``,
      verifyUrl,
      ``,
      `This link expires in 24 hours.`,
      ``,
      `If you did not create an account, you can safely ignore this email.`,
    ].join("\n"),
  });
}

export async function sendPasswordResetEmail(
  emailBinding: SendEmail,
  opts: {
    to: string;
    from: string;
    resetUrl: string;
    instanceTitle: string;
  }
): Promise<void> {
  const { to, from, resetUrl, instanceTitle } = opts;

  await emailBinding.send({
    from,
    to,
    subject: `Reset your ${instanceTitle} password`,
    text: [
      `We received a request to reset your ${instanceTitle} password.`,
      ``,
      `Click the link below to set a new password:`,
      ``,
      resetUrl,
      ``,
      `This link expires in 1 hour.`,
      ``,
      `If you did not request this, you can safely ignore this email.`,
    ].join("\n"),
  });
}

export async function sendWelcomeEmail(
  emailBinding: SendEmail,
  opts: {
    to: string;
    from: string;
    username: string;
    instanceTitle: string;
    instanceUrl: string;
  }
): Promise<void> {
  const { to, from, username, instanceTitle, instanceUrl } = opts;

  await emailBinding.send({
    from,
    to,
    subject: `Welcome to ${instanceTitle}!`,
    text: [
      `Hi ${username},`,
      ``,
      `Your account on ${instanceTitle} is now active. You can sign in at:`,
      ``,
      instanceUrl + "/login",
      ``,
      `Thanks for joining the open social web!`,
    ].join("\n"),
  });
}
