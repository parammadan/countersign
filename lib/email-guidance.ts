// What we tell people about email delivery, in one place so every screen says the same thing. The mail server
// accepting a message ("sent") is not the same as it reaching the inbox: never claim inbox delivery.
export const EMAIL_HELP = {
  verify: "Check your inbox for a verification link. If you don't see it in a few minutes, check Spam or Junk and mark it as Not spam.",
  client: "Your client may need to check their Spam or Junk folder for the signing invitation.",
  otp: "The code can take a minute to arrive. If you don't see it, check Spam or Junk.",
  /** label for emails.status = "sent" */
  sent: "Sent (accepted by the mail server)",
  sentExplain: "The mail server accepted it. That doesn't guarantee it reached the inbox: it may be in Spam or Junk.",
  resend: "Resend link",
  /** on screens below the confirm-your-email banner, which holds the Resend link button */
  resendAbove: "Need a new one? Use Resend link at the top of the page.",
  resent: (email: string) => `New link sent to ${email}. If you don't see it in a few minutes, check Spam or Junk.`,
  alreadyVerified: "Your email is already confirmed.",
  tooSoon: "We just sent a link. Wait a minute before asking for another.",
  tooMany: "You've asked for several links this hour. Try again later, and check Spam or Junk for the ones already sent.",
} as const;

/** Email kinds that go to the client about signing (the ones the client spam hint applies to). */
export const CLIENT_INVITE_KINDS: readonly string[] = ["invite", "resend", "reminder"];
