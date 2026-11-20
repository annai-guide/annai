/**
 * Where a bare address in chat ends, in Japanese and Chinese text: these marks end it wherever they stand, not only last. Such text has no space after a
 * stop, so `…/清水寺。次は八坂神社` would link the whole run, and a `、` list or a （…） or 「…」 around an address would take the mark into the link.
 * Read by chat's renderer (src/ui/markdown.js, where a bare address ends) and by `pageUrl` (src/core/wiki.js, which encodes them in a title, as UTF-8
 * bytes, so a title that holds one still links whole). Each is something a reply writes straight against an address and a title rarely holds:
 *   。 U+3002  a sentence's end (a title can end in it: モーニング娘。)
 *   、 U+3001  the comma between the addresses of a Japanese list (a title can end in it: 藤岡弘、)
 *   ， U+FF0C  the Chinese comma
 *   ； U+FF1B  the Chinese semicolon between the addresses of a list
 *   ！ U+FF01  a sentence's end
 *   ？ U+FF1F  a sentence's end
 *   （ U+FF08  a note straight after an address, （英語版）; the twin of the ASCII ( that ends an address too
 *   ） U+FF09  closes the （…） an address is written in
 *   」 U+300D  closes the 「…」 an address is written in
 *   』 U+300F  closes the 『…』 an address is written in
 * Left out on purpose: ・ U+30FB and · U+00B7 (titles of foreign names hold them), ー (the long vowel), the dashes, ’, ： (subtitles), 【 】, 〜 and … (titles hold
 * them), 「 『 (they open before an address, not after it). ASCII `.,;:!?'"` end an address only last (the renderer), as English titles hold them inside.
 */
export const ADDRESS_ENDS = '。、，；！？（）」』';
