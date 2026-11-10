// Fixed, user-facing text for every clause library outcome. Pages and actions pass only these codes around (in the URL
// or in a result); no message text from a URL, a request or an exception is ever rendered.

export const ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  unauthenticated: "Sign in again.",
  forbidden: "You don't have permission to do that.",
  self_approval: "You can't approve text you wrote. Another owner or admin has to approve it.",
  not_found: "That clause or version doesn't exist in this workspace.",
  bad_transition: "That version can't be moved to that state.",
  open_version: "Finish, submit or send back the open version first.",
  immutable: "That version can't be changed any more.",
  exists: "A clause with that id already exists. Try again.",
  superseded: "A later version has been approved, so this one can't be used.",
  not_approved: "Only an approved version can be used.",
  invalid_body: "The clause text isn't valid.",
  invalid_params: "One of the values isn't valid.",
  bad_id: "That clause id isn't valid.",
  bad_kind: "Choose a kind.",
  bad_title: "Give the clause a title.",
  bad_text: "Titles and notes must be short plain text, without markup or hidden characters.",
  bad_source: "Choose where the text comes from. A reference looks like TPL-2026.",
  bad_actor: "Sign in again.",
  bad_record: "That request wasn't valid.",
  throttled: "Too many clauses were written in this workspace in the last minute. Wait a minute and try again.",
  failed: "That didn't work. Try again.",
});

export const ISSUE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  unsafe_html: "It contains markup or an HTML tag.",
  unsafe_markdown: "It contains a markdown link or image.",
  unsafe_script_url: "It contains a script or data URL.",
  unsafe_template: "It contains template syntax such as ${ } or {% %}.",
  unsafe_control: "It contains a control character.",
  unsafe_bidi: "It contains an invisible or text-direction character.",
  unsafe_marks: "It contains stacked or overlaid accent marks.",
  unsafe_escape: "It contains an encoded character (such as &lt; or %3C).",
  unsafe_char: "It contains an unusual space or symbol.",
  unsafe_mixed_script: "A word mixes Latin letters with look-alike letters from another script.",
  unsafe_adjacent: "A placeholder sits directly against <, &, $ or %.",
  bad_placeholder: "A placeholder is malformed. Use {{name}} or {{name:type}}.",
  bad_type: "A placeholder has an unknown type. Use text, multiline, int, money or date.",
  type_conflict: "The same placeholder is used with two different types.",
  stray_braces: "There is a stray, nested or unbalanced brace.",
  empty_body: "The clause text is empty.",
  body_too_long: "The clause text is longer than 20,000 characters.",
  bad_param: "A value is not valid for its type (for example a whole number above zero, an amount, a date, or a single line).",
  missing_param: "A value is missing.",
  unknown_param: "A value was given for a placeholder the clause doesn't have.",
  placeholder_syntax: "Placeholder syntax {{ }} can't appear in a value.",
});

/** The code-only part of a failure, safe to put in a URL. */
export function failureCodes(r: { code: string; issues?: { code: string }[] }): { error: string; issue?: string } {
  const error = Object.hasOwn(ERROR_TEXT, r.code) ? r.code : "failed";
  const first = r.issues?.find((i) => Object.hasOwn(ISSUE_TEXT, i.code))?.code;
  return first ? { error, issue: first } : { error };
}

/** Fixed text for codes read back from a URL or a result. Unknown codes give the generic message. */
export function failureText(error: string | undefined, issue?: string | undefined): string {
  const base = error && Object.hasOwn(ERROR_TEXT, error) ? ERROR_TEXT[error] : ERROR_TEXT.failed;
  return issue && Object.hasOwn(ISSUE_TEXT, issue) ? `${base} ${ISSUE_TEXT[issue]}` : base;
}
