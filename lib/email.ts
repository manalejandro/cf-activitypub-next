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

/** Operational notice for the instance admins (bot sweeps, waves…). */
export async function sendAdminAlertEmail(
  emailBinding: SendEmail,
  opts: { to: string; from: string; subject: string; lines: string[] }
): Promise<void> {
  const { to, from, subject, lines } = opts;
  await emailBinding.send({ from, to, subject, text: lines.join("\n") });
}

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

export async function sendReportOutcomeEmail(
  emailBinding: SendEmail,
  opts: {
    to: string;
    from: string;
    reporterUsername: string;
    targetUsername: string;
    action: string;
    reason: string;
    instanceTitle: string;
  }
): Promise<void> {
  const { to, from, reporterUsername, targetUsername, action, reason, instanceTitle } = opts;

  const actionLabelsEn: Record<string, string> = {
    dismiss: "No action was taken",
    warn: "A warning was issued",
    delete: "The post was deleted",
    suspend: "The account was suspended",
  };

  const actionLabelsEs: Record<string, string> = {
    dismiss: "No se ha tomado ninguna acción",
    warn: "Se ha emitido una advertencia",
    delete: "Se ha eliminado la publicación",
    suspend: "Se ha suspendido la cuenta",
  };

  await emailBinding.send({
    from,
    to,
    subject: `[${instanceTitle}] Reporte procesado / Report processed`,
    text: [
      `English:`,
      ``,
      `Hi ${reporterUsername},`,
      `The report you filed against @${targetUsername} has been processed.`,
      `Action taken: ${actionLabelsEn[action] ?? action}`,
      `Reason: ${reason}`,
      `Thank you for helping keep ${instanceTitle} safe.`,
      ``,
      `Español:`,
      ``,
      `Hola ${reporterUsername},`,
      `El reporte que enviaste contra @${targetUsername} ha sido procesado.`,
      `Acción tomada: ${actionLabelsEs[action] ?? action}`,
      `Motivo: ${reason}`,
      `Gracias por ayudar a mantener ${instanceTitle} seguro.`,
      ``,
      `— ${instanceTitle}`,
    ].join("\n"),
  });
}

/**
 * Notification email sent to an account owner when the Guardian takes a
 * moderation action on their account or content (warning, deletion, suspension).
 * Used only when the account has an email on file.
 */
export type ModerationNoticeAction =
  | "warned"
  | "deleted"
  | "suspended"
  | "rejected"
  | "silenced"
  | "reported"
  | "removed";

export async function sendModerationNoticeEmail(
  emailBinding: SendEmail,
  opts: {
    to: string;
    from: string;
    username: string;
    action: ModerationNoticeAction;
    reason: string;
    instanceTitle: string;
    instanceUrl: string;
  }
): Promise<void> {
  const { to, from, username, action, reason, instanceTitle, instanceUrl } = opts;

  const subjects: Record<string, string> = {
    warned: `[${instanceTitle}] Aviso de moderación / Moderation notice`,
    deleted: `[${instanceTitle}] Publicación eliminada / Post deleted`,
    suspended: `[${instanceTitle}] Cuenta suspendida / Account suspended`,
    rejected: `[${instanceTitle}] Registro rechazado / Registration rejected`,
    silenced: `[${instanceTitle}] Cuenta limitada / Account limited`,
    reported: `[${instanceTitle}] Reporte recibido / Report received`,
    removed: `[${instanceTitle}] Cuenta eliminada / Account removed`,
  };

  const en: Record<string, string[]> = {
    warned: [
      `Hello @${username},`,
      `A moderation warning has been issued on your ${instanceTitle} account.`,
    ],
    deleted: [
      `Hello @${username},`,
      `One of your posts on ${instanceTitle} has been removed for violating the community guidelines.`,
    ],
    suspended: [
      `Hello @${username},`,
      `Your account on ${instanceTitle} has been suspended for violating the community guidelines.`,
    ],
    rejected: [
      `Hello,`,
      `Your registration request for ${instanceTitle} has not been approved.`,
    ],
    silenced: [
      `Hello @${username},`,
      `Your account on ${instanceTitle} has been limited: its posts will not appear in public timelines or search while the limitation is active. You can still sign in and use your account.`,
    ],
    reported: [
      `Hello @${username},`,
      `A report has been filed against your account on ${instanceTitle}. The administration will review it before taking any action.`,
    ],
    removed: [
      `Hello @${username},`,
      `Your account on ${instanceTitle} has been removed by the administration.`,
    ],
  };

  const es: Record<string, string[]> = {
    warned: [
      `Hola @${username},`,
      `Se ha emitido un aviso de moderación sobre tu cuenta en ${instanceTitle}.`,
    ],
    deleted: [
      `Hola @${username},`,
      `Una de tus publicaciones en ${instanceTitle} ha sido eliminada por infringir las normas de la comunidad.`,
    ],
    suspended: [
      `Hola @${username},`,
      `Tu cuenta en ${instanceTitle} ha sido suspendida por infringir las normas de la comunidad.`,
    ],
    rejected: [
      `Hola,`,
      `Tu solicitud de registro en ${instanceTitle} no ha sido aprobada.`,
    ],
    silenced: [
      `Hola @${username},`,
      `Tu cuenta en ${instanceTitle} ha sido limitada: sus publicaciones no aparecerán en los timelines públicos ni en las búsquedas mientras la limitación esté activa. Puedes seguir iniciando sesión y usando tu cuenta.`,
    ],
    reported: [
      `Hola @${username},`,
      `Se ha presentado un reporte contra tu cuenta en ${instanceTitle}. La administración lo revisará antes de tomar cualquier medida.`,
    ],
    removed: [
      `Hola @${username},`,
      `Tu cuenta en ${instanceTitle} ha sido eliminada por la administración.`,
    ],
  };

  await emailBinding.send({
    from,
    to,
    subject: subjects[action],
    text: [
      `English:`,
      ``,
      ...(en[action] ?? []),
      `Reason: ${reason}`,
      `If you believe this is a mistake, you can contact the administrators at ${instanceUrl}.`,
      ``,
      `Español:`,
      ``,
      ...(es[action] ?? []),
      `Motivo: ${reason}`,
      `Si crees que se trata de un error, puedes contactar con la administración en ${instanceUrl}.`,
      ``,
      `— ${instanceTitle}`,
    ].join("\n"),
  });
}
