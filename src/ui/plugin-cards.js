/**
 * The card when a running plugin is switched off after repeated errors (spec §5.5). A system card,
 * never in Shiori's voice; the message has any key annai keeps blanked before it gets here.
 * @param {{ name: string, reason: string, message: string }} d
 */
export function disabledCard({ name, reason, message }) {
  return {
    tone: /** @type {const} */ ('warn'),
    title: `The plugin "${name}" was turned off`,
    body: `It ${reason}. The last error: ${message} You can turn it back on in Settings → Plugins.`,
  };
}
